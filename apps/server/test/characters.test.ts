import {
  blankCard,
  CARD_LIMITS,
  serializeCharacter,
  storedCharacterSchema,
  utf8Bytes,
} from "@ephemera/core";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PORTRAIT_CACHE_CONTROL } from "../src/http.ts";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";
import { characters } from "../src/persistence/schema.ts";
import { attachment } from "../src/routes.ts";
import {
  config,
  fileForm,
  formRequest,
  ownerHeaders,
  requestJson,
  sharedStores,
  testApp,
} from "./helpers.ts";
import {
  cardChunk,
  jpegWithMetadata,
  plainPng,
  pngClaiming,
  pngWithText,
  svg,
} from "./image-fixtures.ts";

function setup() {
  const db = openUserDatabase(undefined).db;
  const stores = createStores(db, createMemoryPortraitFiles());
  const store = stores.characters;
  const { app, lines } = testApp({ instances: sharedStores(stores) });
  return { app, lines, store, db };
}

const upload = (bytes: Uint8Array, name = "card.png", method = "POST") =>
  formRequest(method, fileForm(bytes, name));

const v2 = (name: string, extra: object = {}) =>
  ({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name, description: "d", ...extra },
  }) as const;

describe("characters API", () => {
  it("rejects an edit that outgrows UTF-8 export bytes and allows a legacy row to be reduced", async () => {
    const { app, store, db } = setup();
    const unicode = "界".repeat(CARD_LIMITS.textLength);
    const original = {
      ...blankCard("Unicode"),
      alternateGreetings: Array<string>(10).fill(unicode),
    };
    const id = store.create(original);
    const patched = await app.request(
      `/api/characters/${id}`,
      requestJson("PATCH", { description: unicode, revision: 0 }),
    );
    expect(patched.status).toBe(413);
    expect(store.get(id)?.card).toEqual(original);
    db.update(characters)
      .set({ card: { ...original, description: unicode } })
      .where(eq(characters.id, id))
      .run();
    const legacy = await app.request(`/api/characters/${id}`, { headers: ownerHeaders() });
    expect(storedCharacterSchema.safeParse(await legacy.json()).success).toBe(true);
    expect(
      (
        await app.request(
          `/api/characters/${id}`,
          requestJson("PATCH", { description: "", revision: 0 }),
        )
      ).status,
    ).toBe(200);
  });

  it("exports exact-boundary compact JSON that can be imported again", async () => {
    const { app, store } = setup();
    const card = {
      ...blankCard("Boundary"),
      characterNote: { prompt: "", depth: 4, role: "system" as const },
    };
    card.characterNote.prompt = "x".repeat(
      CARD_LIMITS.cardJsonBytes - utf8Bytes(serializeCharacter(card)),
    );
    const id = store.create(card);
    const exported = await app.request(`/api/characters/${id}/export.json`, {
      headers: ownerHeaders(),
    });
    const bytes = new Uint8Array(await exported.arrayBuffer());
    expect(bytes.byteLength).toBe(CARD_LIMITS.cardJsonBytes);
    expect(
      (await app.request("/api/characters/import", upload(bytes, "boundary.json"))).status,
    ).toBe(201);
  });
  it("refuses a copy past the card limit with 413, not a server error", async () => {
    const { app, store } = setup();
    const card = {
      ...blankCard("Boundary"),
      characterNote: { prompt: "", depth: 4, role: "system" as const },
    };
    card.characterNote.prompt = "x".repeat(
      CARD_LIMITS.cardJsonBytes - utf8Bytes(serializeCharacter(card)),
    );
    const id = store.create(card);
    const copy = await app.request(`/api/characters/${id}/duplicate`, requestJson("POST"));
    expect(copy.status).toBe(413);
    expect(await copy.json()).toEqual({ error: "payload_too_large" });
    expect(store.list()).toHaveLength(1);
  });

  it("answers a stale edit that would outgrow the card as a conflict, so the tab can reload", async () => {
    const { app, store } = setup();
    const card = {
      ...blankCard("Near"),
      characterNote: { prompt: "", depth: 4, role: "system" as const },
    };
    card.characterNote.prompt = "x".repeat(
      CARD_LIMITS.cardJsonBytes - utf8Bytes(serializeCharacter(card)) - 100,
    );
    const id = store.create(card);
    const first = await app.request(
      `/api/characters/${id}`,
      requestJson("PATCH", { description: "ab", revision: 0 }),
    );
    expect(first.status).toBe(200);
    const stale = await app.request(
      `/api/characters/${id}`,
      requestJson("PATCH", { description: "x".repeat(500), revision: 0 }),
    );
    expect(stale.status).toBe(409);
    expect(store.get(id)?.card.description).toBe("ab");
  });

  it("creates, reads, edits, lists, duplicates and deletes", async () => {
    const { app } = setup();
    const fields = blankCard("Wren");
    const created = await app.request(
      "/api/characters",
      requestJson("POST", { id: crypto.randomUUID(), fields: { ...fields, tags: ["river"] } }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const patched = await app.request(
      `/api/characters/${id}`,
      requestJson("PATCH", { description: "Pilot", alternateGreetings: ["Hi"], revision: 0 }),
    );
    expect(patched.status).toBe(200);

    const read = await app.request(`/api/characters/${id}`, { headers: ownerHeaders() });
    expect(await read.json()).toMatchObject({
      id,
      card: { name: "Wren", description: "Pilot", alternateGreetings: ["Hi"] },
      portrait: null,
    });

    const listed = (await (
      await app.request("/api/characters", { headers: ownerHeaders() })
    ).json()) as {
      characters: { id: string; name: string }[];
    };
    expect(listed.characters.map((c) => c.name)).toEqual(["Wren"]);

    const copy = await app.request(`/api/characters/${id}/duplicate`, requestJson("POST"));
    expect(copy.status).toBe(201);

    expect((await app.request(`/api/characters/${id}`, requestJson("DELETE"))).status).toBe(204);
    expect((await app.request(`/api/characters/${id}`, { headers: ownerHeaders() })).status).toBe(
      404,
    );
    expect((await app.request(`/api/characters/${id}`, requestJson("DELETE"))).status).toBe(404);
  });

  it.each([
    ["an unknown field", { description: "x", messages: [] }],
    ["extensions (not editable)", { extensions: {} }],
    ["an empty name", { name: "  " }],
    ["a name over the limit", { name: "n".repeat(CARD_LIMITS.nameLength + 1) }],
  ])("rejects a patch with %s without echoing it", async (_label, patch) => {
    const { app, store } = setup();
    const id = store.create(blankCard("Mara"));
    const response = await app.request(
      `/api/characters/${id}`,
      requestJson("PATCH", { ...patch, revision: 0 }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(store.get(id)?.card.name).toBe("Mara");
  });

  it("rejects ids that are not UUIDs", async () => {
    const { app } = setup();
    expect(
      (await app.request("/api/characters/..%2F..%2Fetc", { headers: ownerHeaders() })).status,
    ).toBe(400);
  });
});

describe("import", () => {
  it("imports a PNG card with its portrait and a JSON card without one", async () => {
    const { app, store } = setup();
    const png = await app.request(
      "/api/characters/import",
      upload(
        pngWithText(
          { ccv3: cardChunk({ ...v2("Seraphina"), spec: "chara_card_v3", spec_version: "3.0" }) },
          20,
          30,
        ),
      ),
    );
    expect(png.status).toBe(201);
    const { id, name } = (await png.json()) as { id: string; name: string };
    expect(name).toBe("Seraphina");
    expect(store.get(id)?.portrait).toEqual(expect.any(Number));

    const file = await app.request(
      "/api/characters/import",
      upload(Buffer.from(JSON.stringify(v2("Mara"))), "mara.json"),
    );
    expect(file.status).toBe(201);
    const { id: jsonId } = (await file.json()) as { id: string };
    expect(store.get(jsonId)?.portrait).toBeNull();
  });

  it.each([
    ["malformed JSON", Buffer.from("{nope"), 422, "not_json"],
    ["a JSON non-card", Buffer.from('{"hello":"world"}'), 422, "not_a_card"],
    ["an SVG", Buffer.from(svg), 422, "not_json"],
    ["a PNG without a card", null, 422, "not_a_card"],
    [
      "a huge-dimension PNG card",
      Buffer.from(pngClaiming(50_000, 50_000)),
      413,
      "payload_too_large",
    ],
  ])("rejects %s with a code, logging only the code", async (_label, bytes, status, error) => {
    const { app, lines, store } = setup();
    const body = bytes ?? (await plainPng());
    const response = await app.request("/api/characters/import", upload(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(store.list()).toEqual([]);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.find((line) => line.event === "characters.import")).toMatchObject({
      errorClass: expect.any(String),
    });
    expect(lines.join("\n")).not.toContain("nope");
  });

  it("names the field that is over its limit", async () => {
    const { app } = setup();
    const card = v2("Long", { description: "d".repeat(CARD_LIMITS.textLength + 1) });
    const response = await app.request(
      "/api/characters/import",
      upload(Buffer.from(JSON.stringify(card)), "c.json"),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "field_too_long", field: "description" });
  });

  it("never echoes a key the card itself supplied", async () => {
    const { app } = setup();
    const key = `<img src=x>${"k".repeat(300)}`;
    const card = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { name: "Keys", description: "d", creator_notes_multilingual: { [key]: "v" } },
    };
    const response = await app.request(
      "/api/characters/import",
      upload(Buffer.from(JSON.stringify(card)), "c.json"),
    );
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).not.toContain("img");
    expect(body).not.toContain("kkk");
    expect(JSON.parse(body)).toEqual({ error: "invalid", field: "creator_notes_multilingual.*" });
  });

  it("rejects an upload over the size limit", async () => {
    const { app } = setup();
    const response = await app.request(
      "/api/characters/import",
      upload(new Uint8Array(CARD_LIMITS.uploadBytes + 100_000)),
    );
    expect(response.status).toBe(413);
  });

  it("requires a file field", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("other", "x");
    expect((await app.request("/api/characters/import", formRequest("POST", form))).status).toBe(
      400,
    );
  });
});

describe("portraits", () => {
  it("stores a re-encoded portrait, serves it with type, nosniff and revalidated caching", async () => {
    const { app, store } = setup();
    const id = store.create(blankCard("Tobias"));
    const put = await app.request(
      `/api/characters/${id}/portrait`,
      upload(await jpegWithMetadata(), "p.jpg", "PUT"),
    );
    expect(put.status).toBe(200);
    const { portrait } = (await put.json()) as { portrait: number };

    const tags = new Set<string>();
    for (const [size, type] of [
      ["full", "image/png"],
      ["thumb", "image/webp"],
    ] as const) {
      const url = `/api/characters/${id}/portrait/image?size=${size}&v=${portrait}`;
      const current = await app.request(url, { headers: ownerHeaders() });
      expect(current.status).toBe(200);
      expect(current.headers.get("Content-Type")).toBe(type);
      expect(current.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(current.headers.get("Cache-Control")).toBe(PORTRAIT_CACHE_CONTROL);
      const tag = current.headers.get("ETag") ?? "";
      expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
      tags.add(tag);
      const meta = await sharp(new Uint8Array(await current.arrayBuffer())).metadata();
      expect(meta.exif).toBeUndefined();

      // The browser's revalidation: still valid answers 304 with the same headers and no body.
      const unchanged = await app.request(url, { headers: ownerHeaders({ "If-None-Match": tag }) });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("Cache-Control")).toBe(PORTRAIT_CACHE_CONTROL);
      expect(unchanged.headers.get("ETag")).toBe(tag);
      expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
      const stale = await app.request(url, {
        headers: ownerHeaders({ "If-None-Match": '"0123456789abcdef0123456789abcdef"' }),
      });
      expect(stale.status).toBe(200);
      expect((await stale.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    expect(tags.size).toBe(2);

    for (const query of ["", `?v=${portrait - 1}`, "?v=abc", "?size=full"]) {
      const stale = await app.request(`/api/characters/${id}/portrait/image${query}`, {
        headers: ownerHeaders(),
      });
      expect(stale.status).toBe(200);
      expect(stale.headers.get("Cache-Control")).toBe("no-store, no-transform");
      expect(stale.headers.get("ETag")).toBeNull();
    }

    expect(
      (await app.request(`/api/characters/${id}/portrait`, requestJson("DELETE"))).status,
    ).toBe(204);
    const gone = await app.request(`/api/characters/${id}/portrait/image?v=${portrait}`, {
      headers: ownerHeaders(),
    });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("Cache-Control")).toBe("no-store, no-transform");
  });

  it.each([
    ["an SVG", Buffer.from(svg), 415],
    ["a huge-dimension header", Buffer.from(pngClaiming(50_000, 50_000)), 413],
  ])("rejects %s", async (_label, bytes, status) => {
    const { app, store } = setup();
    const id = store.create(blankCard("Tobias"));
    const response = await app.request(
      `/api/characters/${id}/portrait`,
      upload(bytes, "p.png", "PUT"),
    );
    expect(response.status).toBe(status);
    expect(store.get(id)?.portrait).toBeNull();
  });

  it("only a current portrait GET may skip no-store, and the old portrait URLs are gone", async () => {
    const { app, store } = setup();
    const id = store.create(blankCard("Ines"));
    const put = await app.request(
      `/api/characters/${id}/portrait`,
      upload(await plainPng(), "p.png", "PUT"),
    );
    const { portrait: version } = (await put.json()) as { portrait: number };
    for (const path of [
      "/api/characters",
      `/api/characters/${id}`,
      `/api/characters/${id}/export.json`,
      "/api/models",
      "/api/settings",
    ]) {
      const response = await app.request(path, { headers: ownerHeaders() });
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
      expect(response.headers.get("ETag")).toBeNull();
    }
    // A URL issued under the old one-year policy is never answered with an image again.
    const old = await app.request(`/api/characters/${id}/portrait?size=thumb&v=${version}`, {
      headers: ownerHeaders(),
    });
    expect(old.status).toBe(405);
    expect(old.headers.get("Cache-Control")).toBe("no-store, no-transform");
  });
});

describe("export", () => {
  it("exports JSON and PNG as attachments with safe filenames", async () => {
    const { app, store } = setup();
    const id = store.create(blankCard('Mara "The Fox" Voss/../\r\nSet-Cookie: x=1'));
    const exported = await app.request(`/api/characters/${id}/export.json`, {
      headers: ownerHeaders(),
    });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({
      format: "ephemera.character",
      version: 1,
      data: { name: expect.any(String) },
    });
    const disposition = exported.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(
      /^attachment; filename="[A-Za-z0-9 ._()-]+\.json"; filename\*=UTF-8''[^\s"]+$/,
    );
    expect(exported.headers.get("Set-Cookie")).toBeNull();

    const png = await app.request(`/api/characters/${id}/export.png`, { headers: ownerHeaders() });
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(png.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await sharp(new Uint8Array(await png.arrayBuffer())).metadata()).format).toBe("png");
  });

  it("builds a filename from any name", () => {
    expect(attachment("Seraphina", "png")).toBe(
      `attachment; filename="Seraphina.png"; filename*=UTF-8''Seraphina.png`,
    );
    expect(attachment("Inès", "json")).toBe(
      `attachment; filename="In_s.json"; filename*=UTF-8''In%C3%A8s.json`,
    );
    // RFC 5987 attr-char excludes ' ( ) * !: Chromium drops a filename* that carries them.
    expect(attachment("O'Brien (v2)!", "png")).toBe(
      `attachment; filename="O_Brien (v2)_.png"; filename*=UTF-8''O%27Brien%20%28v2%29%21.png`,
    );
    expect(attachment("../..", "json")).toContain('filename=".. ...json"');
    expect(attachment("\u0000‮", "png")).toContain('filename="character.png"');
  });
});

describe("boundary for uploads", () => {
  it("allows multipart only on the two upload routes", async () => {
    const { app, store } = setup();
    const id = store.create(blankCard("Kestrel"));
    const card = Buffer.from(JSON.stringify(v2("Kestrel")));
    expect((await app.request("/api/characters/import", upload(card))).status).toBe(201);
    expect(
      (
        await app.request(
          `/api/characters/${id}/portrait`,
          upload(await plainPng(), "p.png", "PUT"),
        )
      ).status,
    ).toBe(200);
    const others: [string, string][] = [
      ["/api/characters", "POST"],
      [`/api/characters/${id}`, "PATCH"],
      [`/api/characters/${id}/duplicate`, "POST"],
      ["/api/chat", "POST"],
      [`/api/characters/${id}/portrait`, "POST"],
    ];
    for (const [path, method] of others) {
      expect((await app.request(path, upload(card, "x", method))).status).toBe(415);
    }
  });

  it("still requires the exact origin for uploads", async () => {
    const { app } = setup();
    const init = upload(Buffer.from(JSON.stringify(v2("X"))));
    (init.headers as Record<string, string>).Origin = "https://evil.test";
    expect((await app.request("/api/characters/import", init)).status).toBe(403);
    expect(config.origin).not.toBe("https://evil.test");
  });
});

describe("review fixes", () => {
  const fields = () => {
    const editable = blankCard("Retry");
    return editable;
  };

  it("a repeated create with the same id makes one character", async () => {
    const { app, store } = setup();
    const id = crypto.randomUUID();
    for (let i = 0; i < 2; i++) {
      const response = await app.request(
        "/api/characters",
        requestJson("POST", { id, fields: fields() }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id });
    }
    expect(store.list().map((c) => c.id)).toEqual([id]);
  });

  it("refuses an edit that takes the card past the import limit", async () => {
    const { app, store } = setup();
    const id = store.create(blankCard("Big"));
    const greeting = "g".repeat(CARD_LIMITS.textLength);
    const alternates = Array.from({ length: 40 }, () => greeting);
    const response = await app.request(
      `/api/characters/${id}`,
      requestJson("PATCH", { alternateGreetings: alternates, revision: 0 }),
    );
    expect(response.status).toBe(413);
    expect(store.get(id)?.card.alternateGreetings).toEqual([]);
  });

  it.each([
    ["an emoji at the cut", `${"a".repeat(99)}😀tail`],
    ["a lone surrogate", `Broken \ud800 name`],
  ])("exports a character whose name has %s", async (_label, name) => {
    const { app, store } = setup();
    const id = store.create(blankCard(name));
    for (const format of ["json", "png"]) {
      const response = await app.request(`/api/characters/${id}/export.${format}`, {
        headers: ownerHeaders(),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="/);
    }
  });
});
