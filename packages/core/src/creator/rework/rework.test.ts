import { describe, expect, it } from "vitest";
import { CARD_LIMITS } from "../../card/limits.ts";
import type { Lorebook, LorebookEntry } from "../../card/schema.ts";
import { newEntry } from "../../lorebook/rules.ts";
import { parseFieldKey, TEXT_KEYS } from "./fields.ts";
import {
  applyChanges,
  fieldKey,
  fieldLabel,
  fieldText,
  type PlacedChange,
  parseReworkAnswer,
  placeChanges,
  type RawChange,
  REWORK_LIMITS,
  REWORK_SYSTEM_PROMPT,
  type ReworkCard,
  type ReworkField,
  type ReworkPlacement,
  readChanges,
  reworkCardSchema,
  reworkEventSchema,
  reworkPrompt,
  reworkRequestSchema,
} from "./index.ts";

const ID = "4b0d3c2e-8f1a-4c5b-9d6e-7f8a9b0c1d2e";

const entry = (fields: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: ["harbour", "quay"],
  content: "The harbour smells of tar.",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...fields,
});

const book = (entries: LorebookEntry[] = [entry({ comment: "The harbour" })]): Lorebook => ({
  entries,
});

const card = (fields: Partial<ReworkCard> = {}): ReworkCard => ({
  name: "Ada Reed",
  description: "Ada is 24 and graduated in 2009.",
  personality: "Calm.",
  scenario: "Ada waits for {{user}} at the gate.",
  firstMessage: "Ada looks up.",
  alternateGreetings: ["Rain on the roof.", "Morning at the mill."],
  exampleDialogue: "<START>\n{{char}}: Hello.",
  systemPrompt: "",
  postHistoryInstructions: "",
  creatorNotes: "A placeholder pitch.",
  tags: ["drama", "slice of life"],
  characterNote: { prompt: "Ada never lies.", depth: 4, role: "system" },
  lorebook: book(),
  ...fields,
});

describe("rework schemas", () => {
  it("round-trips a card with and without a book and a note", () => {
    const full = card();
    expect(reworkCardSchema.parse(full)).toEqual(full);
    const bare = card({ lorebook: null, characterNote: null });
    expect(reworkCardSchema.parse(bare)).toEqual(bare);
  });

  it("refuses fields the rework neither sends nor changes", () => {
    expect(reworkCardSchema.safeParse({ ...card(), nickname: "Ada" }).success).toBe(false);
  });

  const request = (fields: Record<string, unknown> = {}) => ({
    characterId: ID,
    model: "m",
    request: "Make her a decade older.",
    portrait: true,
    card: card(),
    ...fields,
  });

  it("accepts a request, with and without a persona", () => {
    expect(reworkRequestSchema.safeParse(request()).success).toBe(true);
    expect(reworkRequestSchema.safeParse(request({ personaId: ID })).success).toBe(true);
  });

  it("refuses an unknown key, an overlong or empty request and a non-UUID id", () => {
    expect(reworkRequestSchema.safeParse(request({ extra: 1 })).success).toBe(false);
    const long = "x".repeat(REWORK_LIMITS.requestLength + 1);
    expect(reworkRequestSchema.safeParse(request({ request: long })).success).toBe(false);
    const most = "x".repeat(REWORK_LIMITS.requestLength);
    expect(reworkRequestSchema.safeParse(request({ request: most })).success).toBe(true);
    expect(reworkRequestSchema.safeParse(request({ request: "  " })).success).toBe(false);
    expect(reworkRequestSchema.safeParse(request({ characterId: "42" })).success).toBe(false);
    expect(reworkRequestSchema.safeParse(request({ personaId: "42" })).success).toBe(false);
  });

  it("reads each stream event and refuses others", () => {
    for (const event of [
      { type: "delta", text: "<change>" },
      { type: "result", problems: [] },
      { type: "result", problems: ["incomplete", "no_summary"] },
      { type: "error", code: "context_window_unknown" },
    ]) {
      expect(reworkEventSchema.parse(event)).toEqual(event);
    }
    expect(reworkEventSchema.safeParse({ type: "result", problems: ["odd"] }).success).toBe(false);
    expect(reworkEventSchema.safeParse({ type: "error", code: "comfyui" }).success).toBe(false);
  });
});

