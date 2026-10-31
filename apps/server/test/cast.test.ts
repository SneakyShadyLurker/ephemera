import { createHash } from "node:crypto";
import {
  applyCastChanges,
  blankCard,
  CAST_LIMITS,
  type CastEntry,
  type CastRegister,
  type CharacterCard,
  castChangesSchema,
  castFingerprintInput,
  castSheetResponseSchema,
  castUpdateResponseSchema,
  emptyCastAnchor,
  emptyCastState,
  KEEPER_OPENING,
  MEMORY_LIMITS,
  SHEET_OPENING,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import type { Stores } from "../src/persistence/index.ts";
import { countMessage, PRIMING } from "../src/tokens.ts";
import {
  type CatalogEntry,
  catalogEntry,
  FAKE_KEEPER_CHANGES,
  FAKE_SHEET_ANSWER,
  type FakeTurn,
  fakeUpstream,
} from "./fake-upstream.ts";
import { ownerHeaders, postJson, TEST_USER, testApp } from "./helpers.ts";
import { until } from "./vitest-helpers.ts";

const TURN_CANARY = "turn-canary-3b91";
const CANON_CANARY = "canon-canary-c7d2";
const BODY_CANARY = "upstream-body-canary-9e04";

const card: CharacterCard = {
  ...blankCard("Maren"),
  description: `Maren Holt keeps the harbour bar. ${CANON_CANARY}`,
};
const fingerprintOf = (of: CharacterCard) =>
  createHash("sha256").update(castFingerprintInput(of)).digest("hex");

const answer = (value: unknown): FakeTurn => ({ chunks: [JSON.stringify(value)] });
/** An answer with no JSON object in it. */
const unusable: FakeTurn = { chunks: [`I cannot. ${BODY_CANARY}`] };
/** A busy provider that asks for no wait, so the AI SDK's retries run at once. */
const busy: FakeTurn = {
  failWith: { status: 503, body: BODY_CANARY, headers: { "Retry-After": "0" } },
};

/**
 * The app over a fake upstream: completions answer `turns` in order, then
 * the deterministic keeper and sheet answers. `before` holds a completion
 * until it settles.
 */
function setup(
  turns: FakeTurn[] = [],
  options: { before?: () => Promise<void>; catalog?: CatalogEntry[]; withoutUsage?: boolean } = {},
) {
  const upstream = fakeUpstream({
    turns,
    ...(options.withoutUsage ? { withoutUsage: true } : {}),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  let calls = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/chat/completions")) {
      calls += 1;
      await options.before?.();
      // As a real fetch: a call aborted while held never reaches the provider.
      init?.signal?.throwIfAborted();
    }
    return upstream.fetch(input, init);
  };
  const { app, lines, instances } = testApp({ fetch });
  const stores: Stores = instances.instance(TEST_USER).stores;
  const characterId = stores.characters.create(card);
  return { app, lines, stores, upstream, characterId, calls: () => calls };
}

const entry = (index: number): CastEntry => ({
  id: crypto.randomUUID(),
  role: "minor",
  anchor: emptyCastAnchor(`Guest ${index}`, "male"),
  aka: [],
  state: emptyCastState(true),
});

/** A stored sheet's one person: a sheet entry is an entry without its state. */
const { state: _state, ...SHEET_PERSON } = entry(0);

const update = (characterId: string | undefined, extra: Record<string, unknown> = {}) => ({
  ...(characterId === undefined ? {} : { characterId }),
  model: "fake-model",
  mode: "update",
  sheetFingerprint: null,
  register: { entries: [entry(0)] } satisfies CastRegister,
  turns: [
    { role: "user", content: `Ilse walks in. ${TURN_CANARY}` },
    { role: "assistant", content: "Ilse orders a drink." },
  ],
  ...extra,
});

type App = ReturnType<typeof setup>["app"];
const postUpdate = (app: App, body: unknown) => app.request("/api/cast/update", postJson(body));
const postSheet = (app: App, characterId: string, extra: Record<string, unknown> = {}) =>
  app.request(`/api/cast/sheets/${characterId}`, postJson({ model: "fake-model", ...extra }));
const getSheet = (app: App, characterId: string) =>
  app.request(`/api/cast/sheets/${characterId}`, { headers: ownerHeaders() });

/** The system and user text of completion `index`. */
const sent = (upstream: ReturnType<typeof setup>["upstream"], index: number) => {
  const body = upstream.records[index]?.body as {
    max_tokens: number;
    messages: { role: string; content: string }[];
  };
  const text = (role: string) => body.messages.find((message) => message.role === role)?.content;
  return { body, system: text("system") ?? "", user: text("user") ?? "" };
};

const noCanary = (lines: string[]) => {
  for (const line of lines) {
    expect(line).not.toContain(TURN_CANARY);
    expect(line).not.toContain(CANON_CANARY);
    expect(line).not.toContain(BODY_CANARY);
    expect(line).not.toContain("Ilse");
  }
};

describe("cast keeper", () => {
  it("keeps a Scenario NPC when one discovery lacks its basis", async () => {
    const text = "Ilse Brandt sets a glass on the bar. Her cropped black hair catches the light.";
    const keeperAnswer = {
      cast: {
        "Ilse Brandt": {
          role: "minor",
          gender: "female",
          anchor: {
            age: "29",
            ethnicity: "German",
            skin: "fair skin",
            face: "oval face, straight nose, full lips",
            relationship: "single",
            height: "168cm",
            weight: "60kg",
            build: "slim build",
            hair: "cropped black hair",
            eyes: "grey almond-shaped eyes",
            personality: "observant, patient, direct",
          },
          state: { present: true, outfit: "white cotton shirt", activity: "serving a drink" },
          introduce: { evidence: "Ilse Brandt sets a glass on the bar." },
          discovered: {
            hair: { value: "cropped black hair", basis: "seen", evidence: "cropped black hair" },
            age: { value: "late twenties", evidence: "Ilse Brandt sets a glass" },
          },
        },
      },
      absent: [],
    };
    // Repeating a plausible answer must not lose the valid NPC to one malformed discovery.
    const { app, stores, upstream, calls } = setup([answer(keeperAnswer), answer(keeperAnswer)]);
    const scenario = { ...card, name: "Harbour", tags: ["Scenario"] };
    const characterId = stores.characters.create(scenario);
    const fingerprint = fingerprintOf(scenario);
    stores.castSheets.put(characterId, { fingerprint, entries: [] });
    const response = await postUpdate(
      app,
      update(characterId, {
        register: { entries: [] },
        sheetFingerprint: fingerprint,
        turns: [{ role: "assistant", content: text }],
      }),
    );
    const body = await response.json();
    expect(body).toHaveProperty("changes");
    const { changes } = castUpdateResponseSchema.parse(body);
    const register = applyCastChanges({ entries: [] }, changes, {
      player: null,
      newId: () => crypto.randomUUID(),
      shown: [text],
    });
    expect(register.entries).toHaveLength(1);
    expect(register.entries[0]).toMatchObject({
      introduced: true,
      anchor: { name: "Ilse Brandt", gender: "female", age: "29" },
      discovered: { hair: keeperAnswer.cast["Ilse Brandt"].discovered.hair },
    });
    expect(register.entries[0]?.discovered).not.toHaveProperty("age");
    expect(sent(upstream, 0).user).toContain(CANON_CANARY);
    expect(calls()).toBe(1);
  });

  it("negotiates every repair attempt at settlement and sizes the actual repair conversation", async () => {
    const { app, upstream, characterId } = setup([unusable, answer(FAKE_KEEPER_CHANGES)], {
      catalog: [{ ...catalogEntry("small"), context_window: 24_000 }],
    });
    const response = await app.request(
      "/api/cast/update",
      postJson(update(characterId, { model: "small" })),
    );
    const body = castUpdateResponseSchema.parse(await response.json());
    expect(body.accounting?.calls).toHaveLength(2);
    expect(new Set(body.accounting?.calls.map((call) => call.id)).size).toBe(2);
    expect(body.accounting?.calls.map((call) => call.status)).toEqual(["completed", "completed"]);
    const repair = sent(upstream, 1).body;
    expect(repair.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    const input =
      PRIMING +
      repair.messages.reduce(
        (n, message) => n + countMessage(message as Parameters<typeof countMessage>[0]),
        0,
      );
    expect(repair.max_tokens).toBe(24_000 - input);
  });

  it("retains SDK retry gaps without treating HTTP failures as reported zero", async () => {
    const { app, characterId } = setup([busy, busy, busy]);
    const response = await app.request("/api/cast/update", postJson(update(characterId)));
    const body = (await response.json()) as {
      error: string;
      accounting: { calls: { usage: unknown; status: string }[] };
    };
    expect(body.error).toBe("upstream_busy");
    expect(body.accounting.calls.map((call) => [call.status, call.usage])).toEqual([
      ["failed", {}],
      ["failed", {}],
      ["failed", {}],
    ]);
  });

  it("shares stable sheet job receipts and keeps metadata out of stored sheets", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, stores, characterId, calls } = setup([], { before: () => gate.promise });
    const ask = () =>
      app.request(`/api/cast/sheets/${characterId}`, postJson({ model: "fake-model" }));
    const first = await ask();
    const second = await ask();
    gate.resolve();
    const a = castSheetResponseSchema.parse(await first.json());
    const b = castSheetResponseSchema.parse(await second.json());
    expect(calls()).toBe(1);
    expect(a.accounting?.calls).toHaveLength(1);
    expect(b.accounting).toEqual(a.accounting);
    expect(stores.castSheets.get(characterId)).not.toHaveProperty("accounting");
    const reused = castSheetResponseSchema.parse(await (await ask()).json());
    expect(reused.accounting).toEqual({ calls: [], truncated: false });
  });
  it("records developments and continuity grounded only in shown batch text", async () => {
    const extended = {
      cast: {
        Maren: {
          introduce: { evidence: "Maren cut her hair" },
          discovered: {
            hair: { value: "short hair", basis: "seen", evidence: "cut her hair" },
            age: { value: "31", basis: "told", evidence: "turned 31" },
          },
          developments: {
            hair: { value: "short hair", evidence: "cut her hair" },
            age: { value: "31", evidence: "turned 31" },
            relationship: { value: "married", evidence: CANON_CANARY },
          },
          continuity: { voice: { value: "calls Ilse captain", evidence: "Captain, come home." } },
        },
      },
      absent: [],
    };
    const { app, upstream, characterId } = setup([answer(extended)]);
    const response = await postUpdate(
      app,
      update(characterId, {
        turns: [
          {
            role: "assistant",
            content: "stale transformed content turned 31",
            macroEligible: true,
            scanText: "Maren cut her hair. Captain, come home.",
          },
        ],
      }),
    );
    const result = castUpdateResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    const change = result.changes.cast.Maren;
    expect(change?.developments).toEqual({ hair: extended.cast.Maren.developments.hair });
    expect(change?.continuity).toEqual(extended.cast.Maren.continuity);
    expect(change?.introduce).toEqual(extended.cast.Maren.introduce);
    expect(change?.discovered).toEqual({ hair: extended.cast.Maren.discovered.hair });
    const { system, user } = sent(upstream, 0);
    expect(system).toContain('"developments"');
    expect(user).toContain("Maren cut her hair. Captain, come home.");
    expect(user).not.toContain("stale transformed content");
  });

  it("tells the keeper when the card is a Scenario", async () => {
    const { app, stores, upstream } = setup();
    const characterId = stores.characters.create({ ...card, tags: ["Scenario"] });
    const response = await postUpdate(app, update(characterId));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("changes");
    const { system, user } = sent(upstream, 0);
    expect(user).toContain("Kind: Scenario");
    expect(system).toContain("For a new NPC in a Scenario");
    expect(system).toContain("Invented canon is not player discovery");
  });

  it("clamps a large new Scenario anchor and extra keys before strict validation", async () => {
    const long = "a detailed canonical fact ".repeat(50);
    const anchor = Object.fromEntries(
      Object.keys(emptyCastAnchor("Ilse Brandt", "female"))
        .filter((key) => key !== "name" && key !== "gender")
        .map((key) => [key, long]),
    );
    const text = "Ilse Brandt greets you.";
    const reply = {
      cast: {
        "Ilse Brandt": {
          role: "minor",
          gender: "female",
          anchor: { ...anchor, extra: true },
          introduce: { evidence: text, extra: true },
          extra: true,
        },
      },
      absent: [],
      extra: true,
    };
    const { app, stores, upstream, calls } = setup([answer(reply)]);
    const characterId = stores.characters.create({ ...card, tags: ["Scenario"] });
    const response = await postUpdate(
      app,
      update(characterId, {
        register: { entries: [] },
        turns: [{ role: "assistant", content: text }],
      }),
    );
    const { changes } = castUpdateResponseSchema.parse(await response.json());
    expect(changes.cast["Ilse Brandt"]?.introduce).toEqual({ evidence: text });
    const values = Object.values(changes.cast["Ilse Brandt"]?.anchor ?? {});
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value?.length).toBeLessThanOrEqual(CAST_LIMITS.field);
      expect(value).not.toBe("");
    }
    expect(changes.cast["Ilse Brandt"]).not.toHaveProperty("extra");
    expect(sent(upstream, 0).body.max_tokens).toBeGreaterThan(0);
    expect(calls()).toBe(1);
  });

  it("keeps the NPC but drops a boolean introduction, inventing no player evidence", async () => {
    const reply = { cast: { Ilse: { gender: "female", introduce: true } }, absent: [] };
    const { app, stores, calls } = setup([answer(reply)]);
    const characterId = stores.characters.create({ ...card, tags: ["Scenario"] });
    const response = await postUpdate(app, update(characterId, { register: { entries: [] } }));
    const { changes } = castUpdateResponseSchema.parse(await response.json());
    expect(changes.cast.Ilse).toEqual({ gender: "female" });
    expect(calls()).toBe(1);
  });

  it("answers the changes and the usage, unknown figures left out, logging no content", async () => {
    const { app, lines, upstream, characterId, calls } = setup();
    const response = await postUpdate(app, update(characterId));
    expect(response.status).toBe(200);
    const body = castUpdateResponseSchema.parse(await response.json());
    expect(body.changes).toEqual(castChangesSchema.parse(FAKE_KEEPER_CHANGES));
    // Normalized SDK defaults are not reports of cached or reasoning zero.
    expect(body.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
    });
    expect(calls()).toBe(1);
    const { system, user } = sent(upstream, 0);
    expect(system.startsWith(KEEPER_OPENING)).toBe(true);
    expect(user).toContain(TURN_CANARY);
    expect(user).toContain("Guest 0");
    expect(user).not.toContain("The register is full");
    // One cache key per character in the instance, naming neither.
    expect(upstream.records[0]?.affinity).toBeTruthy();
    expect(upstream.records[0]?.affinity).not.toContain(characterId);
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged.find((line) => line.event === "cast.update")).toMatchObject({
      model: "fake-model",
      attempt: 1,
    });
    noCanary(lines);
  });

  it("leaves every usage figure out when the provider reports none", async () => {
    const { app, characterId } = setup([], { withoutUsage: true });
    const response = await postUpdate(app, update(characterId));
    expect(castUpdateResponseSchema.parse(await response.json()).usage).toEqual({});
  });

  it("sends canon unless the chat acknowledged the stored sheet, it is the card's current one and names someone", async () => {
    const { app, stores, upstream, characterId } = setup();
    const current = fingerprintOf(card);
    const canonOf = async (sheetFingerprint: string | null) => {
      const index = upstream.records.length;
      const response = await postUpdate(app, update(characterId, { sheetFingerprint }));
      castUpdateResponseSchema.parse(await response.json());
      return sent(upstream, index).user.includes(CANON_CANARY);
    };
    // An empty sheet names no one: canon goes even when the chat acknowledged it.
    stores.castSheets.put(characterId, { fingerprint: current, entries: [] });
    expect(await canonOf(current)).toBe(true);
    stores.castSheets.put(characterId, { fingerprint: current, entries: [SHEET_PERSON] });
    // Match: the chat seeded from the current sheet, which names someone.
    expect(await canonOf(current)).toBe(false);
    // Null: the chat has no sheet.
    expect(await canonOf(null)).toBe(true);
    // Stale: the chat seeded from an older sheet, or the stored sheet is not the card's now.
    expect(await canonOf("0".repeat(64))).toBe(true);
    stores.castSheets.put(characterId, { fingerprint: "0".repeat(64), entries: [SHEET_PERSON] });
    expect(await canonOf("0".repeat(64))).toBe(true);
  });

  it("runs without a character, and tells a full register to add no one", async () => {
    const { app, upstream } = setup();
    const full = { entries: Array.from({ length: CAST_LIMITS.entries }, (_, i) => entry(i)) };
    const response = await postUpdate(app, update(undefined, { register: full, mode: "seed" }));
    castUpdateResponseSchema.parse(await response.json());
    const { user } = sent(upstream, 0);
    expect(user).not.toContain("<canon>");
    expect(user).toContain("The register is full");
    expect(user).toContain("This is the opening");
  });

  it("refuses malformed requests, a missing character, an unknown window and a prompt too long", async () => {
    const { app, lines, characterId, calls } = setup([], {
      catalog: [
        catalogEntry("fake-model"),
        { ...catalogEntry("tiny"), context_window: MEMORY_LIMITS.replyReserve + 64 },
      ],
    });
    for (const body of [
      update(characterId, { turns: [] }),
      update(characterId, { sheetFingerprint: "short" }),
      update(characterId, { extra: true }),
      { ...update(characterId), register: undefined },
    ]) {
      const response = await postUpdate(app, body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(TURN_CANARY);
    }
    const missing = await postUpdate(app, update(crypto.randomUUID()));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    const unknown = await postUpdate(app, update(characterId, { model: "unlisted" }));
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: "context_window_unknown" });
    const tiny = await postUpdate(app, update(characterId, { model: "tiny" }));
    expect(tiny.status).toBe(422);
    expect(await tiny.json()).toEqual({ error: "prompt_too_long" });
    expect(calls()).toBe(0);
    noCanary(lines);
  });

  it("counts framing and priming in the room the window leaves", async () => {
    const small = 24_000;
    const { app, upstream, characterId } = setup([], {
      catalog: [{ ...catalogEntry("small"), context_window: small }],
    });
    const response = await postUpdate(app, update(characterId, { model: "small" }));
    castUpdateResponseSchema.parse(await response.json());
    const { body } = sent(upstream, 0);
    const input =
      PRIMING +
      body.messages.reduce(
        (sum, message) => sum + countMessage(message as Parameters<typeof countMessage>[0]),
        0,
      );
    expect(body.max_tokens).toBe(small - input);
  });

  it("asks once more after an unusable answer, then answers cast_failed, logging class only", async () => {
    const retried = setup([unusable, answer(FAKE_KEEPER_CHANGES)]);
    const ok = await postUpdate(retried.app, update(retried.characterId));
    expect(castUpdateResponseSchema.parse(await ok.json()).changes.absent).toEqual([]);
    expect(retried.calls()).toBe(2);

    const { app, lines, characterId, calls } = setup([unusable, unusable, answer({})]);
    const response = await postUpdate(app, update(characterId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "cast_failed" });
    expect(calls()).toBe(2);
    const errors = lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "cast.update.error");
    expect(errors.map((line) => [line.errorClass, line.attempt])).toEqual([
      ["UnusableAnswer", 1],
      ["UnusableAnswer", 2],
    ]);
    noCanary(lines);
  });

  it("ends the call when the client goes", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, lines, characterId, calls } = setup([], { before: () => gate.promise });
    const response = await postUpdate(app, update(characterId));
    await until(() => calls() > 0);
    await response.body?.cancel();
    gate.resolve();
    await until(() => lines.some((line) => JSON.parse(line).event === "cast.update.abort"));
    noCanary(lines);
  });
});

