import { randomBytes } from "node:crypto";
import {
  blankCard,
  CARD_LIMITS,
  normalizeCard,
  serializeCharacter,
  toCharacterFile,
  utf8Bytes,
} from "@ephemera/core";
import { decode } from "fast-png";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardToPng, readCardFile } from "../src/cards.ts";
import { textChunk, withChunks } from "../src/png.ts";
import {
  bombCardPng,
  cardChunk,
  compressedMetadataPng,
  jpegWithMetadata,
  plainPng,
  pngWithText,
  svg,
} from "./image-fixtures.ts";

const v3 = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "From ccv3",
    description: "d",
    first_mes: "hi",
    tags: ["a"],
    extensions: JSON.parse('{"__proto__": {"x": 1}, "chub": {"full_path": "x/y"}}'),
    assets: [{ type: "icon", uri: "https://example.invalid/steal.png", name: "main", ext: "png" }],
    creator_notes: "See https://example.invalid/notes and ![x](https://example.invalid/x.png)",
  },
};
const v2 = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "From chara", description: "d" },
};

async function read(bytes: Uint8Array | Buffer) {
  return readCardFile(new Uint8Array(bytes));
}

describe("PNG cards", () => {
  it("gives native packets precedence over both foreign chunks", async () => {
    const native = toCharacterFile(blankCard("Native"));
    expect(
      await read(
        pngWithText({ chara: cardChunk(v2), ccv3: cardChunk(v3), ephemera: cardChunk(native) }),
      ),
    ).toMatchObject({
      ok: true,
      card: native.data,
      report: { kept: [], changed: [], skipped: [] },
    });
  });
  it.each([
    ["bad base64", "!"],
    ["broken JSON", Buffer.from("{").toString("base64")],
    ["foreign data", cardChunk(v3)],
    ["wrong kind", cardChunk({ format: "ephemera.lorebook", version: 1, data: { entries: [] } })],
    ["future version", cardChunk({ ...toCharacterFile(blankCard("Future")), version: 2 })],
    [
      "mixed envelope",
      cardChunk({ ...toCharacterFile(blankCard("Mixed")), spec: "chara_card_v3" }),
    ],
    ["oversized marker", "A".repeat(Math.ceil((CARD_LIMITS.cardJsonBytes * 4) / 3) + 100)],
  ])("never falls back from a native marker with %s", async (_name, ephemera) => {
    expect(
      (await read(pngWithText({ ephemera, ccv3: cardChunk(v3), chara: cardChunk(v2) }))).ok,
    ).toBe(false);
  });
  it("refuses duplicate native markers, even when identical or one is malformed", async () => {
    const packet = cardChunk(toCharacterFile(blankCard("Native")));
    for (const second of [packet, "!"]) {
      const png = withChunks(pngWithText({ ephemera: packet, chara: cardChunk(v2) }), [
        textChunk("ephemera", second),
      ]);
      if (!png) throw new Error("Fixture PNG");
      expect((await read(png)).ok).toBe(false);
    }
  });
  it("prefers ccv3 over chara", async () => {
    const result = await read(pngWithText({ chara: cardChunk(v2), ccv3: cardChunk(v3) }));
    expect(result).toMatchObject({ ok: true, card: { name: "From ccv3" } });
  });

  it("reads chara when there is no ccv3", async () => {
    expect(await read(pngWithText({ chara: cardChunk(v2) }))).toMatchObject({
      ok: true,
      card: { name: "From chara" },
    });
  });

  it.each([
    ["not base64", "!!!not base64!!!"],
    ["base64 of broken JSON", Buffer.from("{broken").toString("base64")],
    ["base64 of a non-card", cardChunk({ hello: "world" })],
  ])("falls back to chara when ccv3 is %s", async (_label, ccv3) => {
    expect(await read(pngWithText({ ccv3, chara: cardChunk(v2) }))).toMatchObject({
      ok: true,
      card: { name: "From chara" },
    });
  });

  it("reports the ccv3 failure when chara is missing too", async () => {
    expect(await read(pngWithText({ ccv3: Buffer.from("{broken").toString("base64") }))).toEqual({
      ok: false,
      error: "not_json",
    });
  });

  it("rejects a PNG without a card", async () => {
    expect(await read(await plainPng())).toEqual({ ok: false, error: "not_a_card" });
    expect(await read(pngWithText({ Comment: "hello" }))).toEqual({
      ok: false,
      error: "not_a_card",
    });
  });

  it("rejects a hostile chunk of whitespace and one bad character in linear time", async () => {
    // A backtracking check was quadratic here: 80,000 spaces took seconds, 11 MB hours.
    for (const space of [" ", "\t", "\n"]) {
      // Include native decoder work, but exclude time waiting for CPU under machine load.
      const started = process.cpuUsage();
      const chunk = `${space.repeat(2_000_000)}!`;
      expect(await read(pngWithText({ chara: chunk }))).toMatchObject({ ok: false });
      const cpu = process.cpuUsage(started);
      expect(cpu.user + cpu.system).toBeLessThan(2_000_000);
    }
  });

  it("reads base64 split by whitespace, with or without padding", async () => {
    const text = cardChunk(v2);
    const wrapped = text.replace(/(.{76})/g, "$1\n").replace(/=+$/, "");
    expect(await read(pngWithText({ chara: wrapped }))).toMatchObject({ ok: true });
  });

  it("rejects an oversized chunk before decoding it", async () => {
    const huge = "A".repeat(Math.ceil((CARD_LIMITS.cardJsonBytes * 4) / 3) + 100);
    expect(await read(pngWithText({ ccv3: huge }))).toEqual({ ok: false, error: "too_large" });
  });

  it("keeps chunk limits independent so an oversized candidate cannot veto a valid card", async () => {
    const huge = "A".repeat(Math.ceil((CARD_LIMITS.cardJsonBytes * 4) / 3) + 100);
    expect(await read(pngWithText({ chara: huge, ccv3: cardChunk(v3) }))).toMatchObject({
      ok: true,
      card: { name: "From ccv3" },
    });
    expect(await read(pngWithText({ ccv3: huge, chara: cardChunk(v2) }))).toMatchObject({
      ok: true,
      card: { name: "From chara" },
    });
  });

  it("reads ordinary card text while compressed metadata is stripped before sharp", async () => {
    const result = await read(compressedMetadataPng("zTXt", { ccv3: cardChunk(v3) }));
    expect(result).toMatchObject({
      ok: true,
      card: { name: "From ccv3" },
      portrait: { width: 1, height: 1 },
    });
  });

  it("rejects an upload over the byte limit", async () => {
    expect(await read(new Uint8Array(CARD_LIMITS.uploadBytes + 1))).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("reads a card from a PNG whose image data inflates to 300 MB without inflating it", async () => {
    const bomb = bombCardPng({ ccv3: cardChunk(v3) });
    expect(bomb.byteLength).toBeLessThan(1_000_000);
    const before = process.memoryUsage().rss;
    const started = process.cpuUsage();
    const result = await read(bomb);
    expect(result).toMatchObject({ ok: true, card: { name: "From ccv3" } });
    const cpu = process.cpuUsage(started);
    expect(cpu.user + cpu.system).toBeLessThan(2_000_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
  });

  it("takes the portrait from the card image, without its text chunks", async () => {
    const result = await read(pngWithText({ ccv3: cardChunk(v3) }, 30, 45));
    if (!result.ok || !result.portrait) throw new Error("expected a portrait");
    expect([result.portrait.width, result.portrait.height]).toEqual([30, 45]);
    expect(Buffer.from(result.portrait.png).includes("ccv3")).toBe(false);
  });
});

describe("JSON cards", () => {
  it("reads V2 and V3 JSON files without a portrait", async () => {
    const result = await read(Buffer.from(JSON.stringify(v3)));
    expect(result).toMatchObject({ ok: true, card: { name: "From ccv3" } });
    expect(result).not.toHaveProperty("portrait");
    expect(await read(Buffer.from(JSON.stringify(v2)))).toMatchObject({ ok: true });
  });

  it.each([
    ["an SVG", svg],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0xfd])],
  ])("rejects %s", async (_label, bytes) => {
    expect((await read(bytes)).ok).toBe(false);
  });

  it("rejects a JPEG: cards are PNG or JSON", async () => {
    expect(await read(await jpegWithMetadata())).toEqual({ ok: false, error: "not_a_card" });
  });
});

