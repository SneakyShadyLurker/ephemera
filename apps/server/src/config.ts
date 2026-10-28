import { fileURLToPath } from "node:url";
import { comfyuiWorkflowIdSchema } from "@ephemera/core";
import { z } from "zod";
import { BUILD_REVISION } from "./build.ts";
import { readCertificate } from "./persistence/certificate.ts";

const originSchema = z
  .string()
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    message: "must be an exact origin such as https://ephemera.example",
  });

/** ComfyUI origins Settings may name: comma-separated, each an exact http or https origin. */
const comfyuiOriginsSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  )
  .pipe(z.array(originSchema.refine((origin) => /^https?:/.test(origin), "must be http or https")));

/** An optional variable; the empty value `.env.example` ships counts as unset. */
const optional = <T extends z.ZodType<string>>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** The port the server listens on unless `EPHEMERA_PORT` says otherwise; Vite's dev proxy targets it. */
export const DEFAULT_PORT = 8790;

const envSchema = z.object({
  EPHEMERA_UPSTREAM_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .transform((url) => url.replace(/\/+$/, "")),
  EPHEMERA_UPSTREAM_API_KEY: z.string().min(1),
  /** CLIProxyAPI's session cache: body `prompt_cache_key` and header `x-session-affinity`; off for an upstream that rejects them. */
  EPHEMERA_UPSTREAM_SESSION_CACHE: optional(z.enum(["on", "off"])).transform(
    (value) => value !== "off",
  ),
  EPHEMERA_PROXY_KEY: z.string().min(32),
  /** Atelier's key for the image card route only; unset closes that route to everyone but SWAG. */
  EPHEMERA_INTEGRATION_KEY: optional(z.string().min(32)),
  /** The master key every user's database is encrypted under: 32 random bytes as 64 hex characters. */
  EPHEMERA_DATA_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .transform((hex) => Buffer.from(hex, "hex")),
  EPHEMERA_ORIGIN: originSchema,
  EPHEMERA_HOST: z.string().min(1).default("127.0.0.1"),
  EPHEMERA_PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  EPHEMERA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  EPHEMERA_STATIC_DIR: z.string().min(1).optional(),
  /** The deployed commit, set by the image; unset in development and tests. */
  EPHEMERA_BUILD_REVISION: optional(z.string().regex(BUILD_REVISION)),
  /** The SQLite database of every persisted entity; the repository's ignored data/ in development. */
  EPHEMERA_DATA_DIR: z
    .string()
    .min(1)
    .default(fileURLToPath(new URL("../../../data", import.meta.url))),
  /** Bearer token for the owner's ComfyUI (Atelier's private worker requires one). */
  COMFYUI_API_KEY: optional(z.string().regex(/^[\x21-\x7e]+$/)),
  /** A PEM CA certificate that ComfyUI's TLS certificate must chain to. */
  COMFYUI_CA_FILE: optional(z.string().min(1)),
  /** The only ComfyUI origins anyone may use; none turns portraits off for every user. */
  COMFYUI_ALLOWED_ORIGINS: comfyuiOriginsSchema,
  /** A directory of more workflow graphs, read once at startup beside the bundled ones. */
  EPHEMERA_WORKFLOWS_DIR: optional(z.string().min(1)),
  /** The workflow a new user starts with and a vanished choice falls back to; the core one when unset. */
  EPHEMERA_DEFAULT_WORKFLOW: optional(comfyuiWorkflowIdSchema),
});

export interface AppConfig {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  /** Whether a call's cache key reaches the upstream (upstream.ts). */
  upstreamSessionCache: boolean;
  proxyKey: string;
  /** Opens `POST /api/creator/card/from-image` only (boundary.ts); never equal to `proxyKey`. */
  integrationKey: string | undefined;
  origin: string;
  requestTimeoutMs: number;
  /** Sent to ComfyUI only, never stored or shown (PRINCIPLES.md 2). */
  comfyuiApiKey: string | undefined;
  /** The pinned CA's PEM text, read once at startup. */
  comfyuiCa: string | undefined;
  /** The only origins the ComfyUI client calls; empty means ComfyUI is off for everyone. */
  comfyuiAllowedOrigins: readonly string[];
  /** The build every response names (build.ts); none outside the image. */
  buildRevision: string | undefined;
}

interface ServerConfig extends AppConfig {
  host: string;
  port: number;
  staticDir: string | undefined;
  dataDir: string;
  /** Kept off AppConfig: only the instance registry and startup verification ever see it. */
  dataKey: Buffer;
  /** Read by the workflow registry index.ts builds; the app gets the registry, not these. */
  workflowsDir: string | undefined;
  defaultWorkflow: string | undefined;
}

export class ConfigError extends Error {
  override name = "ConfigError";
  readonly variables: string[];
  constructor(variables: string[]) {
    super(`Invalid or missing environment variables: ${variables.join(", ")}`);
    this.variables = variables;
  }
}

/** Reads the environment. Errors name variables only, never their values. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]);
  }
  const e = parsed.data;
  const comfyuiCa =
    e.COMFYUI_CA_FILE === undefined ? undefined : readCertificate(e.COMFYUI_CA_FILE);
  if (e.COMFYUI_CA_FILE !== undefined && comfyuiCa === undefined) {
    throw new ConfigError(["COMFYUI_CA_FILE"]);
  }
  // A shared value would give the integration the SWAG key's reach.
  if (e.EPHEMERA_INTEGRATION_KEY === e.EPHEMERA_PROXY_KEY) {
    throw new ConfigError(["EPHEMERA_INTEGRATION_KEY"]);
  }
  return {
    upstreamBaseUrl: e.EPHEMERA_UPSTREAM_BASE_URL,
    upstreamApiKey: e.EPHEMERA_UPSTREAM_API_KEY,
    upstreamSessionCache: e.EPHEMERA_UPSTREAM_SESSION_CACHE,
    proxyKey: e.EPHEMERA_PROXY_KEY,
    integrationKey: e.EPHEMERA_INTEGRATION_KEY,
    origin: e.EPHEMERA_ORIGIN,
    requestTimeoutMs: e.EPHEMERA_REQUEST_TIMEOUT_MS,
    comfyuiApiKey: e.COMFYUI_API_KEY,
    comfyuiCa,
    comfyuiAllowedOrigins: e.COMFYUI_ALLOWED_ORIGINS,
    buildRevision: e.EPHEMERA_BUILD_REVISION,
    host: e.EPHEMERA_HOST,
    port: e.EPHEMERA_PORT,
    staticDir: e.EPHEMERA_STATIC_DIR,
    dataDir: e.EPHEMERA_DATA_DIR,
    dataKey: e.EPHEMERA_DATA_KEY,
    workflowsDir: e.EPHEMERA_WORKFLOWS_DIR,
    defaultWorkflow: e.EPHEMERA_DEFAULT_WORKFLOW,
  };
}
