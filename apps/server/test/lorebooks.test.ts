import {
  blankCard,
  blankLorebook,
  CARD_LIMITS,
  type CharacterCard,
  LOREBOOK_LINKS,
  type Lorebook,
  type LorebookEntry,
  lorebookSummarySchema,
  storedLorebookSchema,
} from "@ephemera/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
  type Stores,
} from "../src/persistence/index.ts";
import {
  fileForm,
  formRequest,
  ownerHeaders,
  requestJson,
  sharedStores,
  testApp,
} from "./helpers.ts";

const CANARY = "lorebook-canary-7c1d";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: ["harbour"],
  content: "The harbour is grey.",
  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const book = (entries: LorebookEntry[] = [entry()]): Lorebook => ({
  ...blankLorebook("ignored"),
  entries,
});

const withBook = (name: string, characterBook?: Lorebook): CharacterCard => ({
  ...blankCard(name),
  ...(characterBook === undefined ? {} : { lorebook: characterBook }),
});

function fresh(): Stores {
  return createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles());
}

describe("lorebook store", () => {
  let s: Stores;
  beforeEach(() => {
    s = fresh();
  });

  it("creates idempotently, mirrors the name into the book, lists by name and removes", () => {
    const id = crypto.randomUUID();
    expect(s.lorebooks.create({ name: "  Harbour  ", book: book() }, id)).toBe(id);
    expect(s.lorebooks.create({ name: "Other", book: book([]) }, id)).toBe(id);
    const stored = storedLorebookSchema.parse(s.lorebooks.get(id));
    expect(stored).toMatchObject({ id, name: "Harbour", revision: 0 });
    expect(stored.book.name).toBe("Harbour");
    expect(stored.book.entries).toHaveLength(1);

    s.lorebooks.create({ name: "attic", book: blankLorebook("attic") }, crypto.randomUUID());
    const list = s.lorebooks.list();
    expect(list.map((row) => row.name)).toEqual(["attic", "Harbour"]);
    expect(lorebookSummarySchema.parse(list[1])).toMatchObject({
      id,
      entries: 1,
      enabled: 1,
      keywords: 1,
    });

    expect(s.lorebooks.remove(id)).toBe(true);
    expect(s.lorebooks.get(id)).toBeUndefined();
    expect(s.lorebooks.remove(id)).toBe(false);
  });

  it("updates against the revision, refuses a stale edit and answers a stale no-op as saved", () => {
    const id = s.lorebooks.create({ name: "Harbour", book: book() }, crypto.randomUUID());
    const renamed = s.lorebooks.update(id, { name: "Port" }, 0);
    expect(renamed).toMatchObject({ status: "updated", value: { name: "Port", revision: 1 } });
    expect(s.lorebooks.get(id)?.book.name).toBe("Port");

    // Another tab, still at revision 0.
    expect(s.lorebooks.update(id, { name: "Quay" }, 0)).toEqual({
      status: "conflict",
      revision: 1,
    });
    // A retry of the save whose answer was lost changes nothing: answered as saved.
    const retried = s.lorebooks.update(id, { name: "Port" }, 0);
    expect(retried).toMatchObject({ status: "updated", value: { name: "Port", revision: 1 } });
    expect(s.lorebooks.update(crypto.randomUUID(), { name: "X" }, 0)).toEqual({
      status: "missing",
    });

    const edited = book([entry({ content: "Fog rolls in." })]);
    expect(s.lorebooks.update(id, { book: edited }, 1)).toMatchObject({
      status: "updated",
      value: { name: "Port", revision: 2, book: { name: "Port" } },
    });
    expect(s.lorebooks.get(id)?.book.entries[0]?.content).toBe("Fog rolls in.");
  });

  it("links in order, idempotently, up to the limit, and unlinks without reordering", () => {
    const character = s.characters.create(blankCard("Mara"));
    const books = Array.from({ length: LOREBOOK_LINKS + 1 }, (_, i) =>
      s.lorebooks.create({ name: `Book ${i}`, book: book() }, crypto.randomUUID()),
    );
    for (const id of books.slice(0, LOREBOOK_LINKS)) {
      expect(s.lorebooks.link(id, character)).toBe("linked");
    }
    // Linking again changes nothing, also at the limit.
    expect(s.lorebooks.link(books[0] ?? "", character)).toBe("linked");
    expect(s.lorebooks.link(books[LOREBOOK_LINKS] ?? "", character)).toBe("full");
    expect(s.lorebooks.links()).toEqual([
      { characterId: character, lorebookIds: books.slice(0, LOREBOOK_LINKS) },
    ]);

    expect(s.lorebooks.unlink(books[1] ?? "", character)).toBe(true);
    expect(s.lorebooks.unlink(books[1] ?? "", character)).toBe(true);
    expect(s.lorebooks.link(books[LOREBOOK_LINKS] ?? "", character)).toBe("linked");
    const expected = [books[0], ...books.slice(2)];
    expect(s.lorebooks.links()[0]?.lorebookIds).toEqual(expected);
    expect(s.lorebooks.booksOf(character).map((linked) => linked.id)).toEqual(expected);
    expect(s.lorebooks.booksOf(character)[0]).toMatchObject({ name: "Book 0" });

    const missing = crypto.randomUUID();
    expect(s.lorebooks.link(missing, character)).toBe("missing");
    expect(s.lorebooks.link(books[0] ?? "", missing)).toBe("missing");
    expect(s.lorebooks.unlink(missing, character)).toBe(false);
    expect(s.lorebooks.unlink(books[0] ?? "", missing)).toBe(false);
  });

  it("drops a link with its book or its character", () => {
    const [mara, wren] = [
      s.characters.create(blankCard("Mara")),
      s.characters.create(blankCard("Wren")),
    ];
    const [a, b] = [
      s.lorebooks.create({ name: "A", book: book() }, crypto.randomUUID()),
      s.lorebooks.create({ name: "B", book: book() }, crypto.randomUUID()),
    ];
    for (const character of [mara, wren]) {
      s.lorebooks.link(a, character);
      s.lorebooks.link(b, character);
    }
    s.lorebooks.remove(a);
    expect(s.lorebooks.links()).toEqual(
      [
        { characterId: mara, lorebookIds: [b] },
        { characterId: wren, lorebookIds: [b] },
      ].sort((x, y) => x.characterId.localeCompare(y.characterId)),
    );
    s.characters.remove(mara);
    expect(s.lorebooks.links()).toEqual([{ characterId: wren, lorebookIds: [b] }]);
    expect(s.lorebooks.booksOf(mara)).toEqual([]);
  });

  it("duplicates a book without its links, and a character with its links in order", () => {
    const character = s.characters.create(blankCard("Mara"));
    const [a, b] = [
      s.lorebooks.create({ name: "A", book: book() }, crypto.randomUUID()),
      s.lorebooks.create({ name: "B", book: book() }, crypto.randomUUID()),
    ];
    s.lorebooks.link(b, character);
    s.lorebooks.link(a, character);

    const copy = s.lorebooks.duplicate(b) ?? "";
    expect(s.lorebooks.get(copy)).toMatchObject({ name: "B (copy)", book: { name: "B (copy)" } });
    expect(s.lorebooks.links().flatMap((link) => link.lorebookIds)).not.toContain(copy);
    expect(s.lorebooks.duplicate(crypto.randomUUID())).toBeUndefined();

    const twin = s.characters.duplicate(character) ?? "";
    expect(s.lorebooks.booksOf(twin).map((linked) => linked.id)).toEqual([b, a]);
    expect(s.lorebooks.booksOf(character).map((linked) => linked.id)).toEqual([b, a]);
  });

  it("lists every card that has a book, empty ones included", () => {
    const full = s.characters.create(withBook("Mara", book([entry(), entry()])));
    const empty = s.characters.create(withBook("Wren", book([])));
    s.characters.create(withBook("Plain"));
    expect(s.lorebooks.embedded()).toEqual([
      { characterId: full, name: "Mara", entries: 2 },
      { characterId: empty, name: "Wren", entries: 0 },
    ]);
  });

  it("accepts its own schema only (PRINCIPLES.md 1)", () => {
    const id = s.lorebooks.create({ name: "A", book: book() }, crypto.randomUUID());
    const before = JSON.stringify(s.lorebooks.get(id));
    const chat = { role: "user", content: CANARY };
    expect(() => s.lorebooks.create(chat as never, crypto.randomUUID())).toThrow();
    expect(() =>
      s.lorebooks.create(
        { name: "B", book: book(), messages: [chat] } as never,
        crypto.randomUUID(),
      ),
    ).toThrow();
    expect(() => s.lorebooks.update(id, { book: chat } as never, 0)).toThrow();
    expect(() => s.lorebooks.create({ name: "B", book: book() }, "not-a-uuid")).toThrow();
    expect(JSON.stringify(s.lorebooks.get(id))).toBe(before);
    expect(s.lorebooks.list()).toHaveLength(1);
  });
});

