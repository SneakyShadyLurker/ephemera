import { describe, expect, it } from "vitest";
import v2 from "../../test-fixtures/imports/v2-full.json" with { type: "json" };
import minimal from "../../test-fixtures/imports/v2-minimal.json" with { type: "json" };
import v3 from "../../test-fixtures/imports/v3-full.json" with { type: "json" };
import { generateRequestSchema } from "../chat.ts";
import { fitsNativeFile } from "../file-format.ts";
import { importWorldInfo } from "../lorebook/worldinfo.ts";
import { serializeCharacter, toCharacterFile } from "../native-files.ts";
import { EXAMPLE_SEPARATOR } from "../prompt/examples.ts";
import { FOLDED_SENTENCE } from "./import.ts";
import {
  blankCard,
  CARD_LIMITS,
  characterCardSchema,
  characterPatchSchema,
  normalizeCard,
  parseCardText,
  storedCharacterCardSchema,
  upgradeLegacyCharacterCard,
} from "./index.ts";

const LEGACY_KEYS = [
  "personality",
  "scenario",
  "exampleDialogue",
  "systemPrompt",
  "postHistoryInstructions",
] as const;

describe("foreign character import", () => {
  it.each([v2, v3, minimal])("converts supported synthetic cards to strict native data", (file) => {
    const result = normalizeCard(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(characterCardSchema.parse(result.card)).toEqual(result.card);
    for (const key of ["extensions", "assets", "group_only_greetings", "source", "creation_date"])
      expect(result.card).not.toHaveProperty(key);
    expect(normalizeCard(toCharacterFile(result.card))).toMatchObject({
      ok: true,
      card: result.card,
      version: 1,
    });
  });
  it("folds the removed foreign fields into the description in block order and reports it", () => {
    const result = normalizeCard(v2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of LEGACY_KEYS) expect(result.card).not.toHaveProperty(key);
    expect(result.card.description).toBe(
      [
        "{{char}} keeps the tide tables. Écrit à la main ✨ مرحبا",
        "<scenario>\nThe harbour office at dawn; {{user}} brings a letter.\n</scenario>",
        "<personality>\nexact, warm\n</personality>",
        "<example_dialogue>\n{{user}}: High tide?\n{{char}}: At 06:12.\n</example_dialogue>",
        "<instructions>\nWrite {{char}} carefully. {{original}}\n\nKeep replies short.\n</instructions>",
      ].join("\n\n"),
    );
    expect(result.report.changed).toContain(FOLDED_SENTENCE);
    const v3Result = normalizeCard(v3);
    expect(v3Result.ok && v3Result.report.changed).toContain(FOLDED_SENTENCE);
  });
  it("adds no blocks and no report line when every removed field is empty", () => {
    const result = normalizeCard(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.description).toBe("");
    expect(result.report.changed).not.toContain(FOLDED_SENTENCE);
    const blank = normalizeCard({
      spec: "chara_card_v2",
      data: { name: "Mara", description: "Keeps a lamp.", personality: " \n " },
    });
    expect(blank).toMatchObject({ ok: true, card: { description: "Keeps a lamp." } });
    expect(blank.ok && blank.report.changed).not.toContain(FOLDED_SENTENCE);
  });
  it("refuses a card whose folded description passes the text limit, naming the description", () => {
    const fits = "x".repeat(CARD_LIMITS.textLength);
    expect(
      normalizeCard({
        spec: "chara_card_v2",
        data: { name: "Mara", description: fits, personality: "Wry." },
      }),
    ).toEqual({ ok: false, error: "field_too_long", field: "description" });
    expect(
      normalizeCard({
        spec: "chara_card_v2",
        data: { name: "Mara", personality: `${fits}x` },
      }),
    ).toMatchObject({ ok: false, error: "field_too_long", field: "personality" });
  });
  it("retires the public flat V1 format while providing a raw saved-row converter", () => {
    const row = { name: "Mara", description: "Keeps <BOT>'s lamp.", first_mes: "Hi <USER>." };
    expect(normalizeCard(row).ok).toBe(false);
    expect(upgradeLegacyCharacterCard(row)).toMatchObject({
      description: "Keeps {{char}}'s lamp.",
      firstMessage: "Hi {{user}}.",
    });
  });
  it("coerces loose meaningful fields and discards transport metadata", () => {
    const result = normalizeCard({
      spec: "chara_card_v2",
      data: {
        name: " Mara ",
        first_mes: 17,
        alternate_greetings: null,
        tags: "Story,story",
        extensions: {},
      },
    });
    expect(result).toMatchObject({
      ok: true,
      card: { name: "Mara", firstMessage: "17", alternateGreetings: [], tags: ["Story"] },
    });
  });
  it("fits keywords, entry names and tags with an honest report", () => {
    const result = normalizeCard({
      spec: "chara_card_v3",
      data: {
        name: "Mara",
        tags: ["t".repeat(70)],
        character_book: {
          entries: [{ keys: ["x".repeat(201), "lamp"], name: "n".repeat(201), content: "Light." }],
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      report: {
        changed: [
          "Some lorebook keywords were left out to fit the keyword limits.",
          "Some lorebook entry names were shortened to fit the name limit.",
          "Some tags were shortened or left out to fit the tag limits.",
        ],
      },
    });
    if (result.ok) expect(result.card.lorebook?.entries[0]?.keys).toEqual(["lamp"]);
  });
  it("rejects malformed fields, overlong text and hostile nested extensions", () => {
    const bad = (data: object) =>
      normalizeCard({ spec: "chara_card_v2", data: { name: "Mara", ...data } });
    expect(bad({ description: {} }).ok).toBe(false);
    expect(bad({ description: "x".repeat(CARD_LIMITS.textLength + 1) })).toMatchObject({
      ok: false,
      error: "field_too_long",
    });
    let nested: object = {};
    for (let i = 0; i < 100; i++) nested = { child: nested };
    expect(bad({ extensions: nested }).ok).toBe(false);
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    );
    expect(bad({ extensions: hostile }).ok).toBe(true);
    expect({}).not.toHaveProperty("polluted");
  });
  it("keeps hostile text inert and normalizes foreign example separators once", () => {
    const result = normalizeCard({
      spec: "chara_card_v2",
      data: { name: "<script>name</script>", mes_example: "narration<START><BOT>: Hi <USER>." },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.name).toBe("<script>name</script>");
    expect(result.card.description).toBe(
      "<example_dialogue>\nnarration\n\n---\n\n{{char}}: Hi {{user}}.\n</example_dialogue>",
    );
  });
  it.each([
    [undefined, undefined],
    [0, "before"],
    [1, "after"],
    [2, "anTop"],
    [3, "anBottom"],
    [4, "depth"],
    [5, "examplesTop"],
    [6, "examplesBottom"],
    [7, undefined],
  ] as const)(
    "converts only example separators at foreign placement %j (%s)",
    (position, placement) => {
      const content = "@@depth 4\nPassage.<START><BOT>: Hi <USER> and {{group}}.";
      const expected = `Passage.${position === 5 || position === 6 ? EXAMPLE_SEPARATOR : "<START>"}{{char}}: Hi {{user}} and {{char}}.`;
      const entry = {
        keys: [],
        content,
        extensions: position === undefined ? {} : { position },
      };
      const card = normalizeCard({
        spec: "chara_card_v3",
        data: { name: "Mara", character_book: { entries: [entry] } },
      });
      const library = importWorldInfo({ entries: [{ key: [], content, position }] });
      expect(card.ok).toBe(true);
      expect(library.ok).toBe(true);
      if (!card.ok || !library.ok) return;
      for (const converted of [card.card.lorebook?.entries[0], library.book.entries[0]]) {
        expect(converted?.content).toBe(expected);
        if (position !== 7) expect(converted?.settings?.placement).toBe(placement);
        expect(converted?.enabled).toBe(position !== 7);
      }
    },
  );
});

describe("native character files and public bounds", () => {
  it("serializes and parses a strict native packet, including a BOM", () => {
    const card = blankCard("Mara");
    expect(JSON.parse(serializeCharacter(card))).toEqual({
      format: "ephemera.character",
      version: 2,
      data: card,
    });
    expect(parseCardText(`\uFEFF${serializeCharacter(card)}`)).toMatchObject({ ok: true, card });
    expect(parseCardText("{")).toMatchObject({ ok: false, error: "not_json" });
    expect(parseCardText(" ".repeat(CARD_LIMITS.cardJsonBytes + 1))).toMatchObject({
      ok: false,
      error: "too_large",
    });
  });
  it.each([
    { format: "unknown", version: 1 },
    { format: null, version: 1 },
    { version: 1 },
    { format: "ephemera.character", version: 3 },
    { format: "ephemera.lorebook", version: 1 },
    { format: "ephemera.character", version: 1, spec: "chara_card_v2" },
    { format: "ephemera.character", version: 1, extra: true },
  ])("fails closed on attempted native packets without foreign fallback", (markers) => {
    expect(
      normalizeCard({ ...markers, name: "Mara", first_mes: "Hi", data: blankCard("Mara") }).ok,
    ).toBe(false);
  });
  it("imports a version-1 native file through the fold and a version-2 file as is", () => {
    const legacy = {
      ...blankCard("Mara"),
      description: "Keeps a lamp {{personality}}.",
      personality: "Wry.",
      scenario: "",
      exampleDialogue: "",
      systemPrompt: "{{original}} Terse.",
      postHistoryInstructions: "",
      firstMessage: "Hi {{scenario}}.",
    };
    const folded = normalizeCard({ format: "ephemera.character", version: 1, data: legacy });
    expect(folded).toMatchObject({
      ok: true,
      card: {
        description:
          "Keeps a lamp {{personality}}.\n\n<personality>\nWry.\n</personality>\n\n<instructions>\n{{original}} Terse.\n</instructions>",
        firstMessage: "Hi {{scenario}}.",
      },
      report: { changed: [FOLDED_SENTENCE] },
    });
    if (folded.ok) for (const key of LEGACY_KEYS) expect(folded.card).not.toHaveProperty(key);
    const current = { ...blankCard("Mara"), description: "{{personality}} stays." };
    expect(normalizeCard({ format: "ephemera.character", version: 2, data: current })).toEqual({
      ok: true,
      card: current,
      version: 1,
      report: { kept: [], changed: [], skipped: [] },
    });
    expect(
      normalizeCard({ format: "ephemera.character", version: 1, data: blankCard("Mara") }).ok,
    ).toBe(false);
    expect(normalizeCard({ format: "ephemera.character", version: 2, data: legacy }).ok).toBe(
      false,
    );
    expect(
      normalizeCard({
        format: "ephemera.character",
        version: 1,
        data: { ...legacy, description: "x".repeat(CARD_LIMITS.textLength) },
      }),
    ).toMatchObject({ ok: false, error: "field_too_long", field: "description" });
  });
  it("upgrades version-1, current and foreign stored rows", () => {
    const legacy = {
      ...blankCard("Mara"),
      description: "Desc.",
      personality: "",
      scenario: "At sea.",
      exampleDialogue: "",
      systemPrompt: "",
      postHistoryInstructions: "",
    };
    const upgraded = upgradeLegacyCharacterCard(legacy);
    expect(upgraded).toEqual({
      ...blankCard("Mara"),
      description: "Desc.\n\n<scenario>\nAt sea.\n</scenario>",
    });
    expect(upgradeLegacyCharacterCard(upgraded)).toEqual(upgraded);
    const empty = upgradeLegacyCharacterCard({ ...legacy, scenario: "" });
    expect(empty).toEqual({ ...blankCard("Mara"), description: "Desc." });
    const current = { ...blankCard("Mara"), description: "{{personality}} kept." };
    expect(upgradeLegacyCharacterCard(current)).toEqual(current);
    expect(upgradeLegacyCharacterCard({ name: "Mara", scenario: "<BOT> at sea." })).toEqual({
      ...blankCard("Mara"),
      description: "<scenario>\n{{char}} at sea.\n</scenario>",
    });
  });
  it("counts the native envelope's UTF-8 bytes and leaves oversized old rows reducible", () => {
    const card = {
      ...blankCard("Mara"),
      alternateGreetings: Array(40).fill("x".repeat(CARD_LIMITS.textLength)),
    };
    expect(storedCharacterCardSchema.safeParse(card).success).toBe(true);
    expect(characterCardSchema.safeParse(card).success).toBe(false);
    expect(fitsNativeFile("ephemera.character", card)).toBe(false);
    expect(() => serializeCharacter(card)).toThrow();
    expect(characterCardSchema.safeParse({ ...card, alternateGreetings: [] }).success).toBe(true);
  });
  it.each([
    "chat",
    "messages",
    "swipes",
    "draft",
    "memories",
    "cast",
    "portrait",
    "id",
    "revision",
    "extensions",
  ])("refuses forbidden native data %s", (key) => {
    expect(characterCardSchema.safeParse({ ...blankCard("Mara"), [key]: [] }).success).toBe(false);
    expect(characterPatchSchema.safeParse({ [key]: [] }).success).toBe(false);
  });
  it("does not accept a card as a generation request", () => {
    expect(generateRequestSchema.safeParse(blankCard("Mara")).success).toBe(false);
  });
});
