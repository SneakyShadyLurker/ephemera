/**
 * The root `.env` as `./ephemera` reads and writes it, and the one owner of
 * what the command derives from it: whether the local gateway runs, on which
 * port and as whom.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DEFAULT_PORT } from "../../apps/server/src/config.ts";
import { type Username, usernameSchema } from "../../apps/server/src/identity.ts";

/** The code: a Git checkout, or one version of an installed copy. */
export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/**
 * Where this install keeps what is its own: `.env`, the data directory and
 * the run state. The checkout itself unless `EPHEMERA_HOME` names a folder,
 * as the Windows installer's does, so an update can replace the code alone.
 */
export const HOME_DIR = process.env.EPHEMERA_HOME || ROOT;
export const ENV_FILE = join(HOME_DIR, ".env");
export const ENV_EXAMPLE = join(ROOT, ".env.example");
/** Run state of `./ephemera`: the running server and the build it serves. Git-ignored. */
export const STATE_DIR = join(HOME_DIR, ".ephemera");
/** The data directory unless `EPHEMERA_DATA_DIR` names another; the server's own default in a checkout. */
export const DEFAULT_DATA_DIR = join(HOME_DIR, "data");

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
 * the file `./ephemera setup` wrote is what counts, an empty value included
 * (it clears a key, a mode or a port the shell still carries).
 */
export function effectiveEnv(shell: Env, file: Record<string, string> = {}): Env {
  return { ...shell, ...file };
}

export function serverEnv(): Env {
  return effectiveEnv(process.env, readEnvFile());
}

export class EnvValueError extends Error {
  override name = "EnvValueError";
}

/**
 * A value as one `.env` line holds it for every reader here (Bun's loader,
 * `parseEnv`): bare when plain, else single-quoted. Bun expands `$` even in
 * single quotes, so values with `$`, a quote, a backslash or a newline are
 * refused rather than written so that they read back otherwise.
 */
export function quote(value: string): string {
  if (/^[\w.,:/@+=-]*$/.test(value)) return value;
  if (/['$\\\n\r]/.test(value)) {
    throw new EnvValueError("may not contain $, a quote, a backslash or a newline");
  }
  return `'${value}'`;
}

/**
 * `text` with each key set to its value: existing `KEY=` lines are replaced
 * where they stand (every copy, since the last one counts), so comments and
 * order survive; a missing key is appended. The result is read back and
 * must give every value.
 */
export function withValues(text: string, values: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(values)) {
    let quoted: string;
    try {
      quoted = quote(value);
    } catch (error) {
      if (error instanceof EnvValueError) throw new EnvValueError(`${key} ${error.message}`);
      throw error;
    }
    const line = `${key}=${quoted}`;
    const pattern = new RegExp(`^${RegExp.escape(key)}=.*$`, "gm");
    result = pattern.test(result)
      ? result.replace(pattern, () => line)
      : `${result}${result.endsWith("\n") || result === "" ? "" : "\n"}${line}\n`;
  }
  const read = parseEnv(result);
  for (const [key, value] of Object.entries(values)) {
    if (read[key] !== value) throw new EnvValueError(`${key} would not read back as written`);
  }
  return result;
}

/**
 * Writes `.env` readable by its owner only, since it holds the keys, and
 * atomically: a crash leaves the old file or the new one, never a torn one
 * without the data key.
 */
export function writeEnvFile(text: string, path = ENV_FILE): void {
  const next = `${path}.${process.pid}.tmp`;
  const file = openSync(next, "wx", 0o600);
  try {
    // Given a descriptor, writeFileSync writes until every byte is out or throws.
    writeFileSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(next, path);
  // Windows cannot open a directory to sync it; NTFS journals the rename itself.
  if (process.platform === "win32") return;
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
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
  if (port === Number(env.EPHEMERA_PORT || DEFAULT_PORT)) {
    throw new LocalAccessError("EPHEMERA_LOCAL_PORT must differ from the server's EPHEMERA_PORT");
  }
  return { user: usernameSchema.parse(named), port, origin: `http://localhost:${port}` };
}
