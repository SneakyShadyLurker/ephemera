import { CHAT_DATA_PARTS, type InspectedPrompt, inspectedPromptSchema } from "@ephemera/core";
import sharp from "sharp";
import { type AppDeps, createApp } from "../src/app.ts";
import { loadWorkflowRegistry, type ServerWorkflows } from "../src/comfyui/workflow.ts";
import type { AppConfig } from "../src/config.ts";
import { BOUND_USER_HEADER, usernameSchema } from "../src/identity.ts";
import { createLogger } from "../src/log.ts";
import {
  createInstanceRegistry,
  type InstanceRegistry,
  type Portrait,
  type Stores,
} from "../src/persistence/index.ts";

/** The dedicated key Atelier presents; it opens the image card route only. */
export const INTEGRATION_KEY = "i".repeat(40);

export const config: AppConfig = {
  upstreamBaseUrl: "http://upstream.test/v1",
  upstreamApiKey: "upstream-secret-key-value",
  upstreamSessionCache: true,
  proxyKey: "p".repeat(40),
  integrationKey: INTEGRATION_KEY,
  origin: "https://ephemera.test",
  requestTimeoutMs: 60_000,
  comfyuiApiKey: undefined,
  comfyuiCa: undefined,
  comfyuiAllowedOrigins: [
    "https://comfy.test:8188",
    "http://comfy.test:8188",
    "https://comfy.test",
    "http://192.0.2.7:8188",
  ],
  buildRevision: undefined,
};

/** The username SWAG passes for the requester of every test request. */
export const TEST_USER = usernameSchema.parse("owner");

/** The browser clock every generation request carries. */
export const CLOCK = { now: Date.UTC(2026, 8, 29, 19, 42), timeZone: "Europe/Berlin" };

/** The pick seed every generation request carries: the tab's, for `{{pick}}`. */
export const PICK_SEED = 2_654_435_769;

/**
 * Headers SWAG injects plus what a same-origin browser request carries, the
 * tab's binding included: to the request's `Remote-User` unless `extra` sets it.
 */
export function ownerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Ephemera-Proxy-Key": config.proxyKey,
    "Remote-User": TEST_USER,
    Origin: config.origin,
    "Content-Type": "application/json",
    ...extra,
  };
  return { [BOUND_USER_HEADER]: headers["Remote-User"] ?? TEST_USER, ...headers };
}

/** Headers Atelier's server sends with the integration key; the body sets the content type. */
export function integrationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "X-Ephemera-Proxy-Key": INTEGRATION_KEY,
    "Remote-User": TEST_USER,
    Origin: config.origin,
    Accept: "application/x-ndjson",
    ...extra,
  };
}

/** The bundled workflows with no variable set, as a server without either starts. */
export const BUNDLED_WORKFLOWS: ServerWorkflows = loadWorkflowRegistry({});

/**
 * The app over an in-memory registry unless `deps` brings one, and the
 * bundled workflows unless it brings others; tests reach a user's stores
 * through `instances.instance(TEST_USER).stores`.
 */
export function testApp(deps: Partial<AppDeps> = {}, overrides: Partial<AppConfig> = {}) {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));
  const workflows = deps.workflows ?? BUNDLED_WORKFLOWS;
  const instances =
    deps.instances ??
    createInstanceRegistry({
      dataDir: ":memory:",
      key: Buffer.alloc(32),
      log,
      defaultWorkflow: workflows.defaultWorkflow,
    });
  const app = createApp({ ...config, ...overrides }, { log, ...deps, workflows, instances });
  return { app, lines, instances };
}

/**
 * A registry that gives every user the same stores, for a test that changes
 * rows behind the stores' back through the database they were built on.
 */
export function sharedStores(stores: Stores): InstanceRegistry {
  const user = {
    username: TEST_USER,
    stores,
    calibration: new Map<string, number>(),
    enter() {},
    leave() {},
    flushIfDirty: async () => {},
  };
  return { instance: () => user, size: 1, close: async () => {} };
}

/** A JSON request as the owner's tab sends it, without a body when `body` is undefined. */
export function requestJson(method: string, body?: unknown, init: RequestInit = {}): RequestInit {
  return {
    method,
    headers: ownerHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
  };
}

export function postJson(body: unknown, init: RequestInit = {}): RequestInit {
  return requestJson("POST", body, init);
}

/** A form holding one file, `file`, as a file input uploads it. */
export function fileForm(bytes: Uint8Array | string, name: string): FormData {
  const form = new FormData();
  form.append("file", new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name));
  return form;
}

/**
 * A multipart request as the browser sends it: `headers` without their JSON
 * content type, so `fetch` sets the multipart one with its boundary.
 */
export function formRequest(
  method: string,
  form: FormData,
  headers: Record<string, string> = ownerHeaders(),
): RequestInit {
  const { "Content-Type": _json, ...multipart } = headers;
  return { method, headers: multipart, body: form };
}

/** The parts of a UI message stream's text, as sent. */
export function streamParts(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** The parts of a response's UI message stream. */
export async function responseParts(response: Response): Promise<Record<string, unknown>[]> {
  return streamParts(await response.text());
}

/** The inspected prompt a stream's transient `data-prompt` part carries. */
export function promptPart(parts: Record<string, unknown>[]): InspectedPrompt {
  return inspectedPromptSchema.parse(
    parts.find((part) => part.type === CHAT_DATA_PARTS.prompt)?.data,
  );
}

/** A small stored portrait of one colour, with its thumbnail, as the image pipeline keeps it. */
export async function samplePortrait(): Promise<Portrait> {
  const image = sharp({ create: { width: 20, height: 30, channels: 3, background: "#406080" } });
  return {
    png: new Uint8Array(await image.clone().png().toBuffer()),
    thumb: new Uint8Array(await image.clone().webp().toBuffer()),
    width: 20,
    height: 30,
  };
}