const upload = (bytes: Uint8Array | string, name = "book.json", method = "POST") =>
  formRequest(method, fileForm(bytes, name));

/** A World Info file as SillyTavern's documentation describes it. */
const worldInfo = (extra: Record<string, unknown> = {}) => ({
  entries: {
    "0": {
      uid: 0,
      key: ["harbour"],
      keysecondary: [],
      comment: "The harbour",
      content: `A grey harbour. ${CANARY}`,
      constant: false,
      selective: true,
      order: 100,
      position: 0,
      disable: false,
      probability: 40,
      useProbability: true,
      vectorized: true,
    },
  },
  ...extra,
});

function setup() {
  const stores = fresh();
  const { app, lines } = testApp({ instances: sharedStores(stores) });
  return { app, lines, stores };
}

describe("lorebooks API", () => {
  it("creates, reads, lists, edits, duplicates and deletes", async () => {
    const { app, stores } = setup();
    const id = crypto.randomUUID();
    const created = await app.request(
      "/api/lorebooks",
      requestJson("POST", { id, name: "Harbour" }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id });
    // A retried create makes no second book.
    expect(
      (await app.request("/api/lorebooks", requestJson("POST", { id, name: "Again" }))).status,
    ).toBe(201);
    expect(stores.lorebooks.list()).toHaveLength(1);

    const read = await app.request(`/api/lorebooks/${id}`, { headers: ownerHeaders() });
    expect(read.status).toBe(200);
    expect(storedLorebookSchema.parse(await read.json())).toMatchObject({
      name: "Harbour",
      book: { name: "Harbour", entries: [] },
    });

    const character = stores.characters.create(withBook("Mara", book([])));
    stores.lorebooks.link(id, character);
    const list = await app.request("/api/lorebooks", { headers: ownerHeaders() });
    expect(await list.json()).toEqual({
      lorebooks: [expect.objectContaining({ id, name: "Harbour", entries: 0 })],
      embedded: [{ characterId: character, name: "Mara", entries: 0 }],
      links: [{ characterId: character, lorebookIds: [id] }],
    });

    const patched = await app.request(
      `/api/lorebooks/${id}`,
      requestJson("PATCH", { revision: 0, book: book([entry()]) }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ revision: 1, book: { name: "Harbour" } });
    const stale = await app.request(
      `/api/lorebooks/${id}`,
      requestJson("PATCH", { revision: 0, name: "X" }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", revision: 1 });
    const unknown = crypto.randomUUID();
    expect(
      (
        await app.request(
          `/api/lorebooks/${unknown}`,
          requestJson("PATCH", { revision: 0, name: "X" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/lorebooks/${id}`, requestJson("PATCH", { revision: 1, name: "" })))
        .status,
    ).toBe(400);

    const copied = await app.request(`/api/lorebooks/${id}/duplicate`, requestJson("POST"));
    expect(copied.status).toBe(201);
    const { id: copy } = (await copied.json()) as { id: string };
    expect(stores.lorebooks.get(copy)?.name).toBe("Harbour (copy)");
    expect(
      (await app.request(`/api/lorebooks/${unknown}/duplicate`, requestJson("POST"))).status,
    ).toBe(404);

    expect((await app.request(`/api/lorebooks/${id}`, requestJson("DELETE"))).status).toBe(204);
    expect((await app.request(`/api/lorebooks/${id}`, requestJson("DELETE"))).status).toBe(404);
    expect((await app.request(`/api/lorebooks/${id}`, { headers: ownerHeaders() })).status).toBe(
      404,
    );
    expect(stores.lorebooks.links()).toEqual([]);
    expect(
      (await app.request("/api/lorebooks/not-a-uuid", { headers: ownerHeaders() })).status,
    ).toBe(400);
  });

  it("refuses a book past the size limit with 413, on create and on edit", async () => {
    const { app, stores } = setup();
    const huge = book(
      Array.from({ length: 80 }, () =>
        entry({ content: "x".repeat(CARD_LIMITS.cardJsonBytes / 80) }),
      ),
    );
    const id = crypto.randomUUID();
    const created = await app.request(
      "/api/lorebooks",
      requestJson("POST", { id, name: "Big", book: huge }),
    );
    expect(created.status).toBe(413);
    expect(await created.json()).toEqual({ error: "payload_too_large" });
    expect(stores.lorebooks.list()).toEqual([]);

    stores.lorebooks.create({ name: "Small", book: book() }, id);
    const edited = await app.request(
      `/api/lorebooks/${id}`,
      requestJson("PATCH", { revision: 0, book: huge }),
    );
    expect(edited.status).toBe(413);
    expect(stores.lorebooks.get(id)?.revision).toBe(0);
  });

  it("links and unlinks characters, refusing past the limit", async () => {
    const { app, stores } = setup();
    const character = stores.characters.create(blankCard("Mara"));
    const books = Array.from({ length: LOREBOOK_LINKS + 1 }, (_, i) =>
      stores.lorebooks.create({ name: `Book ${i}`, book: book() }, crypto.randomUUID()),
    );
    const path = (id: string | undefined, who = character) =>
      `/api/lorebooks/${id}/characters/${who}`;
    for (const id of books.slice(0, LOREBOOK_LINKS)) {
      expect((await app.request(path(id), requestJson("PUT"))).status).toBe(204);
    }
    expect((await app.request(path(books[0]), requestJson("PUT"))).status).toBe(204);
    const refused = await app.request(path(books[LOREBOOK_LINKS]), requestJson("PUT"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "too_many_lorebooks" });

    const unknown = crypto.randomUUID();
    expect((await app.request(path(unknown), requestJson("PUT"))).status).toBe(404);
    expect((await app.request(path(books[0], unknown), requestJson("PUT"))).status).toBe(404);
    expect((await app.request(path(books[0]), requestJson("DELETE"))).status).toBe(204);
    expect((await app.request(path(books[0]), requestJson("DELETE"))).status).toBe(204);
    expect((await app.request(path(unknown), requestJson("DELETE"))).status).toBe(404);
    expect((await app.request(path(books[0], unknown), requestJson("DELETE"))).status).toBe(404);
    expect(stores.lorebooks.links()[0]?.lorebookIds).toEqual(books.slice(1, LOREBOOK_LINKS));
  });

  it("imports a World Info file with its report, named by the file, and logs nothing of it", async () => {
    const { app, lines, stores } = setup();
    const response = await app.request(
      "/api/lorebooks/import",
      upload(JSON.stringify(worldInfo()), "Harbour Town.json"),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; name: string; report: unknown };
    expect(body).toEqual({
      id: expect.any(String),
      name: "Harbour Town",
      report: {
        kept: [],
        changed: [],
        skipped: ["Unsupported lorebook feature omitted: vectorized."],
      },
    });
    const stored = stores.lorebooks.get(body.id);
    expect(stored).toMatchObject({ name: "Harbour Town", book: { name: "Harbour Town" } });
    expect(stored?.book.entries[0]?.content).toContain(CANARY);

    // The file's own name wins; a file without either gets the fixed one.
    const named = await app.request(
      "/api/lorebooks/import",
      upload(JSON.stringify(worldInfo({ name: "  The Quay  " })), "other.json"),
    );
    expect(((await named.json()) as { name: string }).name).toBe("The Quay");
    const unnamed = await app.request(
      "/api/lorebooks/import",
      upload(JSON.stringify(worldInfo()), ".json"),
    );
    expect(((await unnamed.json()) as { name: string }).name).toBe("Imported lorebook");
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain("Harbour");
  });

  it("exports a native lorebook download that imports again as the same book", async () => {
    const { app, stores } = setup();
    const id = stores.lorebooks.create(
      {
        name: 'Quay "North"/../\r\nSet-Cookie: x=1',
        book: book([
          entry({ id: 0, comment: "Fog", settings: { useProbability: true, probability: 25 } }),
          entry({ id: 1, keys: ["bell"], constant: true, enabled: false }),
        ]),
      },
      crypto.randomUUID(),
    );
    const exported = await app.request(`/api/lorebooks/${id}/export`, { headers: ownerHeaders() });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(exported.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="[A-Za-z0-9 ._()-]+\.json"; filename\*=UTF-8''[^\s"]+$/,
    );
    expect(exported.headers.get("Set-Cookie")).toBeNull();
    const file = await exported.text();
    expect(JSON.parse(file)).toHaveProperty("format", "ephemera.lorebook");

    const imported = await app.request("/api/lorebooks/import", upload(file, "copy.json"));
    expect(imported.status).toBe(201);
    const { id: copy, name } = (await imported.json()) as { id: string; name: string };
    expect(name).toBe(stores.lorebooks.get(id)?.name);
    // The native copy exports as the same packet.
    const again = await app.request(`/api/lorebooks/${copy}/export`, { headers: ownerHeaders() });
    expect(await again.text()).toBe(file);
    const entries = stores.lorebooks.get(copy)?.book.entries;
    expect(
      entries?.map((e) => [e.comment, e.enabled, e.constant, e.settings?.probability]),
    ).toEqual([
      ["Fog", true, undefined, 25],
      [undefined, false, true, undefined],
    ]);
    expect(
      (
        await app.request(`/api/lorebooks/${crypto.randomUUID()}/export`, {
          headers: ownerHeaders(),
        })
      ).status,
    ).toBe(404);
  });

  it.each([
    ["malformed JSON", "{nope", 422, { error: "not_json" }],
    [
      "text that is not UTF-8",
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      422,
      { error: "not_json" },
    ],
    ["a JSON non-lorebook", '{"hello":"nope"}', 422, { error: "not_a_lorebook" }],
    [
      "an entry past its limit",
      JSON.stringify({
        entries: { "0": { key: ["nope"], content: "x".repeat(CARD_LIMITS.textLength + 1) } },
      }),
      422,
      { error: "field_too_long", field: "entries.0.content" },
    ],
    [
      "a file past the JSON limit",
      new Uint8Array(CARD_LIMITS.cardJsonBytes + 1).fill(0x20),
      413,
      { error: "payload_too_large" },
    ],
  ])("refuses %s with a code, logging only the code", async (_label, bytes, status, error) => {
    const { app, lines, stores } = setup();
    const response = await app.request("/api/lorebooks/import", upload(bytes, "nope.json"));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(error);
    expect(stores.lorebooks.list()).toEqual([]);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.find((line) => line.event === "lorebooks.import")).toMatchObject({
      errorClass: expect.any(String),
    });
    expect(lines.join("\n")).not.toContain("nope");
  });

  it("never echoes a key the file itself supplied", async () => {
    const { app } = setup();
    const key = `<img src=x>${"k".repeat(300)}`;
    const file = { entries: { [key]: { key: { [key]: 1 }, content: "c" } } };
    const response = await app.request("/api/lorebooks/import", upload(JSON.stringify(file)));
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toEqual({ error: "invalid", field: "entries.0.keys" });
    expect(text).not.toContain("img");
    expect(text).not.toContain("kkk");
  });

  it("takes multipart on the import route only", async () => {
    const { app, stores } = setup();
    const id = stores.lorebooks.create({ name: "A", book: book() }, crypto.randomUUID());
    const file = JSON.stringify(worldInfo());
    for (const [path, method] of [
      ["/api/lorebooks", "POST"],
      [`/api/lorebooks/${id}`, "PATCH"],
      [`/api/lorebooks/${id}/duplicate`, "POST"],
    ] as const) {
      expect((await app.request(path, upload(file, "x.json", method))).status).toBe(415);
    }
    const init = upload(file);
    (init.headers as Record<string, string>).Origin = "https://evil.test";
    expect((await app.request("/api/lorebooks/import", init)).status).toBe(403);
  });
});
