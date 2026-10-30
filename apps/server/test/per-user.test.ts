import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blankCard,
  defaultPromptPreset,
  defaultSamplerPreset,
  type InspectedPrompt,
  PALETTE_ROLES,
  type ReworkEvent,
  reworkEventSchema,
} from "@ephemera/core";
import type { MiddlewareHandler } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.ts";
import {
  createInstanceRegistry,
  decryptSnapshot,
  ENCRYPTED_FILE,
  type InstanceRegistry,
  type InstanceRegistryOptions,
  writeEncryptedFile,
} from "../src/persistence/index.ts";
import { markStreaming } from "../src/streams.ts";
import { fakeUpstream } from "./fake-upstream.ts";
import {
  CLOCK,
  config,
  fileForm,
  formRequest,
  ownerHeaders,
  PICK_SEED,
  requestJson,
  TEST_USER,
  testApp,
} from "./helpers.ts";
import { plainPng } from "./image-fixtures.ts";

/*
 * Every admitted user gets their own instance (docs/ARCHITECTURE.md § Users
 * and storage): nothing one user stores, uploads or calibrates reaches another,
 * a user's folder appears only with their first admitted request, and every
 * write is on disk before the response that caused it completes.
 */

const OTHER = "bob";
const key = randomBytes(32);
const as = (user: string, extra: Record<string, string> = {}) =>
  ownerHeaders({ "Remote-User": user, ...extra });
const json = (user: string, method: string, body?: unknown): RequestInit =>
  requestJson(method, body, { headers: as(user) });
const upload = (user: string, bytes: Uint8Array): RequestInit =>
  formRequest("PUT", fileForm(bytes, "portrait.png"), as(user));
const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: "fake-model",
  clock: CLOCK,
  pickSeed: PICK_SEED,
  messages: [{ role: "user", content: "hello there" }],
  ...extra,
});

/** Every log line of every app a test built: none may name a user. */
const logs: string[][] = [];
function setup(deps: Parameters<typeof testApp>[0] = {}) {
  const built = testApp(deps);
  logs.push(built.lines);
  return built;
}

const registries: InstanceRegistry[] = [];

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ephemera-per-user-"));
});
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  const all = logs.splice(0).flat().join("\n");
  for (const user of [TEST_USER, OTHER, "carol"]) expect(all).not.toContain(user);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A registry over a fresh data directory, with a counted writer that can fail once. */
async function onDisk(options: Partial<InstanceRegistryOptions> = {}) {
  const dataDir = join(root, randomUUID());
  await mkdir(dataDir, { mode: 0o700 });
  const writes = { calls: 0, failNext: false };
  const lines: string[] = [];
  logs.push(lines);
  const instances = createInstanceRegistry({
    dataDir,
    key,
    log: createLogger((line) => lines.push(line)),
    write: async (path, bytes) => {
      writes.calls += 1;
      if (writes.failNext) {
        writes.failNext = false;
        throw new Error("disk full");
      }
      await writeEncryptedFile(path, bytes);
    },
    ...options,
  });
  registries.push(instances);
  /** The ids of the characters in a user's file, read as an outsider would. */
  const charactersOnDisk = async (username: string) => {
    const bytes = await readFile(join(dataDir, "users", username, ENCRYPTED_FILE));
    const raw = Database.deserialize(decryptSnapshot(bytes, { key, username }), { strict: true });
    const rows = raw.query<{ id: string }, []>("SELECT id FROM characters").all();
    raw.close();
    return rows.map((row) => row.id);
  };
  return { dataDir, instances, writes, charactersOnDisk };
}