describe("rework field keys", () => {
  const accepted: [string, ReworkField][] = [
    ["name", { kind: "text", key: "name" }],
    ["description", { kind: "text", key: "description" }],
    ["personality", { kind: "text", key: "personality" }],
    ["scenario", { kind: "text", key: "scenario" }],
    ["firstMessage", { kind: "text", key: "firstMessage" }],
    ["exampleDialogue", { kind: "text", key: "exampleDialogue" }],
    ["systemPrompt", { kind: "text", key: "systemPrompt" }],
    ["postHistoryInstructions", { kind: "text", key: "postHistoryInstructions" }],
    ["creatorNotes", { kind: "text", key: "creatorNotes" }],
    ["characterNote", { kind: "text", key: "characterNote" }],
    ["tags", { kind: "tags" }],
    ["alternate_greeting_1", { kind: "alternate", index: 0 }],
    ["alternate_greeting_12", { kind: "alternate", index: 11 }],
    ["alternate_greeting_new", { kind: "alternate_new" }],
    ["entry_3", { kind: "entry", index: 2, part: "content" }],
    ["entry_3_name", { kind: "entry", index: 2, part: "name" }],
    ["entry_3_keys", { kind: "entry", index: 2, part: "keys" }],
    ["entry_new_1", { kind: "entry_new", number: 1, part: "content" }],
    ["entry_new_1_name", { kind: "entry_new", number: 1, part: "name" }],
    ["entry_new_12_keys", { kind: "entry_new", number: 12, part: "keys" }],
  ];

  it("reads every key the prompt offers, and writes each back", () => {
    for (const [key, field] of accepted) {
      expect(parseFieldKey(key)).toEqual(field);
      expect(fieldKey(field)).toBe(key);
    }
  });

  it("reads alternate_greeting_new the same way each time it occurs", () => {
    expect(parseFieldKey("alternate_greeting_new")).toEqual(
      parseFieldKey("alternate_greeting_new"),
    );
  });

  it("rejects keys the prompt does not offer", () => {
    for (const key of [
      "alternate_greeting_0",
      "alternate_greeting_01",
      "alternateGreetings",
      "entry_x",
      "entry_0",
      "entry_new_0",
      "entry_3_content",
      "entry_new",
      "nickname",
      "creator",
      "authors_note",
      "lorebook",
      "Description",
      " description",
      "",
    ]) {
      expect(parseFieldKey(key), key).toBeUndefined();
    }
  });

  it("gives each field's current text as the model reads it", () => {
    const sent = card();
    const text = (key: string) => {
      const field = parseFieldKey(key);
      if (field === undefined) throw new Error(key);
      return fieldText(sent, field);
    };
    expect(text("description")).toBe(sent.description);
    expect(text("characterNote")).toBe("Ada never lies.");
    expect(text("tags")).toBe("drama, slice of life");
    expect(text("alternate_greeting_2")).toBe("Morning at the mill.");
    expect(text("alternate_greeting_new")).toBe("");
    expect(text("entry_1")).toBe("The harbour smells of tar.");
    expect(text("entry_1_name")).toBe("The harbour");
    expect(text("entry_1_keys")).toBe("harbour, quay");
    expect(text("entry_new_1_keys")).toBe("");
  });

  it("reads an entry's name from its comment, else its name field", () => {
    const named = card({ lorebook: book([entry({ name: "Quay", comment: " " })]) });
    expect(fieldText(named, { kind: "entry", index: 0, part: "name" })).toBe("Quay");
    const blank = card({ lorebook: book([entry()]) });
    expect(fieldText(blank, { kind: "entry", index: 0, part: "name" })).toBe("");
  });

  it("has no text for a missing alternate, entry or note", () => {
    const sent = card({ characterNote: null });
    expect(fieldText(sent, { kind: "alternate", index: 2 })).toBeUndefined();
    expect(fieldText(sent, { kind: "entry", index: 1, part: "content" })).toBeUndefined();
    expect(fieldText(sent, { kind: "text", key: "characterNote" })).toBeUndefined();
    const bookless = card({ lorebook: null });
    expect(fieldText(bookless, { kind: "entry", index: 0, part: "keys" })).toBeUndefined();
  });

  it("labels fields for the review", () => {
    const sent = card({ lorebook: book([entry({ comment: "The harbour" }), entry()]) });
    expect(fieldLabel({ kind: "text", key: "description" }, sent)).toBe("Description");
    expect(fieldLabel({ kind: "alternate", index: 1 }, sent)).toBe("Alternate 2");
    expect(fieldLabel({ kind: "entry", index: 0, part: "keys" }, sent)).toBe(
      "Entry 1: The harbour, keywords",
    );
    expect(fieldLabel({ kind: "entry", index: 1, part: "content" }, sent)).toBe("Entry 2: harbour");
    expect(fieldLabel({ kind: "entry", index: 4, part: "name" }, sent)).toBe("Entry 5, name");
    expect(fieldLabel({ kind: "entry_new", number: 1, part: "content" }, sent)).toBe("New entry 1");
  });
});

interface Block {
  field?: string;
  why?: string;
  find?: string;
  replace?: string;
}

/** A change block as a model writes it, each tag on its own line. */
const block = ({ field, why, find, replace }: Block): string =>
  [
    "<change>",
    ...(field === undefined ? [] : [`<field>${field}</field>`]),
    ...(why === undefined ? [] : [`<why>${why}</why>`]),
    ...(find === undefined ? [] : [`<find>\n${find}\n</find>`]),
    ...(replace === undefined ? [] : [`<replace>\n${replace}\n</replace>`]),
    "</change>",
  ].join("\n");

const THREE: Block[] = [
  { field: "description", why: "Age raised.", find: "is 24", replace: "is 34" },
  { field: "tags", why: "Tag added.", find: "", replace: "drama, slice of life, harbour" },
  { field: "entry_1_keys", why: "", find: "", replace: "harbour, customs" },
];
const SUMMARY = "<summary>Ada is ten years older.</summary>";
const complete = `${THREE.map(block).join("\n")}\n${SUMMARY}`;

const expected = (blocks: Block[]): Omit<RawChange, "at">[] =>
  blocks.map(({ field = "", why = "", find = "", replace = "" }) => ({
    field,
    why,
    find,
    replace,
  }));

