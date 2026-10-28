import { defaultPromptPreset, defaultSamplerPreset, importPresetFile } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { fakeUpstream } from "./fake-upstream.ts";
import { ownerHeaders, TEST_USER, testApp } from "./helpers.ts";

function setup() {
  const upstream = fakeUpstream({ models: ["kimi-k3"] });
  const { app, lines, instances } = testApp({ fetch: upstream.fetch });
  const { stores } = instances.instance(TEST_USER);
  return { app, lines, stores };
}

const post = (body: unknown, headers = ownerHeaders()): RequestInit => ({
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

/** A small SillyTavern Chat Completion preset, synthetic. */
const stFile = {
  temperature: 0.8,
  top_k: 40,
  custom_model: "kimi-k3",
  prompts: [
    { identifier: "main", role: "system", content: "Be {{char}}.", system_prompt: true },
    { identifier: "chatHistory", marker: true, system_prompt: true },
    { identifier: "x1", name: "Tone", role: "user", content: "Slow.", injection_position: 0 },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "x1", enabled: true },
        { identifier: "chatHistory", enabled: true },
      ],
    },
  ],
};

describe("POST /api/presets/import", () => {
  it("creates a prompt preset and a sampler preset from one SillyTavern file, once", async () => {
    const { app, stores } = setup();
    const promptId = crypto.randomUUID();
    const samplerId = crypto.randomUUID();
    const body = { promptId, samplerId, name: "Harbourlight", file: stFile };
    const response = await app.request("/api/presets/import", post(body));
    expect(response.status).toBe(201);
    const { report } = (await response.json()) as { report: { skipped: string[] } };
    expect(report.skipped.join("\n")).toContain("Top K");

    expect(stores.presets.prompt.get(promptId)).toMatchObject({ name: "Harbourlight" });
    expect(stores.presets.sampler.get(samplerId)?.values).toMatchObject({
      temperature: 0.8,
      model: "kimi-k3",
    });
    // A retried import writes nothing new.
    expect((await app.request("/api/presets/import", post(body))).status).toBe(201);
    expect(stores.presets.prompt.list()).toHaveLength(2);
    expect(stores.presets.sampler.list()).toHaveLength(2);
  });

  it.each([
    ["not a preset", { spec: "chara_card_v2" }, "not_a_preset"],
    [
      "a prompt too long",
      {
        prompts: [{ identifier: "main", content: "x".repeat(256 * 1024 + 1) }],
      },
      "too_large",
    ],
  ])("refuses %s without writing or logging content", async (_label, file, error) => {
    const { app, stores, lines } = setup();
    const response = await app.request(
      "/api/presets/import",
      post({ promptId: crypto.randomUUID(), samplerId: crypto.randomUUID(), name: "N", file }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
    expect(stores.presets.prompt.list()).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("xxxx");
  });

  it("refuses bad ids and names, and requests from another origin", async () => {
    const { app } = setup();
    const valid = { promptId: crypto.randomUUID(), samplerId: crypto.randomUUID(), name: "N" };
    for (const body of [
      { ...valid, promptId: "x", file: stFile },
      { ...valid, name: "", file: stFile },
      { ...valid, samplerId: valid.promptId, file: stFile },
    ]) {
      expect((await app.request("/api/presets/import", post(body))).status).toBe(400);
    }
    const foreign = post({ ...valid, file: stFile }, ownerHeaders({ Origin: "https://evil.test" }));
    expect((await app.request("/api/presets/import", foreign)).status).toBe(403);
  });
});

describe("independent native preset exports", () => {
  it.each(["prompt", "sampler"] as const)(
    "exports and imports a native %s without creating the other kind",
    async (kind) => {
      const { app, stores } = setup();
      const id =
        kind === "prompt"
          ? stores.presets.prompt.create(defaultPromptPreset("Mine: v2"), crypto.randomUUID())
          : stores.presets.sampler.create(
              { name: "Warm", values: { ...defaultSamplerPreset().values, temperature: 0.7 } },
              crypto.randomUUID(),
            );
      const response = await app.request(`/api/presets/${kind}/${id}/export`, {
        headers: ownerHeaders(),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toContain("attachment");
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
      const file = await response.json();
      expect(file).toMatchObject({ format: `ephemera.${kind}-preset`, version: 1 });
      expect(JSON.stringify(file)).not.toContain("createdAt");
      expect(
        importPresetFile(file, "Ignored", { newId: () => crypto.randomUUID(), models: [] }).ok,
      ).toBe(true);
      const counts = [stores.presets.prompt.list().length, stores.presets.sampler.list().length];
      const promptId = crypto.randomUUID(),
        samplerId = crypto.randomUUID();
      const body = { promptId, samplerId, name: "Ignored", file };
      for (let retry = 0; retry < 2; retry++) {
        const imported = await app.request("/api/presets/import", post(body));
        expect(imported.status).toBe(201);
        expect(await imported.json()).toMatchObject({
          format: kind,
          id: kind === "prompt" ? promptId : samplerId,
          name: kind === "prompt" ? "Mine: v2" : "Warm",
          report: { kept: [], changed: [], skipped: [] },
        });
      }
      expect(stores.presets.prompt.list()).toHaveLength(
        (counts[0] ?? 0) + Number(kind === "prompt"),
      );
      expect(stores.presets.sampler.list()).toHaveLength(
        (counts[1] ?? 0) + Number(kind === "sampler"),
      );
    },
  );
  it.each(["prompt", "sampler"])(
    "answers missing and malformed %s ids and removes the paired endpoint",
    async (kind) => {
      const { app } = setup();
      expect(
        (
          await app.request(`/api/presets/${kind}/${crypto.randomUUID()}/export`, {
            headers: ownerHeaders(),
          })
        ).status,
      ).toBe(404);
      expect(
        (await app.request(`/api/presets/${kind}/x/export`, { headers: ownerHeaders() })).status,
      ).toBe(400);
      expect(
        (await app.request("/api/presets/export?prompt=x&sampler=y", { headers: ownerHeaders() }))
          .status,
      ).toBe(404);
    },
  );
});

describe("owner-set context windows", () => {
  it("are saved with the settings and replaced as a whole", async () => {
    const { app } = setup();
    const patch = (body: unknown) =>
      app.request("/api/settings", {
        method: "PATCH",
        headers: ownerHeaders(),
        body: JSON.stringify(body),
      });
    const saved = await patch({ contextWindows: { "no-window": 32_768 } });
    expect(await saved.json()).toMatchObject({
      settings: { contextWindows: { "no-window": 32_768 } },
    });
    const replaced = await patch({ contextWindows: {} });
    expect(await replaced.json()).toMatchObject({ settings: { contextWindows: {} } });
    expect((await patch({ contextWindows: { a: 12 } })).status).toBe(400);
  });
});
