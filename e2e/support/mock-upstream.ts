/**
 * Synthetic OpenAI-compatible upstream for e2e tests; holds records in
 * memory only. Replies transform the input canary so every content class is
 * distinct: `<marker>-in-x` becomes `-out-x` in the reply, `-think-x` in
 * reasoning, `-cont-x` in a continuation and `-imp-x` in a message written
 * for the user. AI card creation's two calls and a scene's image prompt are
 * answered from the marks in their input (e2e/support/creator-fixtures.ts),
 * as is an AI rework (e2e/support/rework-fixtures.ts). A memory, chapter or
 * opening call gets a fixed synthetic object that holds nothing of its input
 * (e2e/support/memory-fixtures.ts). A cast keeper or sheet call is
 * answered from e2e/support/cast-fixtures.ts: with the cast on `mock-cast`
 * (and `mock-slow`), empty on any other model. `/__records` lists a
 * fixture call only when asked for its kind.
 */

import { countMessage, countText, PRIMING } from "../../apps/server/src/tokens.ts";
import {
  completionResponse,
  FAKE_LEVELS,
  FAKE_WINDOW,
} from "../../apps/server/test/fake-upstream.ts";
import {
  ART_FAMILIES,
  artMetaprompt,
  CARD_SYSTEM_PROMPTS,
  SCENE_METAPROMPTS,
} from "../../packages/core/src/creator/prompts.ts";
import { REWORK_SYSTEM_PROMPT } from "../../packages/core/src/creator/rework/prompt.ts";
import {
  creatorArtCompositionSchema,
  creatorKindSchema,
} from "../../packages/core/src/creator/schema.ts";
import { DEFAULT_NOTE_PROMPT } from "../../packages/core/src/preset/defaults.ts";
import { DEFAULT_PROMPT_ACTIONS } from "../../packages/core/src/preset/prompt.ts";
import {
  CAST_MODELS,
  castAnswer,
  castCall,
  castSheetAnswer,
  EMPTY_CAST_ANSWER,
  EMPTY_SHEET_ANSWER,
  SHEET_RETRY_EMPTY,
} from "./cast-fixtures.ts";
import {
  baseOf,
  cardAnswer,
  firstDraft,
  hostileProse,
  imagePrompt,
  incompleteCardAnswer,
  mark,
  scriptOf,
} from "./creator-fixtures.ts";
import { UPSTREAM_PORT } from "./env.ts";
import { chapterAnswer, memoryAnswer, memoryCall, openingAnswer } from "./memory-fixtures.ts";
import { requestBases, reworkAnswer } from "./rework-fixtures.ts";
import {
  MOCK_MODELS,
  MOCK_OUTPUT_TOKENS,
  MOCK_REASONING_TOKENS,
  type MockModel,
  type MockRecord,
} from "./upstream.ts";

/** A message as the chat completions body carries it: a string, or parts such as text and images. */
interface Message {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
}

/** A message's text: its string content, or its text parts joined. */
const contentText = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");

/** Whether a message carries an image part. */
const hasImage = (message: Message): boolean =>
  typeof message.content !== "string" && message.content.some((part) => part.type === "image_url");

/** The first image part's data URL, as the server encoded the image it sent. */
const imageData = (messages: Message[]): string | null =>
  messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .find((part) => part.type === "image_url")?.image_url?.url ?? null;

const records: MockRecord[] = [];

// Every mock model reports `FAKE_WINDOW`, but for the ones below.
/** `mock-wide`'s window, above the default context limit. */
const WIDE_WINDOW = 262_144;
/**
 * `mock-fold`'s window: small enough that a few long exchanges fill it and a
 * request folds held memories, large enough for a memory call's input and
 * its reply reserve.
 */
const FOLD_WINDOW = 16_384;

/** Replies `mock-scripted` gives in turn, set by a spec through `/__script`. */
let scripted: string[] = [];

/** The catalog CLIProxyAPI returns for `/v1/models?client_version=` (fields trimmed). */
function catalogEntry(id: string) {
  if (id === "mock-nowindow") {
    return { slug: id, input_modalities: ["text", "image"], supported_reasoning_levels: [] };
  }
  // A model whose reasoning support and input kinds the catalog does not report.
  if (id === "mock-unreported") return { slug: id, context_window: FAKE_WINDOW };
  return {
    slug: id,
    context_window:
      id === "mock-wide" ? WIDE_WINDOW : id === "mock-fold" ? FOLD_WINDOW : FAKE_WINDOW,
    input_modalities: id === "mock-textonly" ? ["text"] : ["text", "image"],
    supported_reasoning_levels: (id === "mock-lowonly" ? ["low"] : FAKE_LEVELS).map((effort) => ({
      effort,
      description: effort,
    })),
  };
}