describe("rework answer parsing", () => {
  it("reads a complete answer's changes in order and its summary", () => {
    const answer = parseReworkAnswer(complete);
    expect(answer.changes).toEqual(expected(THREE).map((change, at) => ({ ...change, at })));
    expect(answer.summary).toBe("Ada is ten years older.");
    expect(answer.problems).toEqual([]);
    expect(answer.malformed).toBe(0);
  });

  it("keeps find and replace byte for byte but for one newline on each side", () => {
    const text =
      "<change><field> name </field><why>  Why.  </why>" +
      "<find>\n\n  two  spaces\n\n</find><replace> x </replace></change>";
    const [change] = parseReworkAnswer(text).changes;
    expect(change).toEqual({
      field: "name",
      why: "Why.",
      find: "\n  two  spaces\n",
      replace: " x ",
      at: 0,
    });
  });

  it("reads a missing why as empty, and a missing find only for a new item", () => {
    const answer = parseReworkAnswer(
      [
        block({ field: "name", find: "", replace: "Ada Voss" }),
        "<change><field>name</field><find></find><replace>Ada Rhee</replace></change>",
        block({ field: "description", replace: "Everything." }),
        block({ field: "alternate_greeting_new", replace: "A new morning." }),
        block({ field: "entry_new_1_keys", replace: "mill" }),
      ].join("\n"),
    );
    expect(answer.changes).toEqual([
      { field: "name", why: "", find: "", replace: "Ada Voss", at: 0 },
      { field: "name", why: "", find: "", replace: "Ada Rhee", at: 1 },
      { field: "alternate_greeting_new", why: "", find: "", replace: "A new morning.", at: 2 },
      { field: "entry_new_1_keys", why: "", find: "", replace: "mill", at: 3 },
    ]);
    // Without its find, a change to an existing field is malformed, never a whole replacement.
    expect(answer.malformed).toBe(1);
  });

  it("reads each change exactly once while streaming, only after it closed", () => {
    const read: RawChange[] = [];
    let next = 0;
    for (let end = 7; end < complete.length + 7; end += 7) {
      const partial = complete.slice(0, end);
      const result = readChanges(partial, next, read.length);
      expect(result.next).toBeGreaterThanOrEqual(next);
      for (const change of result.changes) {
        const closed = complete.indexOf("</change>", complete.indexOf(change.replace));
        expect(partial.length).toBeGreaterThanOrEqual(closed + "</change>".length);
      }
      read.push(...result.changes);
      next = result.next;
    }
    expect(read).toEqual(parseReworkAnswer(complete).changes);
  });

  it("does not read a block cut off at the end, and marks the answer incomplete", () => {
    const cut = `${block(THREE[0] ?? {})}\n<change>\n<field>name</field>\n<replace>Ada`;
    const answer = parseReworkAnswer(cut);
    expect(answer.changes).toHaveLength(1);
    expect(answer.problems).toEqual(["incomplete", "no_summary"]);
    expect(readChanges(cut, 0).next).toBe(block(THREE[0] ?? {}).length);
  });

  it("treats a literal <change> inside a find as text", () => {
    const text = block({ field: "description", find: "say <change> here", replace: "say it" });
    const answer = parseReworkAnswer(`${text}\n${SUMMARY}`);
    expect(answer.changes.map((change) => change.find)).toEqual(["say <change> here"]);
    expect(answer.malformed).toBe(0);
  });

  it("skips malformed blocks without throwing", () => {
    const nested = `<change>\n<field>name</field>\n${block({ field: "name", replace: "B" })}`;
    const answer = parseReworkAnswer(
      [
        block({ why: "No field.", replace: "A" }),
        block({ field: "", replace: "A" }),
        block({ field: "name", find: "A" }),
        "<change><field>name</field><replace>open</change>",
        nested,
        block({ field: "name", replace: "No find." }),
        block({ field: "name", find: "", replace: "Kept" }),
        SUMMARY,
      ].join("\n"),
    );
    expect(answer.changes).toEqual([{ field: "name", why: "", find: "", replace: "Kept", at: 0 }]);
    expect(answer.malformed).toBe(6);
    expect(answer.problems).toEqual([]);
  });

  it("reports a missing or empty summary", () => {
    expect(parseReworkAnswer(block(THREE[0] ?? {})).problems).toEqual(["no_summary"]);
    expect(parseReworkAnswer("<summary>  </summary>").summary).toBeNull();
    expect(parseReworkAnswer("<summary>Nothing to change.</summary>")).toEqual({
      changes: [],
      summary: "Nothing to change.",
      problems: [],
      malformed: 0,
    });
  });
});

const TEXT_FIELDS: ReworkField[] = TEXT_KEYS.map((key) => ({ kind: "text", key }));

let arrival = 0;
const raw = (field: string, find: string, replace: string, why = ""): RawChange => ({
  field,
  why,
  find,
  replace,
  at: arrival++,
});

const placed = (placement: ReworkPlacement | undefined): PlacedChange => {
  if (!placement?.ok) throw new Error(`not placed: ${placement?.reason}`);
  return placement.change;
};
const reasons = (placements: ReworkPlacement[]) =>
  placements.map((placement) => (placement.ok ? "placed" : placement.reason));

/** The passage a placed change covers in the field as sent. */
const covered = (sent: ReworkCard, change: PlacedChange): string =>
  (fieldText(sent, change.field) ?? "").slice(change.start, change.end);