describe("cast sheets", () => {
  const expectedEntries = FAKE_SHEET_ANSWER.cast.map(({ name, gender, role, anchor }) => ({
    role,
    anchor: { ...emptyCastAnchor(name, gender), ...anchor },
    aka: [],
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  }));

  it("reads no sheet as not current, and refuses a missing character", async () => {
    const { app, characterId, calls } = setup();
    expect(await (await getSheet(app, characterId)).json()).toEqual({
      sheet: null,
      current: false,
    });
    const missing = crypto.randomUUID();
    expect((await getSheet(app, missing)).status).toBe(404);
    const posted = await postSheet(app, missing);
    expect(posted.status).toBe(404);
    expect(await posted.json()).toEqual({ error: "not_found" });
    expect(calls()).toBe(0);
  });

  it("generates once for concurrent callers, then answers a current sheet without a call", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, stores, upstream, characterId, calls } = setup([], {
      before: () => gate.promise,
    });
    const first = await postSheet(app, characterId);
    const second = await postSheet(app, characterId);
    await until(() => calls() > 0);
    gate.resolve();
    const [a, b] = [
      castSheetResponseSchema.parse(await first.json()),
      castSheetResponseSchema.parse(await second.json()),
    ];
    expect(a).toEqual(b);
    expect(a.current).toBe(true);
    expect(a.sheet?.entries).toEqual(expectedEntries);
    expect(a.sheet?.fingerprint).toBe(fingerprintOf(card));
    expect(stores.castSheets.get(characterId)).toEqual(a.sheet);
    expect(calls()).toBe(1);
    expect(sent(upstream, 0).system.startsWith(SHEET_OPENING)).toBe(true);
    expect(sent(upstream, 0).user).toContain(CANON_CANARY);

    const { accounting: _accounting, ...view } = a;
    const again = await postSheet(app, characterId);
    expect(await again.json()).toEqual({ ...view, accounting: { calls: [], truncated: false } });
    expect(await (await getSheet(app, characterId)).json()).toEqual(view);
    expect(calls()).toBe(1);
  });

  it("regenerates for a changed card and on force", async () => {
    const { app, stores, characterId, calls } = setup();
    const first = castSheetResponseSchema.parse(await (await postSheet(app, characterId)).json());
    const revision = stores.characters.get(characterId)?.revision ?? 0;
    stores.characters.update(characterId, { description: "Maren sails now." }, revision);
    expect(await (await getSheet(app, characterId)).json()).toEqual({
      sheet: first.sheet,
      current: false,
    });
    const changed = castSheetResponseSchema.parse(await (await postSheet(app, characterId)).json());
    expect(changed.current).toBe(true);
    expect(changed.sheet?.revision).toBe((first.sheet?.revision ?? 0) + 1);
    expect(calls()).toBe(2);
    const forced = castSheetResponseSchema.parse(
      await (await postSheet(app, characterId, { force: true })).json(),
    );
    expect(forced.sheet?.revision).toBe((changed.sheet?.revision ?? 0) + 1);
    // New ids each time: a regenerated sheet is matched by name in the chat.
    expect(forced.sheet?.entries[0]?.id).not.toBe(changed.sheet?.entries[0]?.id);
    expect(calls()).toBe(3);
  });

  it("clamps and converts a malformed answer, and stores nothing after two unusable ones", async () => {
    const messy = {
      cast: [
        { name: "Ana Pires", gender: "female", anchor: { age: "31", wings: "none" }, extra: 1 },
        { name: "ana pires", gender: "female", role: "principal", anchor: {} },
        { name: "Teo", role: "principal", anchor: { age: "40" } },
      ],
    };
    const clamped = setup([answer(messy)]);
    const body = castSheetResponseSchema.parse(
      await (await postSheet(clamped.app, clamped.characterId)).json(),
    );
    expect(
      body.sheet?.entries.map(({ anchor }) => [anchor.name, anchor.gender, anchor.age]),
    ).toEqual([
      ["Ana Pires", "female", "31"],
      ["Teo", "other", "40"],
    ]);

    const { app, lines, stores, characterId, calls } = setup([unusable, unusable]);
    const response = await postSheet(app, characterId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: "cast_failed" });
    expect(calls()).toBe(2);
    expect(stores.castSheets.get(characterId)).toBeNull();
    noCanary(lines);
  });

  it("answers upstream_busy when the provider stays busy through every retry, storing nothing", async () => {
    const { app, lines, stores, characterId, calls } = setup([busy, busy, busy]);
    const response = await postSheet(app, characterId);
    expect(await response.json()).toMatchObject({ error: "upstream_busy", retryAfterS: 0 });
    // The first call and the AI SDK's two retries; no second attempt of the sheet's own.
    expect(calls()).toBe(3);
    expect(stores.castSheets.get(characterId)).toBeNull();
    expect(await (await getSheet(app, characterId)).json()).toEqual({
      sheet: null,
      current: false,
    });
    noCanary(lines);
  });

  for (const leaves of ["first", "second"] as const) {
    it(`outlives a caller: the ${leaves} goes and the other gets the stored sheet`, async () => {
      const gate = Promise.withResolvers<void>();
      const { app, stores, upstream, characterId, calls } = setup([], {
        before: () => gate.promise,
      });
      const first = await postSheet(app, characterId);
      await until(() => calls() > 0);
      const second = await postSheet(app, characterId);
      const [gone, staying] = leaves === "first" ? [first, second] : [second, first];
      await gone.body?.cancel();
      gate.resolve();
      const body = castSheetResponseSchema.parse(await staying.json());
      expect(body.sheet?.entries).toEqual(expectedEntries);
      expect(stores.castSheets.get(characterId)).toEqual(body.sheet);
      expect(calls()).toBe(1);
      expect(upstream.records[0]?.aborted).toBe(false);
    });
  }

  it("stores the sheet when every caller left", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, stores, characterId, calls } = setup([], { before: () => gate.promise });
    const only = await postSheet(app, characterId);
    await until(() => calls() > 0);
    await only.body?.cancel();
    gate.resolve();
    await until(() => stores.castSheets.get(characterId) !== null);
    expect(stores.castSheets.get(characterId)?.entries).toEqual(expectedEntries);
    // The next caller finds it current, without a call.
    const next = castSheetResponseSchema.parse(await (await postSheet(app, characterId)).json());
    expect(next.current).toBe(true);
    expect(calls()).toBe(1);
  });
});
