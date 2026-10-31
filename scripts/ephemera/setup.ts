/**
 * `./ephemera setup`: writes `.env` (keys, access, model provider), checks
 * the provider, builds the app. Asks in a terminal; takes flags and the
 * environment instead when there is none to ask in, or with `--yes`.
 * Existing keys are always kept: a new data key would lock every library.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { confirm, log, note, password, select, text } from "@clack/prompts";
import { ConfigError, DEFAULT_PORT, loadConfig } from "../../apps/server/src/config.ts";
import { usernameSchema } from "../../apps/server/src/identity.ts";
import {
  DEFAULT_LOCAL_PORT,
  ENV_EXAMPLE,
  ENV_FILE,
  type Env,
  EnvValueError,
  effectiveEnv,
  LocalAccessError,
  localAccess,
  readEnvFile,
  withValues,
  writeEnvFile,
} from "./env.ts";
import { checkModels, type ModelsCheck, PROVIDERS } from "./providers.ts";
import { dataDir, runEnv } from "./service.ts";
import { activity, answered, bold, CLI, command, dim, fail, models } from "./ui.ts";

export interface SetupFlags {
  interactive: boolean;
  upstream?: string | undefined;
  user?: string | undefined;
  port?: string | undefined;
  behindProxy?: string | undefined;
  check: boolean;
}

const key = () => randomBytes(32).toString("hex");

/** Whether any library exists under the data directory, which only the current data key opens. */
function librariesExist(env: Env): boolean {
  const users = join(dataDir(env), "users");
  return existsSync(users) && readdirSync(users).length > 0;
}

/** The computer's account name as a username, when it can be one. */
function suggestedUser(): string {
  const name = userInfo().username.toLowerCase();
  return usernameSchema.safeParse(name).success ? name : "me";
}

const isOrigin = (value: string) => URL.canParse(value) && new URL(value).origin === value;
const isHttpUrl = (value: string) =>
  URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
const isPort = (value: string) =>
  /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535;

function describe(check: ModelsCheck): string {
  if (check.ok) return `Connected: ${models(check.models)} available`;
  if (check.reason === "unreachable") return "Nothing answered at that address";
  if (check.reason === "unauthorized") return "The provider refused the API key";
  return `The provider answered with something unexpected${check.status ? ` (HTTP ${check.status})` : ""}`;
}

export class DataKeyMissingError extends Error {
  override name = "DataKeyMissingError";
  constructor() {
    super(
      "Libraries exist, but there is no valid EPHEMERA_DATA_KEY to open them. Restore the key from your backup into .env; a new one cannot read them",
    );
  }
}

const validProxyKey = (value: string | undefined) => (value ?? "").length >= 32;
const validDataKey = (value: string | undefined) => /^[0-9a-fA-F]{64}$/.test(value ?? "");

/**
 * The proxy key and data key `.env` needs: a valid one there is kept; one
 * the shell supplies is written there, since `.env` is what the server
 * reads first; otherwise one is made. A data key is never made while
 * libraries exist, since only the old one opens them.
 */
export function missingKeys(file: Record<string, string>, shell: Env): Record<string, string> {
  const values: Record<string, string> = {};
  if (!validProxyKey(file.EPHEMERA_PROXY_KEY)) {
    values.EPHEMERA_PROXY_KEY = validProxyKey(shell.EPHEMERA_PROXY_KEY)
      ? (shell.EPHEMERA_PROXY_KEY as string)
      : key();
  }
  if (!validDataKey(file.EPHEMERA_DATA_KEY)) {
    if (validDataKey(shell.EPHEMERA_DATA_KEY)) {
      values.EPHEMERA_DATA_KEY = shell.EPHEMERA_DATA_KEY as string;
    } else if (librariesExist(effectiveEnv(shell, file))) {
      throw new DataKeyMissingError();
    } else {
      values.EPHEMERA_DATA_KEY = key();
    }
  }
  return values;
}