describe("rework anchors", () => {
  it("places an exact, unique find at its offsets in the original", () => {
    const sent = card();
    const change = placed(placeChanges(sent, [raw("description", "is 24", "is 34")])[0]);
    expect(change).toMatchObject({ start: 4, end: 9, whole: false, replace: "is 34" });
    expect(covered(sent, change)).toBe("is 24");
  });

  it("places a find that matches only with whitespace collapsed, on original offsets", () => {
    const sent = card({ description: "One  two \n\twords and   more." });
    const change = placed(placeChanges(sent, [raw("description", "two words", "x")])[0]);
    expect(covered(sent, change)).toBe("two \n\twords");
    const reverse = card({ description: "Say two words now." });
    const back = placed(placeChanges(reverse, [raw("description", "two  words\n", "x")])[0]);
    expect(covered(reverse, back)).toBe("two words");
  });

  it("never matches across a different count of non-whitespace characters", () => {
    const sent = card({ description: "two wo rds" });
    expect(reasons(placeChanges(sent, [raw("description", "two words", "x")]))).toEqual([
      "missing",
    ]);
    const spaced = card({ description: "twowords" });
    expect(reasons(placeChanges(spaced, [raw("description", "two words", "x")]))).toEqual([
      "missing",
    ]);
  });

  it("refuses an ambiguous find, exact or collapsed, and a missing one", () => {
    const sent = card({ description: "Ada smiles. Ada  smiles." });
    expect(
      reasons(
        placeChanges(sent, [
          raw("description", "smiles", "x"),
          raw("description", "Ada smiles", "x"),
          raw("description", "frowns", "x"),
          raw("description", "   ", "x"),
        ]),
      ),
    ).toEqual(["ambiguous", "placed", "missing", "missing"]);
    const overlapping = card({ description: "aaa" });
    expect(reasons(placeChanges(overlapping, [raw("description", "aa", "b")]))).toEqual([
      "ambiguous",
    ]);
  });

  it("keeps the first of two overlapping changes and places disjoint ones", () => {
    const sent = card({ description: "Ada is 24 and graduated in 2009." });
    const placements = placeChanges(sent, [
      raw("description", "is 24 and", "is 34 and"),
      raw("description", "24 and graduated", "x"),
      raw("description", "in 2009", "in 1999"),
      raw("description", "", "Whole."),
    ]);
    expect(reasons(placements)).toEqual(["placed", "overlap", "placed", "overlap"]);
    const changes = placements.flatMap((placement) => (placement.ok ? [placement.change] : []));
    expect(changes.map((change) => covered(sent, change))).toEqual(["is 24 and", "in 2009"]);
    expect(
      reasons(
        placeChanges(sent, [raw("personality", "", "Warm."), raw("personality", "Calm", "x")]),
      ),
    ).toEqual(["placed", "overlap"]);
  });

  it("replaces the whole field for an empty find, and always for a new item", () => {
    const sent = card();
    const placements = placeChanges(sent, [
      raw("personality", "", "Warm."),
      raw("name", "", "Ada Voss"),
      raw("tags", "", "drama, harbour"),
      raw("entry_1_name", "", "The quay"),
      raw("entry_1_keys", "", "quay, customs"),
      raw("alternate_greeting_new", "anything", "A new morning."),
      raw("alternate_greeting_new", "", "Another morning."),
      raw("entry_new_1", "anything", "New lore."),
      raw("entry_new_1_keys", "", "lore"),
    ]);
    expect(reasons(placements)).toEqual(Array(9).fill("placed"));
    for (const placement of placements) {
      const change = placed(placement);
      expect(change.whole).toBe(true);
      expect(change.start).toBe(0);
      expect(covered(sent, change)).toBe(fieldText(sent, change.field));
    }
  });

  it("removes only alternates and entries, never blanks another field", () => {
    const sent = card();
    expect(
      reasons(
        placeChanges(sent, [
          raw("alternate_greeting_1", "", ""),
          raw("entry_1", "", ""),
          raw("description", "", ""),
          raw("firstMessage", "", ""),
          raw("name", "Ada Reed", ""),
          raw("tags", "", ""),
          raw("entry_1_keys", "", ""),
          raw("alternate_greeting_new", "", ""),
          raw("description", "is 24 ", ""),
        ]),
      ),
    ).toEqual(["placed", "placed", "empty", "empty", "empty", "empty", "empty", "empty", "placed"]);
  });

  it("clears the personality and scenario only after a conversion of the description", () => {
    const sent = card();
    expect(
      reasons(
        placeChanges(sent, [
          raw("personality", "", ""),
          raw("description", "", "<ada_reed>\n<personality>Calm.</personality>\n</ada_reed>"),
          raw("personality", "", ""),
          raw("scenario", "", ""),
        ]),
      ),
    ).toEqual(["no_conversion", "placed", "placed", "placed"]);
    // A find that copies the whole field counts as whole: it neither clears without a
    // conversion nor empties the description, and a conversion written so is one.
    expect(
      reasons(
        placeChanges(sent, [
          raw("personality", sent.personality, ""),
          raw("description", ` ${sent.description} `, ""),
          raw("description", sent.description, "<ada_reed>\nCalm.\n</ada_reed>"),
          raw("personality", sent.personality, ""),
        ]),
      ),
    ).toEqual(["no_conversion", "empty", "placed", "placed"]);
    // A partial edit of the description is no conversion.
    expect(
      reasons(
        placeChanges(sent, [raw("description", "is 24 ", "is 25 "), raw("personality", "", "")]),
      ),
    ).toEqual(["placed", "no_conversion"]);
  });

  it("applies a cleared field as empty beside its conversion", () => {
    const sent = card();
    const changes = placeChanges(sent, [
      raw("description", "", "<ada_reed>\n<personality>Calm.</personality>\n</ada_reed>"),
      raw("personality", "", ""),
    ]).map(placed);
    const { next } = applyChanges(sent, changes);
    expect(next.personality).toBe("");
    expect(next.description).toContain("<ada_reed>");
  });

  it("lets an entry's removal and the edits of its other parts overlap: the first to arrive wins", () => {
    const sent = card({ lorebook: book([entry({ comment: "One" }), entry()]) });
    expect(
      reasons(
        placeChanges(sent, [
          raw("entry_1", "", ""),
          raw("entry_1_name", "", "Renamed"),
          raw("entry_1_keys", "", "quay, customs"),
          raw("entry_2_name", "", "Second"),
        ]),
      ),
    ).toEqual(["placed", "overlap", "overlap", "placed"]);
    expect(
      reasons(
        placeChanges(sent, [
          raw("entry_1_name", "", "Renamed"),
          raw("entry_1_keys", "", "quay, customs"),
          raw("entry_1", "", ""),
          raw("entry_2", "", ""),
        ]),
      ),
    ).toEqual(["placed", "placed", "overlap", "placed"]);
  });

  it("refuses unknown keys and fields the card lacks", () => {
    const sent = card({ characterNote: null, lorebook: null });
    const placements = placeChanges(sent, [
      raw("nickname", "", "Ada"),
      raw("characterNote", "", "A note."),
      raw("alternate_greeting_3", "", "Rain."),
      raw("entry_1", "", "Lore."),
    ]);
    expect(reasons(placements)).toEqual(Array(4).fill("no_such_field"));
    expect(placements[0]).toMatchObject({ ok: false, field: null, replace: "Ada" });
    expect(placements[1]).toMatchObject({ field: { kind: "text", key: "characterNote" } });
  });

  it("refuses a change that takes a field past its limit", () => {
    const sent = card({ description: `a${"x".repeat(CARD_LIMITS.textLength - 2)}` });
    const tags = Array.from({ length: CARD_LIMITS.tags + 1 }, (_, i) => `t${i}`).join(", ");
    expect(
      reasons(
        placeChanges(sent, [
          raw("description", "a", "aaa"),
          raw("name", "", "n".repeat(CARD_LIMITS.nameLength + 1)),
          raw("tags", "", tags),
          raw("entry_1_name", "", "n".repeat(CARD_LIMITS.shortTextLength + 1)),
          raw("description", "", "short"),
        ]),
      ),
    ).toEqual(["too_long", "too_long", "too_long", "too_long", "placed"]);
  });

  it("is deterministic and keeps arrival order", () => {
    const sent = card();
    const changes = [raw("description", "is 24", "is 34"), raw("nickname", "", "x")];
    expect(placeChanges(sent, changes)).toEqual(placeChanges(sent, changes));
    expect(
      placeChanges(sent, changes).map((placement) =>
        placement.ok ? placement.change.at : placement.at,
      ),
    ).toEqual(changes.map((change) => change.at));
  });
});

