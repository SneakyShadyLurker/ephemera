import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_EXAMPLE, withValues } from "./env.ts";
import {
  access,
  closestModels,
  DataKeyMissingError,
  flagModel,
  missingKeys,
  provider,
} from "./setup.ts";

const DATA_KEY = "ab".repeat(32);
const PROXY_KEY = "p".repeat(40);
const dirs: string[] = [];
const dataDir = (withLibrary: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "ephemera-setup-"));
  dirs.push(dir);
  if (withLibrary) mkdirSync(join(dir, "users", "theo"), { recursive: true });
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("setup's keys", () => {
  it("keeps keys that exist", () => {
    expect(
      missingKeys(
        {
          EPHEMERA_PROXY_KEY: PROXY_KEY,
          EPHEMERA_DATA_KEY: DATA_KEY,
          EPHEMERA_DATA_DIR: dataDir(true),
        },
        {},
      ),
    ).toEqual({});
  });

  it("makes the missing ones for a new install", () => {
    const keys = missingKeys({ EPHEMERA_DATA_DIR: dataDir(false) }, {});
    expect(keys.EPHEMERA_PROXY_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.EPHEMERA_DATA_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.EPHEMERA_DATA_KEY).not.toBe(keys.EPHEMERA_PROXY_KEY);
  });

  it("never makes a data key while libraries exist", () => {
    expect(() =>
      missingKeys({ EPHEMERA_PROXY_KEY: PROXY_KEY, EPHEMERA_DATA_DIR: dataDir(true) }, {}),
    ).toThrow(DataKeyMissingError);
  });

  it("writes keys the shell supplies into .env, where the empty template lines would hide them", () => {
    const shell = { EPHEMERA_PROXY_KEY: PROXY_KEY, EPHEMERA_DATA_KEY: DATA_KEY };
    expect(
      missingKeys(
        { EPHEMERA_PROXY_KEY: "", EPHEMERA_DATA_KEY: "", EPHEMERA_DATA_DIR: dataDir(true) },
        shell,
      ),
    ).toEqual(shell);
  });
});

describe("setup's access, asking nothing", () => {
  it("keeps the library's username when the rest of the local settings no longer hold", async () => {
    const current = {
      EPHEMERA_LOCAL_USER: "library-owner",
      EPHEMERA_LOCAL_PORT: "8790",
      EPHEMERA_ORIGIN: "https://ephemera.example",
    };
    expect(await access({ interactive: false, check: false }, current)).toEqual({
      EPHEMERA_LOCAL_USER: "library-owner",
      EPHEMERA_LOCAL_PORT: "8780",
    });
  });

  it("keeps an install behind a proxy there", async () => {
    const current = { EPHEMERA_LOCAL_USER: "", EPHEMERA_ORIGIN: "https://ephemera.example" };
    expect(await access({ interactive: false, check: false }, current)).toEqual({});
  });
});

describe("setup's default model, asking nothing", () => {
  const LISTED = ["vendor/chat-large", "vendor/chat-small", "other/embed-large", "other/vision"];
  const UPSTREAM = "https://api.example.com/v1";
  const current = {
    EPHEMERA_UPSTREAM_BASE_URL: UPSTREAM,
    EPHEMERA_UPSTREAM_API_KEY: "saved-key",
    EPHEMERA_DEFAULT_MODEL: "vendor/chat-small",
  };

  /** Runs `--yes` setup's provider step against a provider listing LISTED. */
  const run = (flags: { model?: string; check?: boolean }) => {
    vi.stubEnv("EPHEMERA_UPSTREAM_API_KEY", undefined);
    vi.stubGlobal("fetch", async () => Response.json({ data: LISTED.map((id) => ({ id })) }));
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    return provider(
      { interactive: false, upstream: UPSTREAM, model: flags.model, check: flags.check ?? true },
      current,
    );
  };

  it("saves a listed --model, and writes it into .env", async () => {
    const values = await run({ model: "vendor/chat-large" });
    expect(values.EPHEMERA_DEFAULT_MODEL).toBe("vendor/chat-large");
    const text = withValues(readFileSync(ENV_EXAMPLE, "utf8"), values);
    expect(parseEnv(text).EPHEMERA_DEFAULT_MODEL).toBe("vendor/chat-large");
  });

  it("keeps the current default without --model", async () => {
    expect((await run({})).EPHEMERA_DEFAULT_MODEL).toBe("vendor/chat-small");
  });

  it("refuses a --model the provider does not list, and takes it as typed without the check", async () => {
    await expect(run({ model: "vendor/chat-larg" })).rejects.toThrow("exit 1");
    expect((await run({ model: "vendor/chat-larg", check: false })).EPHEMERA_DEFAULT_MODEL).toBe(
      "vendor/chat-larg",
    );
  });

  it("names the closest listed IDs when it refuses one", () => {
    expect(flagModel("vendor/chat-larg", LISTED, "")).toEqual({
      error:
        'The provider doesn\'t list "vendor/chat-larg". Closest: vendor/chat-large, vendor/chat-small. Pass --no-check to use it as typed.',
    });
    expect(flagModel("something-else-entirely", LISTED, "")).toEqual({
      error:
        'The provider doesn\'t list "something-else-entirely". Pass --no-check to use it as typed.',
    });
  });

  it("refuses a --model that is no model ID, with the check or without", () => {
    for (const listed of [LISTED, undefined]) {
      expect(flagModel("", listed, "")).toEqual({ error: "--model takes a model ID." });
      expect(flagModel("x".repeat(201), listed, "")).toEqual({
        error: "--model takes a model ID.",
      });
    }
  });

  it("ranks the closest IDs by edits to the whole ID or its last segment, three at most", () => {
    expect(closestModels("chat-large", LISTED)).toEqual(["vendor/chat-large"]);
    expect(closestModels("vision", LISTED)).toEqual(["other/vision"]);
    expect(closestModels("x", ["a/b", "a/c", "a/d", "a/e"])).toEqual(["a/b", "a/c", "a/d"]);
    expect(closestModels("vendor/chat-large", [])).toEqual([]);
  });
});
