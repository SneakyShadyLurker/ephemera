/**
 * The root `.env` as `./ephemera` reads and writes it, and the one owner of
 * what the command derives from it: whether the local gateway runs, on which
 * port and as whom.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { type Username, usernameSchema } from "../../apps/server/src/identity.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const ENV_FILE = join(ROOT, ".env");
export const ENV_EXAMPLE = join(ROOT, ".env.example");
/** Run state of `./ephemera`: the running server and the build it serves. Git-ignored. */
export const STATE_DIR = join(ROOT, ".ephemera");

/** The gateway's port unless `EPHEMERA_LOCAL_PORT` says otherwise. */
export const DEFAULT_LOCAL_PORT = 8780;

export type Env = Record<string, string | undefined>;

/** The values in `.env`, or undefined when there is none. */
export function readEnvFile(path = ENV_FILE): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
}

/**
 * The environment the server runs with: the shell's, with `.env` on top, so
 * the file `./ephemera setup` wrote is what counts.
 */
export function serverEnv(): Env {
  return { ...process.env, ...readEnvFile() };
}

/** A value as one `.env` line can hold it: bare when plain, else single-quoted. */
export function quote(value: string): string {
  if (/^[\w.,:/@+=-]*$/.test(value)) return value;
  if (/['\n\r]/.test(value)) throw new Error("a value may not contain a single quote or a newline");
  return `'${value}'`;
}

/**
 * `text` with each key set to its value: an existing `KEY=` line is replaced
 * where it stands, so comments and order survive; a missing key is appended.
 */
export function withValues(text: string, values: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${quote(value)}`;
    const pattern = new RegExp(`^${RegExp.escape(key)}=.*$`, "m");
    result = pattern.test(result)
      ? result.replace(pattern, () => line)
      : `${result}${result.endsWith("\n") || result === "" ? "" : "\n"}${line}\n`;
  }
  return result;
}

/** Writes `.env` readable by its owner only: it holds the keys. */
export function writeEnvFile(text: string, path = ENV_FILE): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface LocalAccess {
  /** The one username every request through the gateway carries. */
  user: Username;
  port: number;
  /** The origin the browser opens and the server checks writes against. */
  origin: string;
}

export class LocalAccessError extends Error {
  override name = "LocalAccessError";
}

/**
 * The local gateway's settings, or undefined when a trusted authentication
 * proxy stands in front instead (`EPHEMERA_LOCAL_USER` unset).
 */
export function localAccess(env: Env): LocalAccess | undefined {
  const named = env.EPHEMERA_LOCAL_USER ?? "";
  const portText = env.EPHEMERA_LOCAL_PORT ?? "";
  const port = portText === "" ? DEFAULT_LOCAL_PORT : Number(portText);
  const invalid = [
    ...(named !== "" && !usernameSchema.safeParse(named).success ? ["EPHEMERA_LOCAL_USER"] : []),
    ...(!Number.isInteger(port) || port < 1 || port > 65_535 ? ["EPHEMERA_LOCAL_PORT"] : []),
  ];
  if (invalid.length > 0) {
    throw new LocalAccessError(`Invalid environment variables: ${invalid.join(", ")}`);
  }
  if (named === "") return undefined;
  return { user: usernameSchema.parse(named), port, origin: `http://localhost:${port}` };
}