export async function access(
  flags: SetupFlags,
  current: Record<string, string>,
): Promise<Record<string, string>> {
  // A local setup that no longer holds (say, a port edited by hand) is replaced, not refused.
  let wasLocal: ReturnType<typeof localAccess>;
  try {
    wasLocal = localAccess(current);
  } catch (error) {
    if (!(error instanceof LocalAccessError)) throw error;
    wasLocal = undefined;
  }
  // The username names the library, so a valid one survives settings that no longer hold.
  const savedUser = wasLocal?.user ?? usernameSchema.safeParse(current.EPHEMERA_LOCAL_USER).data;
  const serverPort = Number(current.EPHEMERA_PORT || DEFAULT_PORT);
  // A local username, even one in settings that no longer hold, means local mode.
  const wasProxy =
    (current.EPHEMERA_LOCAL_USER ?? "") === "" &&
    current.EPHEMERA_ORIGIN !== undefined &&
    !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(current.EPHEMERA_ORIGIN);
  const behindProxy = flags.interactive
    ? answered(
        await select({
          message: "Who will use this Ephemera?",
          initialValue: wasProxy ? "proxy" : "local",
          options: [
            {
              value: "local",
              label: "Just me, on this computer",
              hint: "recommended; opens in your browser, no sign-in needed",
            },
            {
              value: "proxy",
              label: "Several people, or from other devices",
              hint: "behind your own sign-in proxy, such as Authelia",
            },
          ],
        }),
      ) === "proxy"
    : // Without an access flag, an install behind a proxy stays behind it.
      flags.behindProxy !== undefined ||
      (wasProxy && flags.user === undefined && flags.port === undefined);

  if (behindProxy) {
    if (!flags.interactive && flags.behindProxy === undefined) return {};
    const origin = flags.interactive
      ? answered(
          await text({
            message: "The address people will open",
            placeholder: "https://ephemera.example.com",
            initialValue: wasProxy ? (current.EPHEMERA_ORIGIN ?? "") : "",
            validate: (value) =>
              isOrigin(value ?? "")
                ? undefined
                : "An exact origin, like https://ephemera.example.com",
          }),
        )
      : (flags.behindProxy ?? "");
    if (!isOrigin(origin))
      fail("--behind-proxy needs an exact origin, like https://ephemera.example.com");
    return { EPHEMERA_ORIGIN: origin, EPHEMERA_LOCAL_USER: "", EPHEMERA_LOCAL_PORT: "" };
  }

  const user = flags.interactive
    ? answered(
        await text({
          message: "Your name for your library",
          initialValue: savedUser ?? suggestedUser(),
          validate: (value) =>
            usernameSchema.safeParse(value ?? "").success
              ? undefined
              : "Lowercase letters and digits, then ., _ or -",
        }),
      )
    : (flags.user ?? savedUser ?? suggestedUser());
  if (!usernameSchema.safeParse(user).success)
    fail("--user takes lowercase letters and digits, then ., _ or -");
  const port = flags.interactive
    ? answered(
        await text({
          message: "Port to open it on",
          initialValue: String(wasLocal?.port ?? DEFAULT_LOCAL_PORT),
          validate: (value) =>
            !isPort(value ?? "")
              ? "A port from 1 to 65535"
              : Number(value) === serverPort
                ? `The server itself uses ${serverPort}`
                : undefined,
        }),
      )
    : (flags.port ?? String(wasLocal?.port ?? DEFAULT_LOCAL_PORT));
  if (!isPort(port)) fail("--port takes a port from 1 to 65535");
  if (Number(port) === serverPort)
    fail(`--port must differ from the server's own port, ${serverPort}`);
  return { EPHEMERA_LOCAL_USER: user, EPHEMERA_LOCAL_PORT: port };
}