/** The sampling fields a request carried; absent ones were left at the model's default. */
const SAMPLING = [
  "temperature",
  "top_p",
  "max_tokens",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "reasoning_effort",
];
const sampling = (body: unknown) =>
  Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(([key]) => SAMPLING.includes(key)),
  );
/** Requests for hostile URLs; any entry means untrusted content reached the network. */
const beacons: string[] = [];

/** Markdown a hostile card or model could produce; every part must stay inert. */
const HOSTILE_REPLY = [
  `*She smiles.* Read [the harbour board](http://127.0.0.1:${UPSTREAM_PORT}/__beacon/link) first.`,
  `![a lantern](http://127.0.0.1:${UPSTREAM_PORT}/__beacon/image.png)`,
  `<img src="http://127.0.0.1:${UPSTREAM_PORT}/__beacon/raw.png" onerror="document.title=1">`,
  "<script>document.title = 'owned'</script>",
  `[run](javascript:document.title='owned') and http://127.0.0.1:${UPSTREAM_PORT}/__beacon/auto`,
  "![a map](/__beacon/relative.png) and [home](/__beacon/relative-link)",
  "Tom &amp; Jerry &mdash; fin&nbsp;",
].join("\n\n");

/** The default note's text up to its first macro, as every filled copy of it begins. */
const DEFAULT_NOTE_START = DEFAULT_NOTE_PROMPT.slice(0, DEFAULT_NOTE_PROMPT.indexOf("{{"));

/**
 * A user message without the default preset's Author's Note: the note goes in at depth 1 as
 * the user, alone or merged into the turn by post-processing, and is not the input.
 */
function withoutDefaultNote(content: string): string {
  if (!content.startsWith(DEFAULT_NOTE_START)) return content;
  return content.slice(content.indexOf("]") + 1).trimStart();
}

const bodySchema = (
  body: unknown,
): { model: MockModel; lastUser: string; messages: { role: string; content: string }[] } => {
  const { model, messages } = body as { model: MockModel; messages: Message[] };
  // Every other field (a speaker's `name`) stays as sent; only the content becomes text.
  const texts = messages.map((message) => ({ ...message, content: contentText(message) }));
  return {
    model,
    lastUser:
      texts
        .filter((m) => m.role === "user")
        .map((m) => withoutDefaultNote(m.content))
        .findLast((content) => content !== "") ?? "",
    messages: texts,
  };
};

/**
 * The creator call a request is, by its system prompt: a card of one kind, an
 * image prompt for a card's portraits or for a chat's scene, or a rework.
 */
function creatorCall(messages: { role: string; content: string }[]) {
  const system = messages.find((message) => message.role === "system")?.content;
  if (system === REWORK_SYSTEM_PROMPT) return { call: "rework" as const };
  for (const kind of creatorKindSchema.options) {
    if (system === CARD_SYSTEM_PROMPTS[kind]) return { call: "card" as const, kind };
    if (
      ART_FAMILIES.some((model) =>
        creatorArtCompositionSchema.options.some(
          (composition) => system === artMetaprompt(model, kind, composition),
        ),
      )
    ) {
      return { call: "art" as const, kind };
    }
    if (ART_FAMILIES.some((model) => system === SCENE_METAPROMPTS[model][kind])) {
      return { call: "scene" as const, kind };
    }
  }
  return undefined;
}

/** A whole, non-streamed completion, as `generateText` asks for. */
const completion = (content: string, messages: { role: string; content: string }[]) => {
  // Helpers calibrate the same model as narration. Count their actual synthetic
  // input and answer so a large keeper request cannot teach a three-token prompt.
  const input =
    PRIMING +
    messages.reduce(
      (sum, message) =>
        sum +
        countMessage({
          role:
            message.role === "system"
              ? "system"
              : message.role === "assistant"
                ? "assistant"
                : "user",
          content: message.content,
        }),
      0,
    );
  const output = countText(content);
  return Response.json({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    model: "mock",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  });
};

/** Bun's direct stream; the DOM typings this config also loads hide its constructor overload. */
const DirectStream = ReadableStream as unknown as new (
  source: Bun.DirectUnderlyingSource,
) => ReadableStream<Uint8Array>;

