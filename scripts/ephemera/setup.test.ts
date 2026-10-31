import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataKeyMissingError, missingKeys } from "./setup.ts";

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