/** Places and applies changes against the card, every placed change accepted. */
function rework(sent: ReworkCard, changes: RawChange[]) {
  const placements = placeChanges(sent, changes);
  expect(reasons(placements)).toEqual(Array(changes.length).fill("placed"));
  const applied = applyChanges(sent, placements.map(placed));
  expect(reworkCardSchema.safeParse({ ...sent, ...applied.next }).success).toBe(true);
  return applied;
}

describe("rework application", () => {
  it("applies two changes in one field without disturbing each other's offsets", () => {
    const sent = card({ description: "Ada is 24 and graduated in 2009. She is tall." });
    const { next, touched } = rework(sent, [
      raw("description", "in 2009", "in 1999, top of her class"),
      raw("description", "is 24", "is 34"),
    ]);
    expect(next).toEqual({
      description: "Ada is 34 and graduated in 1999, top of her class. She is tall.",
    });
    expect(touched).toEqual(["description"]);
  });

  it("leaves untouched fields out", () => {
    const { next, touched } = rework(card(), []);
    expect(next).toEqual({});
    expect(touched).toEqual([]);
  });

  it("resolves greeting indexes against the sent card, then drops removals and appends new ones", () => {
    const sent = card({ alternateGreetings: ["One.", "Two.", "Three."] });
    const { next } = rework(sent, [
      raw("alternate_greeting_new", "", "Four."),
      raw("alternate_greeting_1", "", ""),
      raw("alternate_greeting_3", "Three", "Third"),
      raw("alternate_greeting_new", "", "Five."),
    ]);
    expect(next).toEqual({ alternateGreetings: ["Two.", "Third.", "Four.", "Five."] });
  });

  it("normalizes tags as the prompt asks", () => {
    const { next } = rework(card(), [raw("tags", "", "Drama, slice of life,\n drama ,, Harbour ")]);
    expect(next.tags).toEqual(["drama", "slice of life", "harbour"]);
    const long = rework(card(), [raw("tags", "", "x".repeat(CARD_LIMITS.tagLength + 5))]);
    expect(long.next.tags?.[0]).toHaveLength(CARD_LIMITS.tagLength);
  });

  it("writes the Character's Note prompt and keeps its depth and role", () => {
    const sent = card({ characterNote: { prompt: "Ada never lies.", depth: 2, role: "user" } });
    const { next } = rework(sent, [raw("characterNote", "never", "rarely")]);
    expect(next.characterNote).toEqual({ prompt: "Ada rarely lies.", depth: 2, role: "user" });
  });

  it("edits an entry's content, keys and name", () => {
    const sent = card({
      lorebook: book([
        entry({ comment: "The harbour", name: "harbour" }),
        entry({ comment: "The mill" }),
      ]),
    });
    const { next, touched } = rework(sent, [
      raw("entry_1", "tar", "tar and salt"),
      raw("entry_1_keys", "", "Harbour, customs\nharbour"),
      raw("entry_1_name", "", "The port"),
      raw("entry_2_name", "", "The old mill"),
    ]);
    expect(touched).toEqual(["lorebook"]);
    const [harbour, mill] = next.lorebook?.entries ?? [];
    expect(harbour).toEqual({
      ...sent.lorebook?.entries[0],
      content: "The harbour smells of tar and salt.",
      keys: ["Harbour", "customs", "harbour"],
      comment: "The port",
      name: "The port",
    });
    expect(mill).toEqual({ ...sent.lorebook?.entries[1], comment: "The old mill" });
    expect(mill).not.toHaveProperty("name");
  });

  it("removes an entry whose whole content is emptied, and keeps book settings", () => {
    const sent = card({
      lorebook: {
        ...book([entry({ comment: "A" }), entry({ comment: "B" })]),
        scanDepth: 4,
      },
    });
    const { next } = rework(sent, [raw("entry_1", "", ""), raw("entry_2", "tar", "pitch")]);
    expect(next.lorebook?.scanDepth).toBe(4);
    expect(next.lorebook?.entries.map((e) => [e.comment, e.content])).toEqual([
      ["B", "The harbour smells of pitch."],
    ]);
  });

  it("combines a new entry's parts into one entry, appended in order of their numbers", () => {
    const sent = card({ lorebook: book([entry({ id: 4, insertionOrder: 50 })]) });
    const { next } = rework(sent, [
      raw("entry_new_2_keys", "", "mill"),
      raw("entry_new_1", "", "The customs house stands on the quay."),
      raw("entry_new_2", "", "The mill grinds at night."),
      raw("entry_new_1_name", "", "Customs"),
      raw("entry_new_1_keys", "", "customs, quay"),
    ]);
    const [, first, second] = next.lorebook?.entries ?? [];
    const base = sent.lorebook?.entries ?? [];
    expect(first).toEqual({
      ...newEntry(base),
      content: "The customs house stands on the quay.",
      comment: "Customs",
      name: "Customs",
      keys: ["customs", "quay"],
    });
    expect(second).toMatchObject({ content: "The mill grinds at night.", keys: ["mill"], id: 6 });
    expect(first).toMatchObject({ id: 5, insertionOrder: 60, enabled: true, constant: false });
  });

  it("gives a card without a book one for its new entries", () => {
    const sent = card({ lorebook: null });
    const { next } = rework(sent, [raw("entry_new_1", "", "Lore.")]);
    expect(next.lorebook).toEqual({
      entries: [{ ...newEntry([]), content: "Lore." }],
    });
  });

  it("places a find in the name, tags, an entry's title and keywords, and keeps the rest", () => {
    const sent = card({
      tags: ["drama", "slice of life"],
      lorebook: book([entry({ comment: "The harbour ledger", keys: ["harbour", "quay"] })]),
    });
    const placements = placeChanges(sent, [
      raw("name", "Reed", "Voss"),
      raw("tags", "drama", "romance"),
      raw("entry_1_name", "harbour", "customs"),
      raw("entry_1_keys", "quay", "pier"),
    ]);
    for (const placement of placements) expect(placed(placement).whole).toBe(false);
    const { next } = rework(sent, [
      raw("name", "Reed", "Voss"),
      raw("tags", "drama", "romance"),
      raw("entry_1_name", "harbour", "customs"),
      raw("entry_1_keys", "quay", "pier"),
    ]);
    expect(next.name).toBe("Ada Voss");
    expect(next.tags).toEqual(["romance", "slice of life"]);
    expect(next.lorebook?.entries[0]).toMatchObject({
      comment: "The customs ledger",
      keys: ["harbour", "pier"],
    });
  });

  it("keeps a regex keyword's commas when another keyword is added or the list is rewritten", () => {
    const sent = card({
      lorebook: book([entry({ comment: "Bells", keys: ["/ab{1,3}/", "harbour"] })]),
    });
    expect(fieldText(sent, { kind: "entry", index: 0, part: "keys" })).toBe("/ab{1,3}/, harbour");
    const added = rework(sent, [raw("entry_1_keys", "harbour", "harbour, customs")]);
    expect(added.next.lorebook?.entries[0]?.keys).toEqual(["/ab{1,3}/", "harbour", "customs"]);
    const rewritten = rework(sent, [raw("entry_1_keys", "", "/ab{1,3}/, harbour, quay")]);
    expect(rewritten.next.lorebook?.entries[0]?.keys).toEqual(["/ab{1,3}/", "harbour", "quay"]);
  });

  it("keeps untouched raw regex, comma phrases, newlines, whitespace and duplicates verbatim", () => {
    const keys = [
      "",
      "   ",
      "ab{1,3}",
      "iron, crown",
      "north\nsouth",
      "  padded  ",
      "same",
      "same",
      "harbour",
    ];
    const sent = card({ lorebook: book([entry({ keys, useRegex: true })]) });
    expect(fieldText(sent, { kind: "entry", index: 0, part: "keys" })).toBe(keys.join(", "));
    const changes = placeChanges(sent, [raw("entry_1_keys", "harbour", "pier")]).map(placed);
    const applied = applyChanges(sent, changes);
    expect(applied.next.lorebook?.entries[0]?.keys).toEqual([...keys.slice(0, -1), "pier"]);
    expect(applied.touched).toEqual(["lorebook"]);
    expect(applyChanges(sent, []).next).toEqual({});
    expect(sent.lorebook?.entries[0]?.keys).toEqual(keys);
    // Undo's touched-field snapshot restores the exact original list.
    const restored = { ...sent, ...applied.next, lorebook: sent.lorebook };
    expect(restored.lorebook?.entries[0]?.keys).toEqual(keys);
  });

  it("keeps unedited literal delimiters within changed keys and applies independent passages", () => {
    const sent = card({
      lorebook: book([
        entry({ keys: ["ab{1,3}", "iron, crown", "north\nsouth", "harbour"], useRegex: true }),
      ]),
    });
    const changes = [
      raw("entry_1_keys", "3", "5"),
      raw("entry_1_keys", "iron", "silver"),
      raw("entry_1_keys", "south", "west"),
      raw("entry_1_keys", "harbour", "pier, quay"),
    ];
    expect(rework(sent, changes).next.lorebook?.entries[0]?.keys).toEqual([
      "ab{1,5}",
      "silver, crown",
      "north\nwest",
      "pier",
      "quay",
    ]);
    const placedChanges = placeChanges(sent, changes).map(placed);
    expect(
      applyChanges(
        sent,
        placedChanges.filter((_, index) => index === 0 || index === 3),
      ).next.lorebook?.entries[0]?.keys,
    ).toEqual(["ab{1,5}", "iron, crown", "north\nsouth", "pier", "quay"]);
  });

  it("supports unique cross-key passages and preserves boundaries outside the accepted range", () => {
    const sent = card({
      lorebook: book([entry({ keys: ["ab{1,3}", "harbour", "quay", "/", "last"] })]),
    });
    expect(
      rework(sent, [raw("entry_1_keys", "harbour, quay", "pier")]).next.lorebook?.entries[0]?.keys,
    ).toEqual(["ab{1,3}", "pier", "/", "last"]);
  });

  it("checks capacity using original key identities and the same result Apply writes", () => {
    const keys = [...Array.from({ length: 99 }, (_, index) => `r${index}{1,3}`), "harbour"];
    const sent = card({ lorebook: book([entry({ keys, useRegex: true })]) });
    expect(
      rework(sent, [raw("entry_1_keys", "harbour", "pier")]).next.lorebook?.entries[0]?.keys,
    ).toEqual([...keys.slice(0, -1), "pier"]);
    expect(reasons(placeChanges(sent, [raw("entry_1_keys", "harbour", "pier, quay")]))).toEqual([
      "too_long",
    ]);
    expect(reasons(placeChanges(sent, [raw("entry_1_keys", "harbour", "x".repeat(201))]))).toEqual([
      "too_long",
    ]);
    const whole = rework(sent, [raw("entry_1_keys", "", "ab{1,3}, harbour\nquay")]);
    expect(whole.next.lorebook?.entries[0]?.keys).toEqual(["ab{1", "3}", "harbour", "quay"]);
    const added = rework(sent, [
      raw("entry_1", "", ""),
      raw("entry_new_1", "", "New lore."),
      raw("entry_new_1_keys", "", "/ab{1,3}/, harbour\nquay"),
    ]);
    expect(added.next.lorebook?.entries[0]?.keys).toEqual(["/ab{1,3}/", "harbour", "quay"]);
  });

  it("keeps every untouched character of a touched field", () => {
    const description = "  Lead.\n\n<ada>\nIs 24.\n</ada>\n\nTail  ";
    const { next } = rework(card({ description }), [raw("description", "24", "34")]);
    expect(next.description).toBe(description.replace("24", "34"));
  });
});