/**
 * The response written frame by frame to the socket, each content delta
 * added to `record.answer` only once Bun has flushed its frame: a direct
 * stream's `flush(true)` resolves when the server's buffer has drained into
 * the socket. The record then holds what left the mock, never more; it does
 * not prove the app read it. Each chunk `completionResponse` enqueues is one
 * whole `data:` frame.
 */
function recordSent(response: Response, record: { answer: string | null }): Response {
  record.answer = "";
  const source = response.body;
  if (source === null) return response;
  const decoder = new TextDecoder();
  const body = new DirectStream({
    type: "direct",
    async pull(controller) {
      for await (const chunk of source) {
        await controller.write(chunk);
        await controller.flush(true);
        const data = decoder
          .decode(chunk)
          .trim()
          .replace(/^data: /, "");
        if (data !== "[DONE]") {
          const frame = JSON.parse(data) as { choices: { delta: { content?: string } }[] };
          record.answer += frame.choices[0]?.delta.content ?? "";
        }
      }
      controller.close();
    },
  });
  return new Response(body, response);
}

/** Waits `ms`, or less when `signal` aborts first: true when the wait ran its course. */
function held(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => resolve(true), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function split(text: string, parts: number): string[] {
  const size = Math.ceil(text.length / parts);
  return Array.from({ length: parts }, (_, i) => text.slice(i * size, (i + 1) * size)).filter(
    Boolean,
  );
}

Bun.serve({
  hostname: "127.0.0.1",
  port: UPSTREAM_PORT,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__records") {
      const contains = url.searchParams.get("contains") ?? "";
      const call = url.searchParams.get("call");
      return Response.json(
        records
          // Without `call`, a chat's or creator's own requests: a fixture call is never "the" request.
          .filter((r) => r.input.includes(contains) && r.call === call)
          .map(({ input, url, authorization, body, ...view }) => view),
      );
    }
    if (url.pathname === "/__script" && request.method === "POST") {
      scripted = (await request.json()) as string[];
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/__beacon/")) {
      beacons.push(url.pathname);
      return new Response("", { status: 204 });
    }
    if (url.pathname === "/__beacons") return Response.json(beacons);
    // A stand-in for the Authelia portal: another origin the sign-in window is sent to.
    if (url.pathname === "/__portal") {
      return new Response("<!doctype html><title>Sign in</title><h1>Mock portal</h1>", {
        headers: { "Content-Type": "text/html" },
      });
    }
    if (url.pathname === "/v1/models") {
      if (url.searchParams.has("client_version")) {
        return Response.json({ models: MOCK_MODELS.map(catalogEntry) });
      }
      return Response.json({
        object: "list",
        data: MOCK_MODELS.map((id) => ({ id, object: "model" })),
      });
    }
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });

    const body: unknown = await request.json();
    const { model, lastUser, messages } = bodySchema(body);
    const creator = creatorCall(messages);
    // A card's retry ends on a note about its problems; the description stays its first message.
    const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
    const record = {
      model,
      url: url.pathname,
      authorization: null,
      affinity: request.headers.get("x-session-affinity"),
      cacheKey: (body as { prompt_cache_key?: string }).prompt_cache_key ?? null,
      body: null,
      aborted: false,
      completed: false,
      input: creator?.call === "card" ? firstUser : lastUser,
      sampling: sampling(body),
      messages,
      image: (body as { messages: Message[] }).messages.some(hasImage),
      imageData: imageData((body as { messages: Message[] }).messages),
      answer: null as string | null,
      call: memoryCall(messages) ?? castCall(messages),
    };
    records.push(record);
    const instruction = messages.at(-1)?.role === "system" ? messages.at(-1)?.content : undefined;
    const reply =
      instruction === DEFAULT_PROMPT_ACTIONS.continue
        ? `and on ${lastUser.replaceAll("-in-", "-cont-")}`
        : instruction?.startsWith("[Write ") && instruction.includes("next message")
          ? `As you: ${lastUser.replaceAll("-in-", "-imp-")}`
          : `Reply: ${lastUser.replaceAll("-in-", "-out-")}`;
    const reasoning = `Thinking: ${lastUser.replaceAll("-in-", "-think-")}`;

    if (model === "mock-error") {
      // Upstream errors can echo the prompt; the app must not pass this on. A
      // 400 is not retried (upstream.ts retries 408, 409, 429 and 5xx), so
      // one request ends in the error at once.
      return completionResponse(
        {
          failWith: {
            status: 400,
            body: JSON.stringify({ error: { message: `failed on ${lastUser}` } }),
          },
        },
        request.signal,
        record,
      );
    }
    if (record.call !== null) {
      const emptySheetRetry = record.call === "castSheet" && lastUser.includes(SHEET_RETRY_EMPTY);
      if (
        emptySheetRetry &&
        records.filter((one) => one.call === "castSheet" && one.input === lastUser).length === 1
      ) {
        return completionResponse(
          {
            failWith: {
              status: 400,
              body: JSON.stringify({ error: { message: "sheet fixture" } }),
            },
          },
          request.signal,
          record,
        );
      }
      // mock-slow holds a memory or cast answer until the caller leaves, or for fifteen seconds.
      if (model === "mock-slow" && !(await held(15_000, request.signal))) {
        record.aborted = true;
        return new Response(null, { status: 499 });
      }
      const cast = CAST_MODELS.includes(model);
      const answer =
        record.call === "chapter"
          ? chapterAnswer()
          : record.call === "opening"
            ? openingAnswer()
            : record.call === "cast"
              ? cast
                ? castAnswer(messages)
                : EMPTY_CAST_ANSWER
              : record.call === "castSheet"
                ? cast && !emptySheetRetry
                  ? castSheetAnswer()
                  : EMPTY_SHEET_ANSWER
                : memoryAnswer({ prose: model === "mock-memory-prose" });
      record.answer = answer;
      record.completed = true;
      return completion(answer, messages);
    }
    if (creator?.call === "art" || creator?.call === "scene") {
      record.completed = true;
      // A direction's mark outranks the card's, so a canary direction marks the run's prompt and
      // portraits; for a scene, a chat line carrying the mark is the direction.
      return completion(
        imagePrompt(baseOf(lastUser, "steer") ?? baseOf(lastUser, "card") ?? "unmarked"),
        messages,
      );
    }
    if (creator?.call === "rework") {
      const bases = requestBases(lastUser) ?? { requestBase: "unmarked", keptBase: "unmarked" };
      const answer = reworkAnswer({
        ...bases,
        lore: lastUser.includes("<entry_1>"),
        hostile:
          model === "mock-hostile"
            ? hostileProse(`http://127.0.0.1:${UPSTREAM_PORT}/__beacon/rework`)
            : undefined,
      });
      return completionResponse(
        model === "mock-slow"
          ? { chunks: split(answer, 80), delayMs: 100 }
          : { chunks: split(answer, 8), delayMs: 5 },
        request.signal,
        record,
      );
    }
    if (creator?.call === "card") {
      // A `-keep` mark names the base of a card that may persist (an image card's notes).
      const base = baseOf(firstUser, "keep") ?? baseOf(firstUser, "desc") ?? "unmarked";
      const script = scriptOf(firstUser);
      const hostile =
        model === "mock-hostile"
          ? hostileProse(`http://127.0.0.1:${UPSTREAM_PORT}/__beacon/creator`)
          : undefined;
      // mock-badcard leaves out sections only the stricter automatic keep requires.
      const answer =
        model === "mock-badcard"
          ? incompleteCardAnswer(base)
          : cardAnswer(creator.kind, base, hostile);
      // The output ceiling reached halfway through the card.
      if (script === "cut") {
        return completionResponse(
          {
            chunks: split(answer.slice(0, answer.length / 2), 8),
            delayMs: 5,
            finishReason: "length",
          },
          request.signal,
          record,
        );
      }
      if (script === "retry") {
        // A first draft without its opening; the retry, which carries it back, gets the whole card slowly.
        const retried = messages.some((message) => message.role === "assistant");
        return completionResponse(
          retried
            ? { chunks: split(answer, 8), delayMs: 250 }
            : { chunks: split(firstDraft(creator.kind, base), 8), delayMs: 5 },
          request.signal,
          record,
        );
      }
      if (script === "think") {
        // About two seconds of reasoning, never shown, before the card.
        return completionResponse(
          {
            reasoning: split(`Weighing the card for ${mark(base, "desc")} before writing.`, 8),
            chunks: split(answer, 8),
            delayMs: 250,
          },
          request.signal,
          record,
        );
      }
      // mock-slow writes for about eight seconds, long enough to stop it or leave mid-stream.
      // mock-stall writes up to the first chunk carrying the `-card` mark, then holds the stream open.
      // The cut is the first chunk that completes the mark, which may straddle two chunks.
      const stalled = (chunks: string[]) =>
        chunks.slice(
          0,
          chunks.findIndex((_, i) =>
            chunks
              .slice(0, i + 1)
              .join("")
              .includes(mark(base, "card")),
          ) + 1,
        );
      return recordSent(
        completionResponse(
          model === "mock-slow"
            ? { chunks: split(answer, 80), delayMs: 100 }
            : model === "mock-stall"
              ? { chunks: stalled(split(answer, 80)), delayMs: 5, hang: true }
              : { chunks: split(answer, 8), delayMs: 5 },
          request.signal,
          record,
        ),
        record,
      );
    }
    if (model === "mock-hostile") {
      return completionResponse(
        { chunks: split(HOSTILE_REPLY, 6), delayMs: 5 },
        request.signal,
        record,
      );
    }
    if (model === "mock-scripted") {
      // Authored replies in order, so a chat can follow a recorded case turn by turn.
      return completionResponse(
        { chunks: split(scripted.shift() ?? "", 3), delayMs: 5 },
        request.signal,
        record,
      );
    }
    // Explicit synthetic scenarios only. The scripted queue and ordinary replies stay unchanged.
    const finishFixture = /\[e2e-finish:(length|filter|reasoning|blocked)\]/.exec(lastUser)?.[1];
    if (model === "mock-fast" && finishFixture !== undefined) {
      const continuing = instruction === DEFAULT_PROMPT_ACTIONS.continue;
      const previous = messages.findLast((message) => message.role === "assistant")?.content;
      const finished = continuing && previous?.includes("First continuation.");
      const empty = !continuing && ["reasoning", "blocked"].includes(finishFixture);
      return completionResponse(
        {
          chunks: empty
            ? []
            : split(
                continuing ? (finished ? "Finished continuation." : "First continuation.") : reply,
                4,
              ),
          ...(finishFixture === "reasoning" ? { reasoning: ["Considering the scene."] } : {}),
          finishReason: finished
            ? "stop"
            : (finishFixture === "length") !== continuing || finishFixture === "reasoning"
              ? "length"
              : "content_filter",
          delayMs: 150,
        },
        request.signal,
        record,
      );
    }
    if (model === "mock-inline") {
      // A model that writes its reasoning inside the reply, in <think> tags.
      const inline = `<think>Thinking: ${lastUser.replaceAll("-in-", "-think-")}</think>Reply: ${lastUser.replaceAll("-in-", "-out-")}`;
      return completionResponse({ chunks: split(inline, 5), delayMs: 5 }, request.signal, record);
    }
    if (model === "mock-long") {
      // Many paragraphs, slowly: enough to scroll while the reply still streams.
      const paragraphs = Array.from({ length: 90 }, (_, i) => `Line ${i + 1} of the story.\n\n`);
      return completionResponse({ chunks: paragraphs, delayMs: 80 }, request.signal, record);
    }
    const slow = model === "mock-slow";
    // mock-fold echoes long lines: pieces of about 512 characters, so a chat fills its window in
    // seconds. `split` takes how many parts, so the count follows the text's length.
    const parts = (text: string) =>
      model === "mock-fold" ? Math.max(1, Math.ceil(text.length / 512)) : 4;
    // A count like a real model's (about five characters a token), so calibration stays near 1,
    // half of it served from the provider's prompt cache. Of what it wrote, a share is reasoning.
    const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
    const promptTokens = Math.max(1, Math.round(promptChars / 5));
    return completionResponse(
      {
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: MOCK_OUTPUT_TOKENS,
          prompt_tokens_details: {
            cached_tokens: lastUser.includes("[e2e-usage:zero-cache]")
              ? 0
              : Math.floor(promptTokens / 2),
          },
          completion_tokens_details: { reasoning_tokens: MOCK_REASONING_TOKENS },
        },
        reasoning: split(reasoning, model === "mock-fold" ? parts(reasoning) : 3),
        chunks: slow
          ? [...split(reply, 4), ...Array.from({ length: 80 }, () => " more")]
          : split(reply, parts(reply)),
        delayMs: slow ? 100 : 5,
        // mock-stall writes the reply, then holds the stream open until the caller leaves.
        hang: model === "mock-stall",
      },
      request.signal,
      record,
    );
  },
});
