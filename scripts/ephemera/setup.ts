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
import { confirm, log, note, password, select, text } from "@clack/prompts";
import { ConfigError, loadConfig } from "../../apps/server/src/config.ts";
import { usernameSchema } from "../../apps/server/src/identity.ts";
import {
  DEFAULT_LOCAL_PORT,
  ENV_EXAMPLE,
  ENV_FILE,
  localAccess,
  ROOT,
  readEnvFile,
  withValues,
  writeEnvFile,
} from "./env.ts";
import { checkModels, type ModelsCheck, PROVIDERS } from "./providers.ts";
import { runEnv } from "./service.ts";
import { activity, answered, bold, command, dim, fail, models } from "./ui.ts";

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
function librariesExist(env: Record<string, string | undefined>): boolean {
  const users = join(env.EPHEMERA_DATA_DIR || join(ROOT, "data"), "users");
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

/** Keeps the proxy key and data key that exist; makes the ones that do not. */
function keys(current: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  if ((current.EPHEMERA_PROXY_KEY ?? "").length < 32) values.EPHEMERA_PROXY_KEY = key();
  if (!/^[0-9a-fA-F]{64}$/.test(current.EPHEMERA_DATA_KEY ?? "")) {
    if (librariesExist(current)) {
      fail(
        "Libraries exist, but .env has no valid EPHEMERA_DATA_KEY to open them. Restore the key from your backup; a new one cannot read them.",
      );
    }
    values.EPHEMERA_DATA_KEY = key();
  }
  return values;
}

async function access(
  flags: SetupFlags,
  current: Record<string, string>,
): Promise<Record<string, string>> {
  const wasLocal = localAccess(current);
  const wasProxy =
    wasLocal === undefined &&
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
    : flags.behindProxy !== undefined;

  if (behindProxy) {
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
          initialValue: wasLocal?.user ?? suggestedUser(),
          validate: (value) =>
            usernameSchema.safeParse(value ?? "").success
              ? undefined
              : "Lowercase letters and digits, then ., _ or -",
        }),
      )
    : (flags.user ?? wasLocal?.user ?? suggestedUser());
  if (!usernameSchema.safeParse(user).success)
    fail("--user takes lowercase letters and digits, then ., _ or -");
  const port = flags.interactive
    ? answered(
        await text({
          message: "Port to open it on",
          initialValue: String(wasLocal?.port ?? DEFAULT_LOCAL_PORT),
          validate: (value) => (isPort(value ?? "") ? undefined : "A port from 1 to 65535"),
        }),
      )
    : (flags.port ?? String(wasLocal?.port ?? DEFAULT_LOCAL_PORT));
  if (!isPort(port)) fail("--port takes a port from 1 to 65535");
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
    const apiKey = process.env.EPHEMERA_UPSTREAM_API_KEY ?? current.EPHEMERA_UPSTREAM_API_KEY ?? "";
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
    const hasKey = (current.EPHEMERA_UPSTREAM_API_KEY ?? "") !== "";
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
    const apiKey = entered || (current.EPHEMERA_UPSTREAM_API_KEY ?? "");
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

  const values = {
    ...keys(current),
    ...(await access(flags, current)),
    ...(await provider(flags, current)),
  };
  const merged = { ...current, ...values };
  try {
    loadConfig(runEnv({ ...process.env, ...merged }));
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  writeEnvFile(
    withValues(fresh ? readFileSync(ENV_EXAMPLE, "utf8") : readFileSync(ENV_FILE, "utf8"), values),
  );
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
        `Run ${command("./ephemera start")}; it listens on 127.0.0.1:${merged.EPHEMERA_PORT || "8790"}.`,
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