/** The text between a key's tags in the message, after the parser's newline rule. */
function between(message: string, key: string): string | undefined {
  const open = `<${key}>`;
  const start = message.indexOf(open);
  const end = message.indexOf(`</${key}>`, start);
  if (start === -1 || end === -1) return undefined;
  return message
    .slice(start + open.length, end)
    .replace(/^\n/u, "")
    .replace(/\n$/u, "");
}

describe("rework prompt", () => {
  const persona = { name: "Ilse", description: "A sailor who calls {{char}} by her surname." };
  const full = card({
    systemPrompt: "Write as {{char}}.",
    postHistoryInstructions: "",
    lorebook: {
      ...book([
        entry({ comment: "The harbour" }),
        entry({ content: "", keys: [], constant: true }),
      ]),
      scanDepth: 3,
    },
  });

  it("carries the approved system prompt", () => {
    expect(REWORK_SYSTEM_PROMPT.startsWith("You edit character cards for a private")).toBe(true);
    expect(REWORK_SYSTEM_PROMPT.endsWith("on what you changed and why.")).toBe(true);
    expect(REWORK_SYSTEM_PROMPT).toContain("\n- find: a passage copied exactly");
    // Each layout's opening: the subjects placed in the scene, or the scene alone.
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "On a subject card it takes exactly this shape: a first line that starts with",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain("places the subject in the scene");
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "On a scenario card it takes the style <Tone> sets and exactly this shape:",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain("one short sentence of sensory detail");
    // No Markdown quote markers left over from the spec.
    expect(REWORK_SYSTEM_PROMPT).not.toMatch(/^> /m);
    expect(REWORK_SYSTEM_PROMPT).toContain("<change>…</change>");
  });

  it("moves where play begins out of a subject card's description and scenario into the opening", () => {
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "On a subject card, where and when play begins belongs to the first message alone",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "The first message alone sets where and when play begins",
    );
  });

  it("turns a set outfit anywhere the model reads into a style of dress, and never copies the portrait's", () => {
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "Clothing that belongs to a character, in the description, personality, systemPrompt, postHistoryInstructions, characterNote and lorebook entries, is a general style or habit of dress: a set outfit or a list of garments becomes the style it shows",
    );
    // The style keeps the words the lorebook finds entries by.
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "keeping word for word any phrase in it that matches a lorebook entry's keywords or secondary keywords.",
    );
    // An opening's scene keeps what someone wears in it.
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "What someone wears in the scene a first message, an alternate greeting or the scenario field sets stays as it is.",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "Never drop a fact beyond a scenario card's characters and trim, a side character's name and a set outfit's garments.",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "The clothing it shows is one outfit and never goes into the card as one.",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain("never one outfit or a list of garments");
  });

  it("unnames a subject card's minor side characters and invents no secrets or goals", () => {
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "whose name appears only in the description or personality field, nowhere else in the card or lorebook, keywords included, loses the name",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "One named anywhere else, or by the request, keeps the name.",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "established secrets, goals and conflicts stay unless the request removes them",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "Never give a character secrets, hidden agendas, goals, plot hooks or named people the card lacks",
    );
    expect(REWORK_SYSTEM_PROMPT).not.toContain("named people that shaped them");
  });

  it("turns a scenario card's fixed characters into groups and trims it to its frame", () => {
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "A scenario card holds none, whether converted or already in its layout",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "becomes the faction or kind of people they stand for, in general terms",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "each named character or individual role it has other than {{user}}'s own",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain("A scenario card gets no added depth");
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "A scenario card, converted or not, is also trimmed to its frame",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain("holds no fixed characters");
    expect(REWORK_SYSTEM_PROMPT).not.toContain("principal characters");
    // Name-keyed lorebook entries follow the role, so none is left unreachable.
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "a naming fix above, a character turned into a group or a scenario card's trim",
    );
    expect(REWORK_SYSTEM_PROMPT).toContain("its name and keywords turned to the group's words");
    // An entry Rework cannot retarget keeps its facts and settings, and the owner hears of it.
    expect(REWORK_SYSTEM_PROMPT).toContain(
      "stays as it is, and the summary says it still names them",
    );
    expect(REWORK_SYSTEM_PROMPT).not.toContain("moved into the description");
  });

  it("sends every key the parser accepts for a full card", () => {
    const message = reworkPrompt(full, "Make her older.", persona, false);
    for (const key of [
      "name",
      "description",
      "personality",
      "scenario",
      "firstMessage",
      "alternate_greeting_1",
      "alternate_greeting_2",
      "exampleDialogue",
      "systemPrompt",
      "postHistoryInstructions",
      "creatorNotes",
      "characterNote",
      "tags",
      "entry_1",
      "entry_1_name",
      "entry_1_keys",
      "entry_2",
      "entry_2_name",
      "entry_2_keys",
    ]) {
      expect(parseFieldKey(key), key).toBeDefined();
      expect(message, key).toContain(`<${key}>\n`);
      expect(message, key).toContain(`\n</${key}>`);
    }
    expect(between(message, "rework_request")).toBe("Make her older.");
    expect(message).toContain("<lorebook>\nBook settings, not editable: scan depth 3");
    expect(message).toContain("enabled: yes\nalways on: yes\n\n</entry_2>");
    expect(message).not.toContain("regex: yes");
  });

  it("says when an entry's keywords are patterns", () => {
    const sent = card({
      lorebook: book([entry({ comment: "Bells", keys: ["ab{1,3}"], useRegex: true })]),
    });
    expect(reworkPrompt(sent, "Go.", null, false)).toContain(
      "enabled: yes\nalways on: no\nregex: yes\nThe harbour smells of tar.\n</entry_1>",
    );
  });

  it("shows an entry's secondary keywords only while they apply", () => {
    const keyed = (selective?: boolean) =>
      card({
        lorebook: book([
          entry({
            comment: "Bells",
            keys: ["bells"],
            ...(selective === undefined ? {} : { selective }),
            secondaryKeys: ["the old town", "dusk"],
          }),
        ]),
      });
    expect(reworkPrompt(keyed(), "Go.", null, false)).toContain(
      "secondary keywords, not editable: the old town, dusk\nenabled: yes",
    );
    expect(reworkPrompt(keyed(false), "Go.", null, false)).not.toContain("secondary keywords");
  });

  it("round-trips every field's text through its tags", () => {
    const sent = card({
      description: "\n  <ada_reed>\nIs 24.\n</ada_reed>\n",
      personality: "",
      lorebook: book([entry({ comment: "The harbour", content: "Line one.\n\nLine two." })]),
    });
    const message = reworkPrompt(sent, "Fix it.", null, false);
    const fields: ReworkField[] = [
      ...TEXT_FIELDS,
      { kind: "tags" },
      { kind: "alternate", index: 0 },
      { kind: "alternate", index: 1 },
      { kind: "entry", index: 0, part: "name" },
      { kind: "entry", index: 0, part: "keys" },
    ];
    for (const field of fields) {
      expect(between(message, fieldKey(field)), fieldKey(field)).toBe(fieldText(sent, field));
    }
    expect(message).toContain(`\n${sent.lorebook?.entries[0]?.content}\n</entry_1>`);
  });

  it("leaves out the note on a card without one, and the persona without one", () => {
    const message = reworkPrompt(card({ characterNote: null, lorebook: null }), "Go.", null, false);
    expect(message).not.toContain("<characterNote>");
    expect(message).not.toContain("<persona>");
    expect(message).not.toContain("persona below");
    expect(message).toContain("<lorebook>\n</lorebook>");
    expect(message).not.toContain("The portrait is attached.");
  });

  it("adds the persona before the card, and says when the portrait is attached", () => {
    const message = reworkPrompt(full, "Go.", persona, true);
    expect(message.indexOf("<persona>")).toBeLessThan(message.indexOf("<card>"));
    expect(message).toContain("<name>Ilse</name>");
    expect(message).toContain("<about>\nA sailor who calls {{char}} by her surname.\n</about>");
    expect(message).toContain("The portrait is attached.\n\n<rework_request>");
    const blank = reworkPrompt(full, "Go.", { name: "Ilse", description: " " }, false);
    expect(blank).not.toContain("<about>");
  });

  it("keeps {{user}} verbatim", () => {
    const message = reworkPrompt(full, "Keep {{user}} at the gate.", persona, false);
    expect(message).toContain("Ada waits for {{user}} at the gate.");
    expect(message).toContain("Keep {{user}} at the gate.");
  });
});