describe("card URLs are never fetched", () => {
  afterEach(() => vi.restoreAllMocks());

  it("imports and exports a card full of URLs without any request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await read(pngWithText({ ccv3: cardChunk(v3) }));
    if (!result.ok) throw new Error(result.error);
    await cardToPng(result.card, result.portrait?.png);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.card).not.toHaveProperty("assets");
  });
});

describe("PNG export", () => {
  it("keeps a near-limit native card and a high-entropy portrait within the upload cap", async () => {
    const card = {
      ...blankCard("Large export"),
      characterNote: {
        prompt: "x".repeat(CARD_LIMITS.cardJsonBytes - 1_000),
        depth: 4,
        role: "system" as const,
      },
    };
    const portrait = await sharp(randomBytes(1024 * 1536 * 3), {
      raw: { width: 1024, height: 1536, channels: 3 },
    })
      .png()
      .toBuffer();
    const png = await cardToPng(card, portrait);
    expect(png.byteLength).toBeLessThanOrEqual(CARD_LIMITS.uploadBytes);
    expect(await read(png)).toMatchObject({ ok: true, card });
  });
  it("writes exactly one native chunk with valid CRCs and reads it back", async () => {
    const first = await read(pngWithText({ ccv3: cardChunk(v3) }, 30, 45));
    if (!first.ok) throw new Error(first.error);
    const png = await cardToPng(first.card, first.portrait?.png);
    const chunks = decode(png, { checkCrc: true }).text;
    expect(Object.keys(chunks)).toEqual(["ephemera"]);
    expect(JSON.parse(Buffer.from(chunks.ephemera ?? "", "base64").toString("utf8"))).toEqual(
      toCharacterFile(first.card),
    );
    expect(await read(png)).toMatchObject({
      ok: true,
      card: first.card,
      portrait: { width: 30, height: 45 },
    });
  });
  it("exports exact-boundary native Unicode data and refuses an oversized stored row", async () => {
    const card = {
      ...blankCard("Boundary"),
      characterNote: { prompt: "", depth: 4, role: "system" as const },
    };
    card.characterNote.prompt = "x".repeat(
      CARD_LIMITS.cardJsonBytes - utf8Bytes(serializeCharacter(card)),
    );
    expect(utf8Bytes(serializeCharacter(card))).toBe(CARD_LIMITS.cardJsonBytes);
    expect(await read(await cardToPng(card, undefined))).toMatchObject({ ok: true, card });
    card.characterNote.prompt += "界";
    await expect(cardToPng(card, undefined)).rejects.toThrow();
  });
  it("exports a card without a portrait on a plain placeholder", async () => {
    const result = normalizeCard(v2);
    if (!result.ok) throw new Error(result.error);
    const png = await cardToPng(result.card, undefined);
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([512, 768]);
    expect(await read(png)).toMatchObject({ ok: true, card: { name: "From chara" } });
  });
});
