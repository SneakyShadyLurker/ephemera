import {
  ART_STREAM_TYPE,
  type ArtStreamEvent,
  blankCard,
  CREATOR_LIMITS,
  CREATOR_TAGS,
  type CreatorKind,
  decodeArtFrames,
  SCENE_METAPROMPTS,
  scenePrompt,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "../src/comfyui/workflow.ts";
import { usernameSchema } from "../src/identity.ts";
import { toPortrait, toSceneReference } from "../src/images.ts";
import { type FakeComfyuiOptions, fakeComfyui, fakePng, UPSTREAM_SECRET } from "./fake-comfyui.ts";
import {
  type CatalogEntry,
  catalogEntry,
  type FakeUpstreamOptions,
  fakeUpstream,
} from "./fake-upstream.ts";
import { postJson, TEST_USER, testApp } from "./helpers.ts";
import { imageMetadata } from "./image-fixtures.ts";
import { TEST_WORKFLOWS } from "./test-workflows.ts";
import { until } from "./vitest-helpers.ts";

const COMFY = "https://comfy.test:8188";
const SOURCE = "canary-scene-source-7d21 Ava: She takes off her coat by the lamp.";
const IMAGE_PROMPT = "canary-scene-image-prompt-4e90 a keeper by a lamp at night";
const UPSTREAM_TEXT = "upstream-error-text-scene-1b6c";

const withModalities = (input_modalities: unknown): CatalogEntry[] => [
  { ...catalogEntry("fake-model"), input_modalities },
];

interface Setup {
  upstream?: FakeUpstreamOptions;
  comfy?: FakeComfyuiOptions;
  /** The saved ComfyUI address; empty means none. */
  address?: string;
  /** The stored card's kind, by its tag. */
  kind?: CreatorKind;
  /** Whether the character has a stored portrait. */
  portrait?: boolean;
}

async function setup(options: Setup = {}) {
  const upstream = fakeUpstream({
    chunks: [IMAGE_PROMPT],
    catalog: withModalities(["text", "image"]),
    ...options.upstream,
  });
  const comfy = fakeComfyui(options.comfy);
  // One outbound fetch, as in app.ts: ComfyUI's host goes to the fake ComfyUI.
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === COMFY ? comfy.fetch(input, init) : upstream.fetch(input, init);
  };
  const { app, lines, instances } = testApp({
    fetch,
    comfyuiSocket: comfy.socket,
    workflows: TEST_WORKFLOWS,
  });
  const { stores } = instances.instance(TEST_USER);
  stores.settings.update({ comfyuiBaseUrl: options.address ?? COMFY });
  const card = blankCard("Ava");
  const characterId = stores.characters.create({
    ...card,
    tags: [CREATOR_TAGS[options.kind ?? "subject"]],
  });
  const stored = await toPortrait(fakePng(200, 300));
  if (options.portrait ?? true) stores.characters.setPortrait(characterId, stored);
  return { app, lines, upstream, comfy, stores, instances, characterId, stored };
}

const request = (characterId: string, extra: Record<string, unknown> = {}) => ({
  model: "fake-model",
  characterId,
  kind: "subject",
  source: SOURCE,
  workflow: "krea2-gonzalomo",
  ...extra,
});

async function sceneEvents(response: Response): Promise<ArtStreamEvent[]> {
  async function* chunks() {
    yield new Uint8Array(await response.arrayBuffer());
  }
  const all: ArtStreamEvent[] = [];
  for await (const event of decodeArtFrames(chunks())) {
    // The prompt call's receipt is the usage tests' subject (upstream.test.ts).
    if ("accounting" in event) {
      const { accounting: _accounting, ...rest } = event;
      all.push(rest);
    } else all.push(event);
  }
  return all;
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
/** The system and user messages as they went upstream. */
function sent(upstream: ReturnType<typeof fakeUpstream>) {
  const body = upstream.records[0]?.body as {
    messages: { role: string; content: Part[] | string }[];
    max_tokens?: number;
  };
  return {
    system: body.messages[0],
    user: body.messages.at(-1)?.content,
    maxTokens: body.max_tokens,
  };
}

const logged = (lines: string[], event: string) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.event === event);

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** No log line holds the source, the prompt, the picture, the portrait or the upstream's text. */
function expectContentFree(lines: string[], extra: string[] = []) {
  const log = lines.join("\n");
  for (const text of [SOURCE, IMAGE_PROMPT, UPSTREAM_SECRET, UPSTREAM_TEXT, ...extra]) {
    expect(log).not.toContain(text);
  }
}

