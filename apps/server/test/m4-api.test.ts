import {
  blankCard,
  DEFAULT_AUTHORS_NOTE,
  defaultPromptPreset,
  defaultSamplerPreset,
} from "@ephemera/core";
import type { MiddlewareHandler } from "hono";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { callSettings } from "../src/generation.ts";
import { PORTRAIT_CACHE_CONTROL } from "../src/http.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  fileForm,
  formRequest,
  ownerHeaders,
  PICK_SEED,
  postJson,
  requestJson,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { gif, jpegWithMetadata, plainPng, svg } from "./image-fixtures.ts";
import { TEST_WORKFLOWS } from "./test-workflows.ts";

function setup(extra: Parameters<typeof testApp>[0] = {}) {
  const { app, lines, instances } = testApp(extra);
  const { stores } = instances.instance(TEST_USER);
  return { app, lines, stores };
}

const upload = (bytes: Uint8Array, name = "avatar.png") =>
  formRequest("PUT", fileForm(bytes, name));

describe("personas API", () => {
  it("creates, reads, edits, lists, duplicates and deletes", async () => {
    const { app } = setup();
    const id = crypto.randomUUID();
    const fields = { name: "Aria", description: "An apprentice." };
    expect((await app.request("/api/personas", requestJson("POST", { id, fields }))).status).toBe(
      201,
    );
    // A retried create is harmless.
    expect((await app.request("/api/personas", requestJson("POST", { id, fields }))).status).toBe(
      201,
    );

    const patched = await app.request(
      `/api/personas/${id}`,
      requestJson("PATCH", { description: "A captain.", revision: 0 }),
    );
    expect(await patched.json()).toMatchObject({
      id,
      name: "Aria",
      description: "A captain.",
      revision: 1,
    });

    const copy = await app.request(`/api/personas/${id}/duplicate`, requestJson("POST"));
    expect(copy.status).toBe(201);
    const listed = (await (
      await app.request("/api/personas", { headers: ownerHeaders() })
    ).json()) as {
      personas: { name: string }[];
    };
    expect(listed.personas.map((persona) => persona.name).sort()).toEqual(["Aria", "Aria (copy)"]);

    expect((await app.request(`/api/personas/${id}`, requestJson("DELETE"))).status).toBe(204);
    expect((await app.request(`/api/personas/${id}`, { headers: ownerHeaders() })).status).toBe(
      404,
    );
  });

  it("rejects unknown fields, a blank name and chat shapes", async () => {
    const { app } = setup();
    const id = crypto.randomUUID();
    for (const body of [
      { id, fields: { name: "A", description: "", messages: [] } },
      { id, fields: { name: " ", description: "" } },
      { id: "x", fields: { name: "A", description: "" } },
      { model: "m", messages: [{ role: "user", content: "canary" }] },
    ]) {
      const response = await app.request("/api/personas", requestJson("POST", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("binds a character to a persona and refuses unknown ids", async () => {
    const { app, stores } = setup();
    const character = stores.characters.create(blankCard("Mara"));
    const persona = stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    const bind = (characterId: string, personaId: string | null) =>
      app.request(`/api/personas/bindings/${characterId}`, requestJson("PUT", { personaId }));
    expect((await bind(character, persona)).status).toBe(204);
    expect(stores.personas.get(persona)?.characterIds).toEqual([character]);
    expect((await bind(character, crypto.randomUUID())).status).toBe(404);
    expect((await bind(crypto.randomUUID(), persona)).status).toBe(404);
    expect((await bind(character, null)).status).toBe(204);
    expect(stores.personas.get(persona)?.characterIds).toEqual([]);
  });

  it("refuses a binding body past the JSON limit without reading it", async () => {
    const { app, stores } = setup();
    const character = stores.characters.create(blankCard("Mara"));
    const response = await app.request(`/api/personas/bindings/${character}`, {
      ...requestJson("PUT", { personaId: null }),
      body: JSON.stringify({ personaId: null, padding: "x".repeat(9 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("puts avatars through the portrait pipeline and revalidates only the current version", async () => {
    const { app, stores } = setup();
    const id = stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    const put = await app.request(
      `/api/personas/${id}/portrait`,
      upload(await jpegWithMetadata(), "me.jpg"),
    );
    expect(put.status).toBe(200);
    const { portrait } = (await put.json()) as { portrait: number };

    const url = `/api/personas/${id}/portrait/image?size=full&v=${portrait}`;
    const current = await app.request(url, { headers: ownerHeaders() });
    expect(current.headers.get("Content-Type")).toBe("image/png");
    expect(current.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(current.headers.get("Cache-Control")).toBe(PORTRAIT_CACHE_CONTROL);
    const tag = current.headers.get("ETag") ?? "";
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    const unchanged = await app.request(url, { headers: ownerHeaders({ "If-None-Match": tag }) });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("Cache-Control")).toBe(PORTRAIT_CACHE_CONTROL);
    expect(unchanged.headers.get("ETag")).toBe(tag);
    const meta = await sharp(new Uint8Array(await current.arrayBuffer())).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();

    for (const query of ["", `?v=${portrait - 1}`]) {
      const stale = await app.request(`/api/personas/${id}/portrait/image${query}`, {
        headers: ownerHeaders(),
      });
      expect(stale.headers.get("Cache-Control")).toBe("no-store, no-transform");
    }

    expect((await app.request(`/api/personas/${id}/portrait`, upload(svg, "x.svg"))).status).toBe(
      415,
    );
    expect(
      (await app.request(`/api/personas/${id}/portrait`, upload(await gif(), "x.gif"))).status,
    ).toBe(415);
    expect(
      (await app.request(`/api/personas/${crypto.randomUUID()}/portrait`, upload(await plainPng())))
        .status,
    ).toBe(404);
    expect((await app.request(`/api/personas/${id}/portrait`, requestJson("DELETE"))).status).toBe(
      204,
    );
    expect(stores.personas.get(id)?.portrait).toBeNull();
  });

  it("logs a rejected avatar by class only", async () => {
    const { app, lines, stores } = setup();
    const id = stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    await app.request(`/api/personas/${id}/portrait`, upload(svg, "x.svg"));
    const line = lines.find((entry) => entry.includes("personas.portrait"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      event: "personas.portrait",
      errorClass: "unsupported_image",
    });
    expect(lines.join("\n")).not.toContain("svg");
  });
});

describe("presets API", () => {
  it("lists the seeded presets, creates, edits, duplicates and deletes", async () => {
    const { app } = setup();
    const list = async (kind: string) =>
      (
        (await (await app.request(`/api/presets/${kind}`, { headers: ownerHeaders() })).json()) as {
          presets: { id: string; name: string }[];
        }
      ).presets;
    expect((await list("prompt")).map((preset) => preset.name)).toEqual(["Default"]);
    expect((await list("sampler")).map((preset) => preset.name)).toEqual(["Model defaults"]);

    const id = crypto.randomUUID();
    const preset = defaultSamplerPreset("Balanced");
    expect(
      (await app.request("/api/presets/sampler", requestJson("POST", { id, preset }))).status,
    ).toBe(201);
    const patched = await app.request(
      `/api/presets/sampler/${id}`,
      requestJson("PATCH", { values: { ...preset.values, temperature: 0.9 }, revision: 0 }),
    );
    expect(
      ((await patched.json()) as { preset: { values: { temperature: number } } }).preset.values
        .temperature,
    ).toBe(0.9);
    expect(
      (await app.request(`/api/presets/sampler/${id}/duplicate`, requestJson("POST"))).status,
    ).toBe(201);
    expect((await app.request(`/api/presets/sampler/${id}`, requestJson("DELETE"))).status).toBe(
      204,
    );
  });

  it("gives a prompt preset created without a note the default, and keeps an edited note through a rename", async () => {
    const { app } = setup();
    const id = crypto.randomUUID();
    const { authorsNote: _note, ...withoutNote } = defaultPromptPreset("Mine");
    expect(
      (await app.request("/api/presets/prompt", requestJson("POST", { id, preset: withoutNote })))
        .status,
    ).toBe(201);
    const read = async () =>
      (
        (await (
          await app.request(`/api/presets/prompt/${id}`, { headers: ownerHeaders() })
        ).json()) as { preset: { name: string; authorsNote: unknown } }
      ).preset;
    expect((await read()).authorsNote).toEqual(DEFAULT_AUTHORS_NOTE);

    const authorsNote = { ...DEFAULT_AUTHORS_NOTE, text: "Keep the fog thick.", role: "system" };
    const edited = await app.request(
      `/api/presets/prompt/${id}`,
      requestJson("PATCH", { authorsNote, revision: 0 }),
    );
    expect(edited.status).toBe(200);
    const renamed = await app.request(
      `/api/presets/prompt/${id}`,
      requestJson("PATCH", { name: "Renamed", revision: 1 }),
    );
    expect(renamed.status).toBe(200);
    expect(await read()).toMatchObject({ name: "Renamed", authorsNote });
  });

  it("refuses to delete the last preset and to break a preset by patching", async () => {
    const { app } = setup();
    const [only] = (
      (await (await app.request("/api/presets/prompt", { headers: ownerHeaders() })).json()) as {
        presets: { id: string }[];
      }
    ).presets;
    const removed = await app.request(`/api/presets/prompt/${only?.id}`, requestJson("DELETE"));
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: "last_preset" });

    const blocks = defaultPromptPreset().blocks.filter((block) => block.id !== "chatHistory");
    expect(
      (
        await app.request(
          `/api/presets/prompt/${only?.id}`,
          requestJson("PATCH", { blocks, revision: 0 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/api/presets/prompt/${only?.id}`,
          requestJson("PATCH", { messages: [], revision: 0 }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("settings API", () => {
  it("reads and changes the settings; unknown references are refused", async () => {
    const { app, lines, stores } = setup();
    const read = async () =>
      (
        (await (await app.request("/api/settings", { headers: ownerHeaders() })).json()) as {
          settings: Record<string, unknown>;
        }
      ).settings;
    expect(await read()).toMatchObject({ theme: "system", model: null, characterId: null });

    const character = stores.characters.create(blankCard("Mara"));
    const changed = await app.request(
      "/api/settings",
      requestJson("PATCH", { theme: "dark", characterId: character }),
    );
    expect(changed.status).toBe(200);
    expect(await read()).toMatchObject({ theme: "dark", characterId: character });

    const unknown = await app.request(
      "/api/settings",
      requestJson("PATCH", { personaId: crypto.randomUUID() }),
    );
    expect(unknown.status).toBe(422);
    expect(
      JSON.parse(lines.find((line) => line.includes("settings.update")) ?? "{}"),
    ).toMatchObject({
      status: 422,
    });
    for (const body of [
      { theme: "sepia" },
      { messages: [{ role: "user", content: "canary" }] },
      { draft: "x" },
    ]) {
      expect((await app.request("/api/settings", requestJson("PATCH", body))).status).toBe(400);
    }
    expect(JSON.stringify(await read())).not.toContain("canary");
  });

  it("refuses a ComfyUI address whose origin the server does not allow, and keeps an allowed one", async () => {
    const { app, lines } = setup();
    const address = async () =>
      (
        (await (await app.request("/api/settings", { headers: ownerHeaders() })).json()) as {
          settings: { comfyuiBaseUrl: string };
        }
      ).settings.comfyuiBaseUrl;
    const allowed = await app.request(
      "/api/settings",
      requestJson("PATCH", { comfyuiBaseUrl: "https://comfy.test:8188/comfy" }),
    );
    expect(allowed.status).toBe(200);
    for (const comfyuiBaseUrl of ["https://elsewhere.test:8188", "https://comfy.test:8189"]) {
      const refused = await app.request("/api/settings", requestJson("PATCH", { comfyuiBaseUrl }));
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: "comfyui_origin_not_allowed" });
    }
    expect(await address()).toBe("https://comfy.test:8188/comfy");
    expect(lines.join("\n")).toContain('"errorClass":"comfyui_origin_not_allowed"');
    expect(lines.join("\n")).not.toContain("elsewhere.test");
  });

  it("keeps the ComfyUI address and workflow; only plain http and https addresses pass", async () => {
    const { app } = setup({ workflows: TEST_WORKFLOWS });
    const read = async () =>
      (
        (await (await app.request("/api/settings", { headers: ownerHeaders() })).json()) as {
          settings: Record<string, unknown>;
        }
      ).settings;
    expect(await read()).toMatchObject({
      comfyuiBaseUrl: "",
      comfyuiWorkflow: "krea2-gonzalomo",
    });

    for (const comfyuiBaseUrl of ["https://comfy.test:8188", "http://192.0.2.7:8188/comfy", ""]) {
      const body = { comfyuiBaseUrl, comfyuiWorkflow: "krea2-gonzalomo" };
      expect((await app.request("/api/settings", requestJson("PATCH", body))).status).toBe(200);
      expect(await read()).toMatchObject(body);
    }

    await app.request(
      "/api/settings",
      requestJson("PATCH", { comfyuiBaseUrl: "https://comfy.test" }),
    );
    for (const body of [
      { comfyuiBaseUrl: "ftp://comfy.test" },
      { comfyuiBaseUrl: "file:///etc/hosts" },
      { comfyuiBaseUrl: "javascript:alert(1)" },
      { comfyuiBaseUrl: "ws://comfy.test" },
      { comfyuiBaseUrl: "comfy.test:8188" },
      { comfyuiBaseUrl: ["https://user", "placeholder@comfy.test"].join(":") },
      { comfyuiBaseUrl: "https://comfy.test/?token=secret" },
      { comfyuiBaseUrl: `https://comfy.test/${"a".repeat(2048)}` },
      { comfyuiWorkflow: "Custom Workflow" },
    ]) {
      expect((await app.request("/api/settings", requestJson("PATCH", body))).status).toBe(400);
    }
    expect(await read()).toMatchObject({
      comfyuiBaseUrl: "https://comfy.test",
      comfyuiWorkflow: "krea2-gonzalomo",
    });

    // Any workflow the server has a graph for; an id it has none for is an unknown reference.
    const other = { comfyuiWorkflow: "krea2-fixture" };
    expect((await app.request("/api/settings", requestJson("PATCH", other))).status).toBe(200);
    expect(await read()).toMatchObject(other);
    const unknown = { comfyuiWorkflow: "krea2-unknown" };
    const refused = await app.request("/api/settings", requestJson("PATCH", unknown));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "unknown_reference" });
    expect(await read()).toMatchObject(other);
  });

  it("paints the saved theme onto the app shell before any script runs", async () => {
    const shell: MiddlewareHandler = async (c) =>
      c.html('<!doctype html><html lang="en" translate="no"><head></head><body></body></html>');
    const { app, stores } = setup({ fetch: fakeUpstream().fetch, appShell: shell });
    const html = async () => (await app.request("/personas", { headers: ownerHeaders() })).text();
    expect(await html()).not.toContain("data-theme");
    stores.settings.update({ theme: "dark" });
    expect(await html()).toContain(
      '<html lang="en" translate="no" data-theme="dark" data-user="owner">',
    );
    const response = await app.request("/personas", { headers: ownerHeaders() });
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  });
});

describe("sampler presets reach generation", () => {
  const request = (samplerPresetId?: string) => ({
    model: "fake-model",
    ...(samplerPresetId === undefined ? {} : { samplerPresetId }),
    clock: CLOCK,
    pickSeed: PICK_SEED,
    messages: [{ role: "user", content: "hi" }],
  });

  it("sends exactly the set values upstream and omits the rest", async () => {
    const upstream = fakeUpstream({ chunks: ["ok"] });
    const { app, stores } = setup({ fetch: upstream.fetch });
    const preset = defaultSamplerPreset("Balanced");
    const id = stores.presets.sampler.create(
      {
        ...preset,
        values: {
          ...preset.values,
          temperature: 0.9,
          maxOutputTokens: 1200,
          seed: 7,
          reasoning: "low",
        },
      },
      crypto.randomUUID(),
    );
    await (await app.request("/api/chat", postJson(request(id)))).text();
    const body = upstream.records[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      temperature: 0.9,
      max_tokens: 1200,
      seed: 7,
      reasoning_effort: "low",
    });
    for (const key of ["top_p", "frequency_penalty", "presence_penalty"])
      expect(body).not.toHaveProperty(key);
  });

  it("sends no sampling values without a preset, with the seeded preset, or with a deleted one", async () => {
    const upstream = fakeUpstream({ chunks: ["ok"] });
    const { app, stores } = setup({ fetch: upstream.fetch });
    const [seeded] = stores.presets.sampler.list();
    for (const id of [undefined, seeded?.id, crypto.randomUUID()]) {
      await (await app.request("/api/chat", postJson(request(id)))).text();
    }
    expect(upstream.records).toHaveLength(3);
    for (const record of upstream.records) {
      const body = record.body as Record<string, unknown>;
      for (const key of ["temperature", "max_tokens", "top_p", "seed", "reasoning_effort"]) {
        expect(body).not.toHaveProperty(key);
      }
    }
  });

  it("maps every set value to its call setting", () => {
    expect(
      callSettings({
        model: null,
        maxOutputTokens: 10,
        temperature: 0,
        topP: 0.5,
        frequencyPenalty: -1,
        presencePenalty: 2,
        seed: 0,
        reasoning: "none",
      }),
    ).toEqual({
      maxOutputTokens: 10,
      temperature: 0,
      topP: 0.5,
      frequencyPenalty: -1,
      presencePenalty: 2,
      seed: 0,
      reasoning: "none",
    });
  });
});

describe("boundary for persona uploads", () => {
  it("allows multipart on the persona portrait upload and nowhere else new", async () => {
    const { app, stores } = setup();
    const id = stores.personas.create({ name: "Aria", description: "" }, crypto.randomUUID());
    const png = await plainPng();
    expect((await app.request(`/api/personas/${id}/portrait`, upload(png))).status).toBe(200);
    const others: [string, string][] = [
      ["/api/personas", "POST"],
      [`/api/personas/${id}`, "PATCH"],
      [`/api/personas/${id}/portrait`, "POST"],
      ["/api/presets/prompt", "POST"],
      ["/api/settings", "PATCH"],
    ];
    for (const [path, method] of others) {
      const init = upload(png);
      expect((await app.request(path, { ...init, method })).status).toBe(415);
    }
    const foreign = upload(png);
    (foreign.headers as Record<string, string>).Origin = "https://evil.test";
    expect((await app.request(`/api/personas/${id}/portrait`, foreign)).status).toBe(403);
  });
});

describe("the boundary on the M4 routes", () => {
  it.each(["/api/personas", "/api/presets/prompt", "/api/presets/sampler", "/api/settings"])(
    "%s answers only a valid username with the key, and unsafe requests only from the exact origin",
    async (path) => {
      const { app } = setup();
      const noKey = ownerHeaders();
      delete noKey["X-Ephemera-Proxy-Key"];
      expect((await app.request(path, { headers: noKey })).status).toBe(403);
      expect(
        (await app.request(path, { headers: ownerHeaders({ "Remote-User": "Intruder" }) })).status,
      ).toBe(403);
      const foreign = await app.request(path, {
        method: path === "/api/settings" ? "PATCH" : "POST",
        headers: ownerHeaders({ Origin: "https://evil.test" }),
        body: "{}",
      });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );
});