async function provider(
  flags: SetupFlags,
  current: Record<string, string>,
): Promise<Record<string, string>> {
  if (!flags.interactive) {
    const baseUrl =
      flags.upstream ??
      process.env.EPHEMERA_UPSTREAM_BASE_URL ??
      current.EPHEMERA_UPSTREAM_BASE_URL;
    if (!baseUrl || !isHttpUrl(baseUrl)) {
      fail(
        "Name the model provider: --upstream <base URL>, with its key in EPHEMERA_UPSTREAM_API_KEY.",
      );
    }
    // A key goes only to the address it was saved for.
    const saved =
      baseUrl === current.EPHEMERA_UPSTREAM_BASE_URL ? current.EPHEMERA_UPSTREAM_API_KEY : "";
    const apiKey = process.env.EPHEMERA_UPSTREAM_API_KEY ?? saved ?? "";
    if (flags.check) {
      const progress = activity();
      progress.start("Checking the model provider");
      const check = await checkModels(baseUrl, apiKey || undefined);
      if (!check.ok) {
        progress.error(describe(check));
        fail("Fix the address or key and run setup again, or pass --no-check to skip this.");
      }
      progress.stop(describe(check));
    }
    return { EPHEMERA_UPSTREAM_BASE_URL: baseUrl, EPHEMERA_UPSTREAM_API_KEY: apiKey };
  }

  const keep = current.EPHEMERA_UPSTREAM_BASE_URL;
  for (;;) {
    const choice = answered(
      await select({
        message: "Which model provider do you use?",
        options: [
          ...(keep ? [{ value: "keep", label: "Keep the current one", hint: keep }] : []),
          ...PROVIDERS.map((p) => ({
            value: p.name,
            label: p.name,
            ...(p.baseUrl.includes("<host>") && { hint: "runs on your own machine" }),
          })),
          { value: "other", label: "Another OpenAI-compatible API", hint: "any /v1 base URL" },
        ],
      }),
    );
    const preset = PROVIDERS.find((p) => p.name === choice);
    const baseUrl =
      choice === "keep"
        ? (keep ?? "")
        : answered(
            await text({
              message: "Base URL",
              initialValue: preset?.baseUrl.replace("<host>", "localhost") ?? "",
              placeholder: "https://api.example.com/v1",
              validate: (value) => (isHttpUrl(value ?? "") ? undefined : "An http or https URL"),
            }),
          );
    // A key goes only to the address it was saved for.
    const savedKey =
      baseUrl === current.EPHEMERA_UPSTREAM_BASE_URL
        ? (current.EPHEMERA_UPSTREAM_API_KEY ?? "")
        : "";
    const hasKey = savedKey !== "";
    const entered = answered(
      await password({
        message: `API key ${dim(
          hasKey
            ? "(leave empty to keep the current one)"
            : preset?.keyRequired === false
              ? "(leave empty if the server has none)"
              : "",
        )}`,
        validate: (value) =>
          (value ?? "") === "" && preset?.keyRequired && !hasKey
            ? `${preset.name} needs an API key`
            : undefined,
      }),
    );
    const apiKey = entered || savedKey;
    const progress = activity();
    progress.start("Checking the model provider");
    const check = await checkModels(baseUrl, apiKey || undefined);
    if (check.ok) {
      progress.stop(describe(check));
      return { EPHEMERA_UPSTREAM_BASE_URL: baseUrl, EPHEMERA_UPSTREAM_API_KEY: apiKey };
    }
    progress.error(describe(check));
    const next = answered(
      await select({
        message: "What now?",
        options: [
          { value: "again", label: "Enter it again" },
          { value: "keep", label: "Use it anyway", hint: "for a server that is not running yet" },
        ],
      }),
    );
    if (next === "keep")
      return { EPHEMERA_UPSTREAM_BASE_URL: baseUrl, EPHEMERA_UPSTREAM_API_KEY: apiKey };
  }
}

/** Runs the setup and returns whether the server should start now. */
export async function setup(flags: SetupFlags): Promise<boolean> {
  const fresh = !existsSync(ENV_FILE);
  const current = readEnvFile() ?? {};
  if (!fresh) log.info(`Updating your settings in ${dim(".env")}; your keys stay as they are.`);

  let keys: Record<string, string>;
  try {
    keys = missingKeys(current, process.env);
  } catch (error) {
    if (error instanceof DataKeyMissingError) fail(`${error.message}.`);
    throw error;
  }
  const values = {
    ...keys,
    ...(await access(flags, current)),
    ...(await provider(flags, current)),
  };
  const merged = { ...current, ...values };
  let config: ReturnType<typeof loadConfig>;
  try {
    const text = withValues(
      fresh ? readFileSync(ENV_EXAMPLE, "utf8") : readFileSync(ENV_FILE, "utf8"),
      values,
    );
    // Checked as the server will read it: the written file over the shell.
    config = loadConfig(
      runEnv(effectiveEnv(process.env, parseEnv(text) as Record<string, string>)),
    );
    writeEnvFile(text);
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof LocalAccessError ||
      error instanceof EnvValueError
    ) {
      fail(`${error.message}. Nothing was saved.`);
    }
    throw error;
  }
  log.success(`Saved your settings to ${dim(".env")}`);

  if (values.EPHEMERA_DATA_KEY !== undefined) {
    note(
      [
        "Everything you keep is encrypted under the data key in .env",
        `(${bold("EPHEMERA_DATA_KEY")}). Copy it into your password manager:`,
        "without it, nothing can open your library again.",
      ].join("\n"),
      "Back up your data key",
    );
  }

  const local = localAccess(merged);
  if (local === undefined) {
    note(
      [
        `Run ${command(`${CLI} start`)}; it listens on ${config.host}:${config.port}.`,
        "Point your sign-in proxy there. It must clear inbound identity",
        "headers and send Remote-User and X-Ephemera-Proxy-Key, the",
        "EPHEMERA_PROXY_KEY in .env (docs/ARCHITECTURE.md § Deployment).",
      ].join("\n"),
      "Your sign-in proxy",
    );
  }
  if (!flags.interactive) return true;
  return answered(await confirm({ message: "Start Ephemera now?", initialValue: true }));
}