describe("POST /api/scene", () => {
  it("streams binary PNGs with phase controls for the scene's one-image batch", async () => {
    const { app, comfy, characterId } = await setup({
      comfy: { mode: "private", silent: true },
    });
    const events = await sceneEvents(
      await app.request("/api/scene", postJson(request(characterId))),
    );
    expect(events.filter((event) => event.type === "image").map((event) => event.index)).toEqual([
      0,
    ]);
    expect(events.at(-1)).toEqual({ type: "done" });
    await expect.poll(() => comfy.clean()).toBe(true);
  });
  it("writes the scene's image prompt with the portrait, then streams one picture and done", async () => {
    const { app, lines, upstream, comfy, characterId } = await setup();
    const response = await app.request("/api/scene", postJson(request(characterId)));
    expect(response.headers.get("Content-Type")).toBe(ART_STREAM_TYPE);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const all = await sceneEvents(response);
    expect(all.slice(0, 2)).toEqual([
      { type: "progress", phase: "prompt", value: 0, max: 1 },
      { type: "progress", phase: "prompt", value: 1, max: 1 },
    ]);
    const png = Buffer.from(fakePng()).toString("base64");
    expect(all.filter((event) => event.type === "image")).toEqual([
      { type: "image", index: 0, png: new Uint8Array(fakePng()) },
    ]);
    expect(all.slice(-2).map((event) => event.type)).toEqual(["image", "done"]);

    const { system, user, maxTokens } = sent(upstream);
    expect(system).toEqual({ role: "system", content: SCENE_METAPROMPTS.krea2.subject });
    expect(maxTokens).toBe(CREATOR_LIMITS.maxOutputTokens);
    if (typeof user === "string" || user === undefined) throw new Error("expected parts");
    expect(user[0]?.type).toBe("image_url");
    expect(user[1]).toEqual({ type: "text", text: scenePrompt(SOURCE, true) });

    // A plain instance runs the text graph, one image, and never receives the portrait.
    const [graph] = [...comfy.state.prompts.values()] as WorkflowGraph[];
    expect(graph?.["4"]?.inputs.text).toBe(IMAGE_PROMPT);
    expect(graph?.["6"]?.inputs.batch_size).toBe(1);
    expect(comfy.state.requests.some((r) => r.url.includes("/inputs/"))).toBe(false);
    expect(logged(lines, "scene.end")).toMatchObject({
      model: "fake-model",
      reference: true,
      referenceGraph: false,
    });
    await until(() => comfy.clean());
    const url = user[0]?.type === "image_url" ? user[0].image_url.url : "";
    expectContentFree(lines, [png, url.slice(-200), characterId]);
  });

  it("uploads the portrait's top third to the private worker and runs the reference graph", async () => {
    const { app, lines, comfy, characterId, stored } = await setup({ comfy: { mode: "private" } });
    const all = await sceneEvents(await app.request("/api/scene", postJson(request(characterId))));
    expect(all.at(-1)).toEqual({ type: "done" });
    const crop = await toSceneReference(stored.png);
    const meta = await imageMetadata(Buffer.from(crop));
    expect(meta).toMatchObject({ format: "png", width: 200, height: 100 });
    const [upload] = comfy.state.uploads;
    expect(upload).toMatchObject({ bytes: crop.byteLength, sha256: sha256(crop) });
    const [graph] = [...comfy.state.prompts.values()] as WorkflowGraph[];
    const load = Object.values(graph ?? {}).find((node) => node.class_type === "AtelierLoadImage");
    expect(load?.inputs.image).toMatch(new RegExp(`^${upload?.lease}:[0-9a-f-]{36}$`));
    expect(JSON.stringify(graph)).toContain(IMAGE_PROMPT);
    expect(logged(lines, "scene.end")).toMatchObject({ reference: true, referenceGraph: true });
    await until(() => comfy.clean());
    expectContentFree(lines);
  });

  it("gives a text-only model no file part, while the private worker still gets the face", async () => {
    const { app, lines, upstream, comfy, characterId } = await setup({
      upstream: { catalog: withModalities(["text"]) },
      comfy: { mode: "private" },
    });
    const all = await sceneEvents(await app.request("/api/scene", postJson(request(characterId))));
    expect(all.at(-1)).toEqual({ type: "done" });
    expect(sent(upstream).user).toBe(scenePrompt(SOURCE, false));
    expect(comfy.state.uploads).toHaveLength(1);
    expect(logged(lines, "scene.end")).toMatchObject({ reference: false, referenceGraph: true });
    await until(() => comfy.clean());
  });

  it("sends a Scenario card's portrait nowhere and takes the stored card's kind over the request's", async () => {
    const { app, upstream, comfy, characterId } = await setup({
      kind: "scenario",
      comfy: { mode: "private" },
    });
    const all = await sceneEvents(
      await app.request("/api/scene", postJson(request(characterId, { kind: "subject" }))),
    );
    expect(all.at(-1)).toEqual({ type: "done" });
    const { system, user } = sent(upstream);
    expect(system).toEqual({ role: "system", content: SCENE_METAPROMPTS.krea2.scenario });
    expect(user).toBe(SOURCE);
    expect(comfy.state.uploads).toEqual([]);
    await until(() => comfy.clean());
  });

  it("writes a Group card's prompt with the group metaprompt and a MOSS workflow's with MOSS's", async () => {
    const { app, upstream, comfy, characterId } = await setup({
      kind: "group",
      comfy: { mode: "private", installedWorkflow: "moss-fixture" },
    });
    const all = await sceneEvents(
      await app.request("/api/scene", postJson(request(characterId, { workflow: "moss-fixture" }))),
    );
    expect(all.at(-1)).toEqual({ type: "done" });
    expect(sent(upstream).system).toEqual({
      role: "system",
      content: SCENE_METAPROMPTS.moss.group,
    });
    // MOSS has no reference graph: the text graph runs, and the portrait is not uploaded.
    expect(comfy.state.uploads).toEqual([]);
    await until(() => comfy.clean());
  });

  it("paints from the notes alone for a character without a portrait", async () => {
    const { app, upstream, comfy, characterId } = await setup({
      portrait: false,
      comfy: { mode: "private" },
    });
    const all = await sceneEvents(await app.request("/api/scene", postJson(request(characterId))));
    expect(all.at(-1)).toEqual({ type: "done" });
    expect(sent(upstream).user).toBe(SOURCE);
    expect(comfy.state.uploads).toEqual([]);
    await until(() => comfy.clean());
  });

  it.each([
    ["an unknown character", async () => crypto.randomUUID()],
    [
      "another user's character",
      async (instances: Awaited<ReturnType<typeof setup>>["instances"]) =>
        instances
          .instance(usernameSchema.parse("someone-else"))
          .stores.characters.create(blankCard("Bo")),
    ],
  ])("answers not_found for %s before any outbound call but the catalog", async (_, idOf) => {
    const { app, lines, upstream, comfy, instances } = await setup();
    const characterId = await idOf(instances);
    const all = await sceneEvents(await app.request("/api/scene", postJson(request(characterId))));
    expect(all).toEqual([{ type: "error", code: "not_found" }]);
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
    expectContentFree(lines, [characterId]);
  });

  it("answers not_configured without an address and not_allowed for a retired origin, sending nothing", async () => {
    for (const [address, code] of [
      ["", "not_configured"],
      ["https://retired.test:8188", "not_allowed"],
    ] as const) {
      const { app, upstream, comfy, characterId } = await setup({ address });
      const all = await sceneEvents(
        await app.request("/api/scene", postJson(request(characterId))),
      );
      expect(all).toEqual([{ type: "error", code }]);
      expect(upstream.records).toEqual([]);
      expect(comfy.state.requests).toEqual([]);
    }
  });

  it("refuses a bad body or an unknown workflow before calling anything", async () => {
    const { app, upstream, comfy, characterId } = await setup();
    for (const body of [
      request(characterId, { workflow: "krea2-removed" }),
      request(characterId, { extra: true }),
      request(characterId, { source: " " }),
      request("ava"),
    ]) {
      const response = await app.request("/api/scene", postJson(body));
      expect(response.status).toBe(400);
    }
    expect(upstream.records).toEqual([]);
    expect(comfy.state.requests).toEqual([]);
  });

  it("reports an upstream failure of the prompt call and never reaches ComfyUI", async () => {
    const { app, lines, comfy, characterId } = await setup({
      upstream: {
        failWith: { status: 400, body: JSON.stringify({ error: { message: UPSTREAM_TEXT } }) },
      },
    });
    const all = await sceneEvents(await app.request("/api/scene", postJson(request(characterId))));
    expect(all).toEqual([
      { type: "progress", phase: "prompt", value: 0, max: 1 },
      { type: "error", code: "upstream" },
    ]);
    expect(comfy.state.requests).toEqual([]);
    expectContentFree(lines);
  });

  it("reports a failed upload as comfyui, logging its reason only", async () => {
    const { app, lines, comfy, characterId } = await setup({
      comfy: { mode: "private", upload: "refused" },
    });
    const all = await sceneEvents(await app.request("/api/scene", postJson(request(characterId))));
    expect(all.at(-1)).toEqual({ type: "error", code: "comfyui" });
    expect(logged(lines, "scene.comfyui")).toMatchObject({ level: "error", errorClass: "upload" });
    await until(() => comfy.clean());
    expectContentFree(lines);
  });

  it("releases the lease and its input when the client leaves mid-paint, logged as ended", async () => {
    const { app, lines, comfy, characterId } = await setup({
      comfy: { mode: "private", hang: true },
    });
    const client = new AbortController();
    const response = await app.request(
      "/api/scene",
      postJson(request(characterId), { signal: client.signal }),
    );
    const reader = response.body?.getReader();
    await until(() => comfy.state.running !== undefined);
    client.abort();
    await reader?.cancel().catch(() => {});
    await until(() => comfy.state.released.length === 1 && comfy.clean());
    await until(() => lines.some((line) => line.includes('"event":"scene.abort"')));
    expect(comfy.state.inputs.size).toBe(0);
    expect(lines.filter((line) => line.includes('"level":"error"'))).toEqual([]);
  });
});
