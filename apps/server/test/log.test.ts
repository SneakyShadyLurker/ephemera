import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createLogger, errorClass } from "../src/log.ts";

describe("logger", () => {
  it("drops fields outside the operational allowlist at runtime", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    const smuggled = { event: "x", status: 200, prompt: "secret", message: "secret" };
    log.info(smuggled);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      time: expect.any(String),
      level: "info",
      event: "x",
      status: 200,
    });
  });

  it("keeps a configuration file's base name", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).error({
      event: "startup.workflows",
      errorClass: "WorkflowFileError",
      file: "krea2-broken.json",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ file: "krea2-broken.json" });
  });

  it("reports an error's class, never its message", () => {
    expect(errorClass(new TypeError("the prompt"))).toBe("TypeError");
    expect(errorClass("the prompt")).toBe("string");
  });
});

describe("loadConfig", () => {
  const valid = {
    EPHEMERA_UPSTREAM_BASE_URL: "http://192.0.2.1:8317/v1/",
    EPHEMERA_UPSTREAM_API_KEY: "upstream",
    EPHEMERA_PROXY_KEY: "k".repeat(32),
    EPHEMERA_DATA_KEY: "0123456789abcdef".repeat(4),
    EPHEMERA_ORIGIN: "https://ephemera.test",
  };

  it("applies defaults and normalizes the upstream URL", () => {
    expect(loadConfig(valid)).toMatchObject({
      upstreamBaseUrl: "http://192.0.2.1:8317/v1",
      host: "127.0.0.1",
      port: 8790,
      requestTimeoutMs: 600_000,
    });
  });

  it("reads an upstream key, and none for a local server that needs none", () => {
    expect(loadConfig(valid).upstreamApiKey).toBe("upstream");
    expect(loadConfig({ ...valid, EPHEMERA_UPSTREAM_API_KEY: "" }).upstreamApiKey).toBeUndefined();
    const { EPHEMERA_UPSTREAM_API_KEY: _, ...keyless } = valid;
    expect(loadConfig(keyless).upstreamApiKey).toBeUndefined();
  });

  it("reads the allowed ComfyUI origins; none turns ComfyUI off, and anything but an origin is refused", () => {
    expect(loadConfig(valid).comfyuiAllowedOrigins).toEqual([]);
    expect(loadConfig({ ...valid, COMFYUI_ALLOWED_ORIGINS: "" }).comfyuiAllowedOrigins).toEqual([]);
    expect(
      loadConfig({
        ...valid,
        COMFYUI_ALLOWED_ORIGINS: "https://comfy.test:8188, http://192.0.2.7:8188",
      }).comfyuiAllowedOrigins,
    ).toEqual(["https://comfy.test:8188", "http://192.0.2.7:8188"]);
    for (const origins of ["https://comfy.test/path", "ftp://comfy.test", "comfy.test"]) {
      expect(() => loadConfig({ ...valid, COMFYUI_ALLOWED_ORIGINS: origins })).toThrowError(
        /COMFYUI_ALLOWED_ORIGINS$/,
      );
    }
  });

  it("reads the default model new libraries start with; empty counts as unset", () => {
    expect(loadConfig(valid).defaultModel).toBeUndefined();
    expect(loadConfig({ ...valid, EPHEMERA_DEFAULT_MODEL: "" }).defaultModel).toBeUndefined();
    expect(loadConfig({ ...valid, EPHEMERA_DEFAULT_MODEL: "vendor/chat-large" }).defaultModel).toBe(
      "vendor/chat-large",
    );
    expect(() => loadConfig({ ...valid, EPHEMERA_DEFAULT_MODEL: "x".repeat(201) })).toThrowError(
      /EPHEMERA_DEFAULT_MODEL$/,
    );
  });

  it("reads the build revision; empty counts as unset, and anything unsafe in a header is refused", () => {
    expect(loadConfig(valid).buildRevision).toBeUndefined();
    expect(loadConfig({ ...valid, EPHEMERA_BUILD_REVISION: "" }).buildRevision).toBeUndefined();
    expect(loadConfig({ ...valid, EPHEMERA_BUILD_REVISION: "952d2f7" }).buildRevision).toBe(
      "952d2f7",
    );
    for (const revision of ["a b", "a\nb", "x".repeat(65)]) {
      expect(() => loadConfig({ ...valid, EPHEMERA_BUILD_REVISION: revision })).toThrowError(
        /EPHEMERA_BUILD_REVISION$/,
      );
    }
  });

  it("reads the optional ComfyUI token and CA once; empty values count as unset", async () => {
    expect(loadConfig({ ...valid, COMFYUI_API_KEY: "", COMFYUI_CA_FILE: "" })).toMatchObject({
      comfyuiApiKey: undefined,
      comfyuiCa: undefined,
    });
    const dir = await mkdtemp(join(tmpdir(), "ephemera-ca-"));
    try {
      const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
      await writeFile(join(dir, "ca.pem"), pem);
      await writeFile(join(dir, "not.pem"), "plain text");
      expect(
        loadConfig({ ...valid, COMFYUI_API_KEY: "token", COMFYUI_CA_FILE: join(dir, "ca.pem") }),
      ).toMatchObject({ comfyuiApiKey: "token", comfyuiCa: pem });
      for (const file of ["not.pem", "missing.pem"]) {
        expect(() => loadConfig({ ...valid, COMFYUI_CA_FILE: join(dir, file) })).toThrowError(
          /COMFYUI_CA_FILE$/,
        );
      }
      expect(() => loadConfig({ ...valid, COMFYUI_API_KEY: "two words" })).toThrowError(
        /COMFYUI_API_KEY$/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the integration key and refuses one equal to the proxy key", () => {
    expect(loadConfig({ ...valid, EPHEMERA_INTEGRATION_KEY: "" }).integrationKey).toBeUndefined();
    expect(loadConfig({ ...valid, EPHEMERA_INTEGRATION_KEY: "j".repeat(32) }).integrationKey).toBe(
      "j".repeat(32),
    );
    expect(() =>
      loadConfig({ ...valid, EPHEMERA_INTEGRATION_KEY: valid.EPHEMERA_PROXY_KEY }),
    ).toThrowError(/EPHEMERA_INTEGRATION_KEY$/);
    expect(() => loadConfig({ ...valid, EPHEMERA_INTEGRATION_KEY: "short" })).toThrowError(
      /EPHEMERA_INTEGRATION_KEY$/,
    );
  });

  it("reads the session cache switch, on unless set off, naming only the variable", () => {
    expect(loadConfig(valid).upstreamSessionCache).toBe(true);
    expect(loadConfig({ ...valid, EPHEMERA_UPSTREAM_SESSION_CACHE: "" }).upstreamSessionCache).toBe(
      true,
    );
    expect(
      loadConfig({ ...valid, EPHEMERA_UPSTREAM_SESSION_CACHE: "on" }).upstreamSessionCache,
    ).toBe(true);
    expect(
      loadConfig({ ...valid, EPHEMERA_UPSTREAM_SESSION_CACHE: "off" }).upstreamSessionCache,
    ).toBe(false);
    for (const value of ["true", "OFF", "0", "secret-switch"]) {
      expect(() => loadConfig({ ...valid, EPHEMERA_UPSTREAM_SESSION_CACHE: value })).toThrowError(
        /^Invalid or missing environment variables: EPHEMERA_UPSTREAM_SESSION_CACHE$/,
      );
    }
  });

  it("reads the starter character switch, on unless set off, naming only the variable", () => {
    expect(loadConfig(valid).starterCharacter).toBe(true);
    expect(loadConfig({ ...valid, EPHEMERA_STARTER_CHARACTER: "" }).starterCharacter).toBe(true);
    expect(loadConfig({ ...valid, EPHEMERA_STARTER_CHARACTER: "on" }).starterCharacter).toBe(true);
    expect(loadConfig({ ...valid, EPHEMERA_STARTER_CHARACTER: "off" }).starterCharacter).toBe(
      false,
    );
    for (const value of ["true", "OFF", "0"]) {
      expect(() => loadConfig({ ...valid, EPHEMERA_STARTER_CHARACTER: value })).toThrowError(
        /^Invalid or missing environment variables: EPHEMERA_STARTER_CHARACTER$/,
      );
    }
  });

  it("reads the data key as 32 bytes and ignores the retired owner variables", () => {
    const config = loadConfig({
      ...valid,
      EPHEMERA_OWNER: "leftover",
      EPHEMERA_LEGACY_OWNER: "leftover",
    });
    expect(config.dataKey).toEqual(Buffer.from(valid.EPHEMERA_DATA_KEY, "hex"));
    expect(config.dataKey).toHaveLength(32);
    expect(Object.values(config)).not.toContain("leftover");
  });

  it.each([
    ["missing", undefined],
    ["too short", "ab".repeat(31)],
    ["too long", "ab".repeat(33)],
    ["not hex", "zz".repeat(32)],
  ])("refuses a %s EPHEMERA_DATA_KEY, naming only the variable", (_label, key) => {
    // The whole message is pinned, so it carries no part of the value.
    expect(() => loadConfig({ ...valid, EPHEMERA_DATA_KEY: key })).toThrowError(
      /^Invalid or missing environment variables: EPHEMERA_DATA_KEY$/,
    );
  });

  it("names invalid variables without printing their values", () => {
    const secret = "short-secret";
    expect(() =>
      loadConfig({ ...valid, EPHEMERA_PROXY_KEY: secret, EPHEMERA_ORIGIN: "https://x.test/path" }),
    ).toThrowError(/EPHEMERA_PROXY_KEY, EPHEMERA_ORIGIN$/);
    try {
      loadConfig({ ...valid, EPHEMERA_PROXY_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