describe("isolation between users", () => {
  it("keeps every entity, portrait and setting of one user out of another's reach", async () => {
    const { app } = setup();
    const fields = blankCard("Wren");
    const ids = {
      characters: randomUUID(),
      personas: randomUUID(),
      "presets/prompt": randomUUID(),
      "presets/sampler": randomUUID(),
    };
    const created = [
      ["characters", { id: ids.characters, fields }],
      ["personas", { id: ids.personas, fields: { name: "Aria", description: "A sailor." } }],
      ["presets/prompt", { id: ids["presets/prompt"], preset: defaultPromptPreset("Mine") }],
      ["presets/sampler", { id: ids["presets/sampler"], preset: defaultSamplerPreset("Mine") }],
    ] as const;
    for (const [kind, body] of created) {
      expect((await app.request(`/api/${kind}`, json(TEST_USER, "POST", body))).status).toBe(201);
    }
    for (const kind of ["characters", "personas"] as const) {
      const portrait = await app.request(
        `/api/${kind}/${ids[kind]}/portrait`,
        upload(TEST_USER, await plainPng()),
      );
      expect(portrait.status).toBe(200);
    }
    const patch = {
      characters: { description: "Changed.", revision: 0 },
      personas: { description: "Changed.", revision: 0 },
      "presets/prompt": { name: "Changed", revision: 0 },
      "presets/sampler": { name: "Changed", revision: 0 },
    };
    const theirs = (kind: keyof typeof ids) => `/api/${kind}/${ids[kind]}`;

    // The other user sees none of it and can change none of it.
    const list = async (user: string, kind: string) =>
      JSON.stringify(await (await app.request(`/api/${kind}`, { headers: as(user) })).json());
    expect(await list(OTHER, "characters")).toBe('{"characters":[]}');
    expect(await list(OTHER, "personas")).toBe('{"personas":[]}');
    for (const kind of ["presets/prompt", "presets/sampler"] as const) {
      expect(await list(OTHER, kind)).not.toContain(ids[kind]);
      expect(await list(TEST_USER, kind)).toContain(ids[kind]);
    }
    for (const kind of Object.keys(ids) as (keyof typeof ids)[]) {
      const requests: [string, RequestInit][] = [
        [theirs(kind), { headers: as(OTHER) }],
        [theirs(kind), json(OTHER, "PATCH", patch[kind])],
        [`${theirs(kind)}/duplicate`, json(OTHER, "POST")],
        [theirs(kind), json(OTHER, "DELETE")],
      ];
      if (kind === "characters" || kind === "personas") {
        requests.push(
          [`${theirs(kind)}/portrait/image`, { headers: as(OTHER) }],
          [`${theirs(kind)}/portrait/image?size=full&v=1`, { headers: as(OTHER) }],
          [`${theirs(kind)}/portrait`, json(OTHER, "DELETE")],
          [`${theirs(kind)}/portrait`, upload(OTHER, await plainPng())],
        );
      }
      for (const [path, init] of requests) {
        const response = await app.request(path, init);
        expect(`${init.method ?? "GET"} ${path} ${response.status}`).toBe(
          `${init.method ?? "GET"} ${path} 404`,
        );
      }
    }
    const bind = await app.request(
      `/api/personas/bindings/${ids.characters}`,
      json(OTHER, "PUT", { personaId: ids.personas }),
    );
    expect(bind.status).toBe(404);

    // The owner's entities are untouched, portraits included.
    for (const kind of Object.keys(ids) as (keyof typeof ids)[]) {
      expect((await app.request(theirs(kind), { headers: as(TEST_USER) })).status).toBe(200);
    }
    for (const kind of ["characters", "personas"] as const) {
      const portrait = await app.request(`${theirs(kind)}/portrait/image`, {
        headers: as(TEST_USER),
      });
      expect(portrait.status).toBe(200);
    }
    expect(await list(TEST_USER, "characters")).toContain(ids.characters);
    expect(await list(TEST_USER, "personas")).toContain(ids.personas);
  });

  it("keeps one user's lorebooks and their links out of another's reach", async () => {
    const { app } = setup({ fetch: fakeUpstream({ chunks: ["Aye."] }).fetch });
    const fields = blankCard("Wren");
    const character = randomUUID();
    const book = randomUUID();
    const marker = "canary-lorebook-per-user-41c2";
    expect(
      (await app.request("/api/characters", json(TEST_USER, "POST", { id: character, fields })))
        .status,
    ).toBe(201);
    expect(
      (
        await app.request(
          "/api/lorebooks",
          json(TEST_USER, "POST", {
            id: book,
            name: marker,
            book: {
              entries: [
                {
                  keys: [],
                  content: marker,

                  enabled: true,
                  insertionOrder: 100,
                  useRegex: false,
                  constant: true,
                },
              ],
            },
          }),
        )
      ).status,
    ).toBe(201);
    const link = `/api/lorebooks/${book}/characters/${character}`;
    expect((await app.request(link, json(TEST_USER, "PUT"))).status).toBe(204);

    const list = async (user: string) =>
      JSON.stringify(await (await app.request("/api/lorebooks", { headers: as(user) })).json());
    expect(await list(OTHER)).toBe('{"lorebooks":[],"embedded":[],"links":[]}');
    const theirs = `/api/lorebooks/${book}`;
    const requests: [string, RequestInit][] = [
      [theirs, { headers: as(OTHER) }],
      [theirs, json(OTHER, "PATCH", { revision: 0, name: "Changed" })],
      [`${theirs}/duplicate`, json(OTHER, "POST")],
      [`${theirs}/export`, { headers: as(OTHER) }],
      [link, json(OTHER, "PUT")],
      [link, json(OTHER, "DELETE")],
      [theirs, json(OTHER, "DELETE")],
    ];
    for (const [path, init] of requests) {
      const response = await app.request(path, init);
      expect(`${init.method ?? "GET"} ${path} ${response.status}`).toBe(
        `${init.method ?? "GET"} ${path} 404`,
      );
    }

    // A chat naming the owner's character reads their linked book for them alone.
    const preview = async (user: string) =>
      (
        await app.request(
          "/api/chat/preview",
          json(user, "POST", chatBody({ characterId: character })),
        )
      ).text();
    expect(await preview(TEST_USER)).toContain(marker);
    expect(await preview(OTHER)).not.toContain(marker);

    // The owner's book and link are untouched.
    expect(await list(TEST_USER)).toContain(marker);
    expect(await list(TEST_USER)).toContain(`"lorebookIds":["${book}"]`);
  });

  it("never answers one user's portrait validator with a 304 for another", async () => {
    const { app } = setup();
    const fields = blankCard("Wren");
    const id = randomUUID();
    const versions: Record<string, number> = {};
    // The same entity id and portrait version (a timestamp) in two instances.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 1) });
    for (const user of [TEST_USER, OTHER]) {
      const body = { id, fields };
      expect((await app.request("/api/characters", json(user, "POST", body))).status).toBe(201);
      const put = await app.request(
        `/api/characters/${id}/portrait`,
        upload(user, await plainPng()),
      );
      versions[user] = ((await put.json()) as { portrait: number }).portrait;
    }
    vi.useRealTimers();
    expect(versions[OTHER]).toBe(versions[TEST_USER]);
    const url = `/api/characters/${id}/portrait/image?size=thumb&v=${versions[TEST_USER]}`;
    const tagOf = async (user: string) =>
      (await app.request(url, { headers: as(user) })).headers.get("ETag") ?? "";
    const mine = await tagOf(TEST_USER);
    const theirs = await tagOf(OTHER);
    expect(mine).toMatch(/^"[0-9a-f]{32}"$/);
    expect(theirs).toMatch(/^"[0-9a-f]{32}"$/);
    expect(theirs).not.toBe(mine);

    const replayed = await app.request(url, { headers: as(OTHER, { "If-None-Match": mine }) });
    expect(replayed.status).toBe(200);
    expect((await replayed.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // A user without the portrait gets 404, whatever validator they send.
    const missing = await app.request(url, { headers: as("carol", { "If-None-Match": mine }) });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store, no-transform");
  });

  it("gives each user their own settings, theme and identity on the HTML pages", async () => {
    const page =
      (title: string): MiddlewareHandler =>
      async (c) =>
        c.html(`<!doctype html><html lang="en"><title>${title}</title></html>`);
    const { app } = setup({ appShell: page("shell"), renewalPage: page("renewed") });
    const settings = async (user: string) =>
      (
        (await (await app.request("/api/settings", { headers: as(user) })).json()) as {
          settings: Record<string, unknown>;
        }
      ).settings;
    const defaults = await settings(OTHER);
    const patched = await app.request("/api/settings", json(TEST_USER, "PATCH", { theme: "dark" }));
    expect(patched.status).toBe(200);
    expect(await settings(OTHER)).toEqual(defaults);
    expect((await settings(TEST_USER)).theme).toBe("dark");

    const html = async (path: string, user: string) =>
      (await app.request(path, { headers: as(user) })).text();
    expect(await html("/characters", TEST_USER)).toContain(
      `<html lang="en" data-theme="dark" data-user="${TEST_USER}">`,
    );
    expect(await html("/characters", OTHER)).toContain(`<html lang="en" data-user="${OTHER}">`);
    expect(await html("/auth/renewed", OTHER)).toContain(`<html lang="en" data-user="${OTHER}">`);
  });

  it("serves each user only their own custom palettes and stylesheet", async () => {
    const { app } = setup();
    const scheme = Object.fromEntries(PALETTE_ROLES.map((role) => [role, "#123456"]));
    const palette = {
      name: "Mine",
      base: "nord",
      light: scheme,
      dark: scheme,
      origin: { light: scheme, dark: scheme },
      handSet: { light: [], dark: [] },
    };
    expect((await app.request("/api/palettes/1", json(TEST_USER, "POST", palette))).status).toBe(
      200,
    );
    const css = async (user: string) =>
      (await app.request("/api/palettes.css", { headers: as(user) })).text();
    expect(await css(TEST_USER)).toContain("#123456");
    expect(await css(OTHER)).toBe("");
    expect(await (await app.request("/api/palettes", { headers: as(OTHER) })).json()).toEqual({
      palettes: [],
    });
    expect((await app.request("/api/palettes/1?updatedAt=1", json(OTHER, "DELETE"))).status).toBe(
      404,
    );
  });

  it("calibrates each user's estimates by their own replies only", async () => {
    const upstream = fakeUpstream({
      chunks: ["Aye."],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1 },
    });
    const { app } = setup({ fetch: upstream.fetch });
    const body = chatBody({ messages: [{ role: "user", content: "word ".repeat(1_500) }] });
    const estimate = async (user: string) =>
      (
        (await (await app.request("/api/chat/preview", json(user, "POST", body))).json()) as {
          prompt: InspectedPrompt;
        }
      ).prompt.estimate;
    const uncalibrated = await estimate(TEST_USER);
    await (await app.request("/api/chat", json(TEST_USER, "POST", body))).text();
    expect(await estimate(TEST_USER)).toBeGreaterThan(uncalibrated * 1.9);
    expect(await estimate(OTHER)).toBe(uncalibrated);
  });

  it("answers chat and preview naming another user's entities as if they did not exist", async () => {
    const upstream = fakeUpstream({ chunks: ["Aye."] });
    const { app, instances } = setup({ fetch: upstream.fetch });
    const mine = instances.instance(TEST_USER).stores;
    const marker = "canary-per-user-3a9e";
    const theirIds = {
      characterId: mine.characters.create({ ...blankCard("Mara"), description: marker }),
      personaId: mine.personas.create({ name: "Aria", description: marker }, randomUUID()),
      promptPresetId: mine.presets.prompt.create(
        { ...defaultPromptPreset("Mine"), name: marker },
        randomUUID(),
      ),
      samplerPresetId: mine.presets.sampler.create(
        { ...defaultSamplerPreset("Mine"), values: { ...defaultSamplerPreset().values, seed: 7 } },
        randomUUID(),
      ),
    };
    const unknownIds = {
      characterId: randomUUID(),
      personaId: randomUUID(),
      promptPresetId: randomUUID(),
      samplerPresetId: randomUUID(),
    };
    const preview = async (ids: Record<string, string>) =>
      (await app.request("/api/chat/preview", json(OTHER, "POST", chatBody(ids)))).text();
    expect(await preview(theirIds)).toBe(await preview(unknownIds));
    expect(await preview(theirIds)).not.toContain(marker);

    await (await app.request("/api/chat", json(OTHER, "POST", chatBody(theirIds)))).text();
    await (await app.request("/api/chat", json(OTHER, "POST", chatBody(unknownIds)))).text();
    const [theirs, unknown] = upstream.records.map((record) => JSON.stringify(record.body));
    expect(theirs).toBe(unknown);
    expect(theirs).not.toContain(marker);
    expect(theirs).not.toContain('"seed":7');
  });

  it("answers creator and rework requests naming another user's entities as if they did not exist", async () => {
    const upstream = fakeUpstream({ chunks: ["<name>Ada</name>"] });
    const { app, instances } = setup({ fetch: upstream.fetch });
    const mine = instances.instance(TEST_USER).stores;
    const marker = "canary-per-user-creator-71bd";
    const personaId = mine.personas.create({ name: "Kai", description: marker }, randomUUID());
    const characterId = mine.characters.create({ ...blankCard("Ada"), description: marker });
    mine.characters.setPortrait(characterId, {
      png: new Uint8Array(await plainPng()),
      thumb: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      width: 30,
      height: 45,
    });

    const card = (id: string) =>
      app.request(
        "/api/creator/card",
        json(OTHER, "POST", {
          kind: "subject",
          description: "a lighthouse keeper",
          model: "fake-model",
          personaId: id,
        }),
      );
    // Each request's calls (an unusable answer is written once more) as the upstream received
    // them, without the request's own random cache key.
    const sent = async (id: string) => {
      const before = upstream.records.length;
      await (await card(id)).text();
      return JSON.stringify(
        upstream.records.slice(before).map(({ body }) => ({
          ...(body as object),
          prompt_cache_key: undefined,
        })),
      );
    };
    const theirs = await sent(personaId);
    const unknown = await sent(randomUUID());
    expect(theirs).toBe(unknown);
    expect(theirs).not.toContain(marker);
    const calls = upstream.records.length;

    const rework = await app.request(
      "/api/creator/rework",
      json(OTHER, "POST", {
        characterId,
        personaId,
        model: "fake-model",
        request: "make her older",
        portrait: true,
        card: {
          name: "Ada",
          description: "",
          personality: "",
          scenario: "",
          firstMessage: "",
          alternateGreetings: [],
          exampleDialogue: "",
          systemPrompt: "",
          postHistoryInstructions: "",
          creatorNotes: "",
          tags: [],
          characterNote: null,
          lorebook: null,
        },
      }),
    );
    const events = (await rework.text())
      .split("\n")
      .filter((line) => line !== "")
      .map((line): ReworkEvent => reworkEventSchema.parse(JSON.parse(line)));
    expect(events).toEqual([{ type: "error", code: "not_found" }]);
    // Neither the character, nor its portrait, nor the persona went anywhere.
    expect(upstream.records).toHaveLength(calls);
  });
});

describe("instances on disk", () => {
  it("creates a user's folder only with their first admitted request", async () => {
    const { dataDir, instances } = await onDisk();
    const { app } = setup({ instances });
    const users = join(dataDir, "users");
    expect(existsSync(users)).toBe(false);

    const refused: [Record<string, string>, number][] = [
      [{ ...as("carol"), "X-Ephemera-Proxy-Key": "wrong".repeat(10) }, 403],
      [as("Carol"), 403],
      [as("carol", { "X-Ephemera-User": OTHER }), 412],
    ];
    for (const [headers, status] of refused) {
      expect((await app.request("/api/settings", { headers })).status).toBe(status);
    }
    expect(existsSync(users)).toBe(false);

    expect((await app.request("/api/settings", { headers: as("carol") })).status).toBe(200);
    expect(await readdir(users)).toEqual(["carol"]);
    expect((await readdir(join(users, "carol"))).sort()).toEqual([ENCRYPTED_FILE, "portraits"]);
  });

  it("has a created entity in the user's file before the response completes", async () => {
    const { instances, charactersOnDisk } = await onDisk();
    const { app } = setup({ instances });
    const fields = blankCard("Wren");
    const id = randomUUID();
    const created = await app.request("/api/characters", json(TEST_USER, "POST", { id, fields }));
    expect(created.status).toBe(201);
    expect(await charactersOnDisk(TEST_USER)).toEqual([id]);
  });

  it("answers 500 when the write cannot be flushed, and the next request flushes it", async () => {
    const { instances, writes, charactersOnDisk } = await onDisk();
    const { app, lines } = setup({ instances });
    expect((await app.request("/api/settings", { headers: as(TEST_USER) })).status).toBe(200);
    writes.failNext = true;
    const fields = blankCard("Wren");
    const id = randomUUID();
    const created = await app.request("/api/characters", json(TEST_USER, "POST", { id, fields }));
    expect(created.status).toBe(500);
    expect(await created.json()).toEqual({ error: "internal" });
    expect(created.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(lines.join("\n")).toContain('"event":"instance.flush","errorClass":"Error"');
    expect(await charactersOnDisk(TEST_USER)).toEqual([]);

    expect((await app.request("/api/characters", { headers: as(TEST_USER) })).status).toBe(200);
    expect(await charactersOnDisk(TEST_USER)).toEqual([id]);
  });

  it("flushes a streamed chat at its end and releases the instance", async () => {
    let clock = 0;
    const { instances, writes, dataDir } = await onDisk({
      idleMs: 1_000,
      sweepMs: 5,
      now: () => clock,
    });
    const { app } = setup({ instances, fetch: fakeUpstream({ chunks: ["Aye."] }).fetch });
    const response = await app.request("/api/chat", json(TEST_USER, "POST", chatBody()));
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain("Aye.");
    // A new instance is written once, at the stream's end, and nothing is left to flush.
    expect(writes.calls).toBe(1);
    expect(existsSync(join(dataDir, "users", TEST_USER, ENCRYPTED_FILE))).toBe(true);
    await instances.instance(TEST_USER).flushIfDirty();
    expect(writes.calls).toBe(1);
    // Nothing holds it in use any more: it is evicted once idle.
    clock += 2_000;
    await vi.waitFor(() => expect(instances.size).toBe(0));
  });

  /**
   * A registry whose idle clock the test moves, an app over it, and a stream
   * from `request` read up to its first chunk; the stream is left open.
   */
  async function openStream(
    deps: Parameters<typeof testApp>[0],
    request: (app: ReturnType<typeof testApp>["app"]) => Response | Promise<Response>,
  ) {
    const clock = { now: 0 };
    const disk = await onDisk({ idleMs: 1_000, sweepMs: 5, now: () => clock.now });
    const { app } = setup({ ...deps, instances: disk.instances });
    const response = await request(app);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no stream");
    expect((await reader.read()).done).toBe(false);
    // A write the request's instance holds, made while the stream runs; nothing flushed it yet.
    const id = disk.instances.instance(TEST_USER).stores.characters.create(blankCard("Late"));
    expect(existsSync(join(disk.dataDir, "users", TEST_USER, ENCRYPTED_FILE))).toBe(false);
    return { ...disk, clock, reader, id };
  }

  it("flushes a streamed chat the client aborts mid-stream and releases the instance", async () => {
    const { instances, charactersOnDisk, clock, reader, id } = await openStream(
      { fetch: fakeUpstream({ chunks: ["Aye."], hang: true }).fetch },
      (app) => app.request("/api/chat", json(TEST_USER, "POST", chatBody())),
    );
    await reader.cancel();
    // The idle clock has not moved, so only the cancel can have written it.
    await vi.waitFor(async () => expect(await charactersOnDisk(TEST_USER)).toEqual([id]));
    expect(instances.size).toBe(1);
    clock.now += 2_000;
    await vi.waitFor(() => expect(instances.size).toBe(0));
  });

  it("flushes a stream whose source errors mid-stream and releases the instance", async () => {
    let fail: (error: Error) => void = () => {};
    const source: MiddlewareHandler = async (c) => {
      // A streamed response, as its route marks it (streams.ts).
      markStreaming(c);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            fail = (error) => controller.error(error);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const { instances, charactersOnDisk, clock, reader, id } = await openStream(
      { staticFiles: [source] },
      (app) => app.request("/stream", { headers: as(TEST_USER) }),
    );
    fail(new Error("source failed"));
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(async () => expect(await charactersOnDisk(TEST_USER)).toEqual([id]));
    expect(instances.size).toBe(1);
    clock.now += 2_000;
    await vi.waitFor(() => expect(instances.size).toBe(0));
  });

  it("errors a stream whose closing flush fails, and still releases the instance", async () => {
    let clock = 0;
    const { instances, writes } = await onDisk({
      idleMs: 1_000,
      sweepMs: 5,
      now: () => clock,
    });
    const { app, lines } = setup({ instances, fetch: fakeUpstream({ chunks: ["Aye."] }).fetch });
    writes.failNext = true;
    const response = await app.request("/api/chat", json(TEST_USER, "POST", chatBody()));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(lines.join("\n")).toContain('"event":"instance.flush","errorClass":"Error"');
    clock += 2_000;
    await vi.waitFor(() => expect(instances.size).toBe(0));
    // The eviction's own flush wrote what the failed one could not.
    expect(writes.calls).toBe(2);
  });
});

describe("GET /api/health", () => {
  it("needs the proxy key only and touches no instance", async () => {
    const { dataDir, instances } = await onDisk();
    const { app } = setup({ instances });
    const healthy = await app.request("/api/health", {
      headers: { "X-Ephemera-Proxy-Key": config.proxyKey },
    });
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ ok: true });
    expect(healthy.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const refused = await app.request("/api/health");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden" });
    expect(existsSync(join(dataDir, "users"))).toBe(false);
    expect(instances.size).toBe(0);
  });
});
