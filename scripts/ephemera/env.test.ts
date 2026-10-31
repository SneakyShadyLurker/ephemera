import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { ENV_EXAMPLE, localAccess, quote, withValues } from "./env.ts";

describe("env file", () => {
  it("sets values where their lines stand and keeps every comment", () => {
    const template = readFileSync(ENV_EXAMPLE, "utf8");
    const text = withValues(template, {
      EPHEMERA_UPSTREAM_BASE_URL: "https://api.example.com/v1",
      EPHEMERA_UPSTREAM_API_KEY: "sk-a b#c",
      EPHEMERA_LOCAL_USER: "theo",
      EPHEMERA_EXTRA: "new",
    });
    const parsed = parseEnv(text);
    expect(parsed.EPHEMERA_UPSTREAM_BASE_URL).toBe("https://api.example.com/v1");
    expect(parsed.EPHEMERA_UPSTREAM_API_KEY).toBe("sk-a b#c");
    expect(parsed.EPHEMERA_LOCAL_USER).toBe("theo");
    expect(parsed.EPHEMERA_EXTRA).toBe("new");
    const comments = (value: string) => value.split("\n").filter((line) => line.startsWith("#"));
    expect(comments(text)).toEqual(comments(template));
    expect(text.match(/^EPHEMERA_LOCAL_USER=/gm)).toHaveLength(1);
  });

  it("sets every copy of a key, since the last one counts", () => {
    const text = withValues("A=1\n# note\nA=2\n", { A: "3" });
    expect(text).toBe("A=3\n# note\nA=3\n");
    expect(parseEnv(text).A).toBe("3");
  });

  it("refuses a value a reader would take otherwise", () => {
    for (const value of ["it's", "a\nb", "pa$HOME", "end\\"]) {
      expect(() => quote(value)).toThrow();
    }
    expect(() => withValues("", { EPHEMERA_UPSTREAM_API_KEY: "a$b" })).toThrow(
      "EPHEMERA_UPSTREAM_API_KEY",
    );
  });

  it("turns the gateway on only with a username, on its own origin", () => {
    expect(localAccess({})).toBeUndefined();
    expect(localAccess({ EPHEMERA_LOCAL_USER: "", EPHEMERA_LOCAL_PORT: "" })).toBeUndefined();
    expect(localAccess({ EPHEMERA_LOCAL_USER: "theo" })).toEqual({
      user: "theo",
      port: 8780,
      origin: "http://localhost:8780",
    });
    expect(localAccess({ EPHEMERA_LOCAL_USER: "theo", EPHEMERA_LOCAL_PORT: "9001" })?.origin).toBe(
      "http://localhost:9001",
    );
    expect(() => localAccess({ EPHEMERA_LOCAL_USER: "Theo" })).toThrow("EPHEMERA_LOCAL_USER");
    expect(() => localAccess({ EPHEMERA_LOCAL_USER: "theo", EPHEMERA_LOCAL_PORT: "8790" })).toThrow(
      "EPHEMERA_PORT",
    );
    expect(() => localAccess({ EPHEMERA_LOCAL_USER: "theo", EPHEMERA_LOCAL_PORT: "0" })).toThrow(
      "EPHEMERA_LOCAL_PORT",
    );
  });
});
