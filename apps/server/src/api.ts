import {
  CHAT_DATA_PARTS,
  generateRequestSchema,
  MAX_CHAT_BODY_BYTES,
  type modelsResponseSchema,
  type PromptUsage,
  previewRequestSchema,
  type previewResponseSchema,
  type RefusalCode,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from "ai";
import { Hono } from "hono";
import type { ApplyGlobalResponse } from "hono/client";
import type { z } from "zod";
import { createCastApi } from "./cast.ts";
import { createCatalog, type UpstreamFetch } from "./catalog.ts";
import { createCharactersApi } from "./characters.ts";
import { type ComfySocketFactory, createComfyui } from "./comfyui/client.ts";
import type { WorkflowRegistry } from "./comfyui/workflow.ts";
import type { AppConfig } from "./config.ts";
import { ART_TIMEOUT_MS, createCreatorApi } from "./creator.ts";
import { createEventsApi } from "./events.ts";
import { calibrate, createGeneration, type EntryDigest } from "./generation.ts";
import { KEEPALIVE_INTERVAL_MS, withKeepalive } from "./keepalive.ts";
import { boundedBody, requestLifetime } from "./lifetime.ts";
import type { Logger } from "./log.ts";
import { createLorebooksApi } from "./lorebooks.ts";
import { createMemoryApi } from "./memory.ts";
import { createPalettesApi } from "./palettes.ts";
import { MOUNTS } from "./paths.ts";
import { createPersonasApi } from "./personas.ts";
import { createPresetsApi } from "./presets.ts";
import { invalid, type RefusalStatuses, refusedBeforeCall } from "./routes.ts";
import { createSceneApi } from "./scene.ts";
import { createSettingsApi } from "./settings.ts";
import { markStreaming } from "./streams.ts";
import { createUpstream, streamFailure, streamLogging } from "./upstream.ts";
import { callRecorder, reportedUsage } from "./usage.ts";
import type { UserEnv } from "./user.ts";

export type { PortraitSize } from "./persistence/store.ts";
export type { PortraitKind } from "./routes.ts";

/** The status of each reason a prompt could not be built. */
const PROMPT_REFUSAL_STATUSES = {
  context_window_unknown: 409,
  prompt_too_long: 422,
} as const satisfies RefusalStatuses<RefusalCode>;

/** The process's orderly stop (index.ts). */
interface Shutdown {
  /** Aborted on SIGTERM or SIGINT: creator runs end and their ComfyUI cleanup starts. */
  signal: AbortSignal;
  /** Registers cleanup the process waits for, on a deadline, before it exits. */
  drain: (settled: () => Promise<void>) => void;
}

export interface ApiDeps {
  log: Logger;
  fetch: UpstreamFetch;
  /** Lifts the runtime's idle timeout for a long-lived stream (Bun: `server.timeout(req, 0)`). */
  onStreamingRequest?: (request: Request) => void;
  /** Uniform in [0, 1) for `{{random}}` and `{{roll}}`; the platform CSPRNG unless a test pins it. */
  random?: () => number;
  /** A lorebook entry's digest for its timed state (app.ts supplies Bun's native hash). */
  digest: EntryDigest;
  /** ComfyUI's WebSocket; Bun's native one unless a test passes a fake. */
  comfyuiSocket?: ComfySocketFactory;
  /** The workflows the server runs, built once at startup (index.ts). */
  workflows: WorkflowRegistry;
  shutdown?: Shutdown;
}

export function createApi(config: AppConfig, deps: ApiDeps) {
  const { log, workflows } = deps;
  const catalog = createCatalog(config, deps.fetch, log);
  const generation = createGeneration(catalog, deps.digest, deps.random);
  const upstream = createUpstream(config, deps.fetch, log);
  const comfyui = createComfyui({
    fetch: deps.fetch,
    workflows,
    ...(deps.comfyuiSocket ? { socket: deps.comfyuiSocket } : {}),
    apiKey: config.comfyuiApiKey,
    ca: config.comfyuiCa,
    allowedOrigins: config.comfyuiAllowedOrigins,
    executionTimeoutMs: ART_TIMEOUT_MS,
    log,
    ...(deps.shutdown ? { stopping: deps.shutdown.signal } : {}),
  });
  deps.shutdown?.drain(comfyui.settled);

  // Every route reads the requester's own stores (user.ts).
  return new Hono<UserEnv>()
    .route(
      MOUNTS.characters,
      createCharactersApi((c) => c.var.user.stores.characters, log),
    )
    .route(
      MOUNTS.personas,
      createPersonasApi((c) => c.var.user.stores.personas, log),
    )
    .route(
      MOUNTS.lorebooks,
      createLorebooksApi((c) => c.var.user.stores.lorebooks, log),
    )
    .route(
      "/events",
      createEventsApi((c) => c.var.user.stores.events),
    )
    .route(
      "/memory",
      createMemoryApi({
        log,
        catalog,
        upstream,
        requestTimeoutMs: config.requestTimeoutMs,
        ...(deps.onStreamingRequest ? { onStreamingRequest: deps.onStreamingRequest } : {}),
      }),
    )
    .route(
      "/cast",
      createCastApi({
        log,
        catalog,
        upstream,
        requestTimeoutMs: config.requestTimeoutMs,
        ...(deps.onStreamingRequest ? { onStreamingRequest: deps.onStreamingRequest } : {}),
      }),
    )
    .route(
      "/presets",
      createPresetsApi((c) => c.var.user.stores.presets, {
        log,
        modelIds: async (signal) => (await catalog.current(signal))?.map((model) => model.id),
      }),
    )
    .route(
      "/settings",
      createSettingsApi((c) => c.var.user.stores.settings, {
        log,
        comfyuiAllows: comfyui.allows,
        workflows,
      }),
    )
    .route(
      "/",
      createPalettesApi(
        (c) => c.var.user.stores.palettes,
        (c) => c.var.user.stores.settings,
        workflows,
      ),
    )
    .route(
      MOUNTS.creator,
      createCreatorApi({
        log,
        catalog,
        upstream,
        comfyui,
        workflows,
        requestTimeoutMs: config.requestTimeoutMs,
        ...(deps.onStreamingRequest ? { onStreamingRequest: deps.onStreamingRequest } : {}),
        ...(deps.shutdown ? { stopping: deps.shutdown.signal } : {}),
      }),
    )
    .route(
      "/scene",
      createSceneApi({
        log,
        catalog,
        upstream,
        comfyui,
        workflows,
        ...(deps.onStreamingRequest ? { onStreamingRequest: deps.onStreamingRequest } : {}),
        ...(deps.shutdown ? { stopping: deps.shutdown.signal } : {}),
      }),
    )
    .get("/models", async (c) => {
      const result = await catalog.load(c.req.raw.signal);
      if (!result.ok) return c.json({ error: result.error }, 502);
      return c.json({ models: result.models } satisfies z.input<typeof modelsResponseSchema>, 200);
    })
    .post(
      "/chat/preview",
      requestLifetime(config.requestTimeoutMs),
      boundedBody(MAX_CHAT_BODY_BYTES),
      zValidator("json", previewRequestSchema, invalid),
      async (c) => {
        const request = c.req.valid("json");
        const prepared = await generation.prepare(
          request,
          c.get("deadline"),
          c.var.user,
          "preview",
        );
        if (!prepared.ok)
          return refusedBeforeCall(
            c,
            log,
            "generation.refused",
            request.model,
            prepared.error,
            PROMPT_REFUSAL_STATUSES,
          );
        return c.json(
          { prompt: prepared.prompt } satisfies z.input<typeof previewResponseSchema>,
          200,
        );
      },
    )
    .post(
      "/chat",
      requestLifetime(config.requestTimeoutMs, deps.onStreamingRequest),
      boundedBody(MAX_CHAT_BODY_BYTES),
      zValidator("json", generateRequestSchema, invalid),
      async (c) => {
        const request = c.req.valid("json");
        const { model } = request;
        const deadline = c.get("deadline");
        // The stream's callbacks calibrate the requester's estimates, after the handler returned.
        const { user } = c.var;
        const prepared = await generation.prepare(request, deadline, user, "send");
        if (!prepared.ok)
          return refusedBeforeCall(
            c,
            log,
            "generation.refused",
            model,
            prepared.error,
            PROMPT_REFUSAL_STATUSES,
          );
        const { prompt, uncalibrated, reasoning } = prepared;
        const recorder = callRecorder();

        const logging = streamLogging(
          log,
          { error: "generation.error", end: "generation.end", abort: "generation.abort" },
          { model },
        );
        const result = streamText({
          // Auto-Parse: reasoning a model writes inside its reply, in the preset's tag, is read out.
          model: upstream.model(model, reasoning.autoParse ? reasoning.tag : null, {
            recorder,
            purpose: "narration",
          }),
          messages: prompt.messages.map(({ role, content }) => ({ role, content })),
          // Native block order puts system blocks between turns; chat turns themselves can
          // only be user or assistant (generateRequestSchema), so every system message is
          // one the owner's preset, character or persona produced.
          allowSystemInMessages: true,
          ...upstream.settings(prompt.settings, request.cacheKey),
          // Ends upstream work, retries' waits included, when the client disconnects or the
          // lifetime bound passes.
          abortSignal: deadline,
          ...logging.callbacks,
        });
        const stream = createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({ type: "start" });
            // First, the exact prompt sent, for the inspector (ARCHITECTURE.md § Generation flow).
            writer.write({ type: CHAT_DATA_PARTS.prompt, data: prompt, transient: true });
            const reply = toUIMessageStream({
              stream: result.stream,
              sendStart: false,
              // Reasoning is chat content for the reply's disclosure; stated, not left to the default.
              sendReasoning: true,
              // A provider still busy after the retries is told apart (upstream.ts).
              onError: streamFailure,
              // The model's own count calibrates later estimates and reaches the inspector,
              // with the share the provider's prompt cache served (unknown when omitted) and
              // what the model wrote, when the provider says.
              messageMetadata: ({ part }): PromptUsage | undefined => {
                if (part.type !== "finish") return undefined;
                const { inputTokens, ...rest } = reportedUsage(part.totalUsage);
                calibrate(user.calibration, model, uncalibrated, inputTokens);
                return inputTokens === undefined ? undefined : { inputTokens, ...rest };
              },
            });
            // Drain before settlement metadata: keepalive response headers have already left.
            for await (const part of reply) writer.write(part);
            writer.write({
              type: CHAT_DATA_PARTS.usage,
              data: recorder.snapshot(),
              transient: true,
            });
          },
          onError: streamFailure,
        });
        // The instance stays in use until the stream ends (user.ts).
        markStreaming(c);
        // The AI SDK's comment frames keep a silent stream open through Cloudflare; the
        // deadline still ends it (keepalive.ts).
        return withKeepalive(
          createUIMessageStreamResponse({ stream, keepAliveMs: KEEPALIVE_INTERVAL_MS }),
          deadline,
          null,
        );
      },
    );
}

type ErrorBody<Code extends string> = { json: { error: Code } };

/** The RPC type, including the responses every route can get from the boundary and error handlers. */
export type ApiType = ApplyGlobalResponse<
  ReturnType<typeof createApi>,
  {
    403: ErrorBody<"forbidden">;
    405: ErrorBody<"method_not_allowed">;
    412: ErrorBody<"identity_mismatch">;
    413: ErrorBody<"payload_too_large">;
    415: ErrorBody<"unsupported_media_type">;
    500: ErrorBody<"internal">;
    503: ErrorBody<"unavailable">;
  }
>;
