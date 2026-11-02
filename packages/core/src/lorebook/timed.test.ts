import { describe, expect, it } from "vitest";
import { CARD_LIMITS } from "../card/limits.ts";
import type { LorebookEntry } from "../card/schema.ts";
import { MAX_CHAT_TURNS } from "../chat-limits.ts";
import { MAX_FOLDED_TURNS } from "../memory/state.ts";
import { lorebookReportSchema } from "../prompt/inspect.ts";
import { activateLorebooks } from "./activate.ts";
import { combineLorebooks, type LorebookSource } from "./combine.ts";
import { LOREBOOK_RULES } from "./rules.ts";
import { type ActivationInput, activateLorebook, settled } from "./test-support.ts";
import { type LorebookState, lorebookStateAfterFold, lorebookStateSchema } from "./timed.ts";

const CHARACTER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const BOOK_A = "00000000-0000-4000-8000-0000000000a1";
const BOOK_B = "00000000-0000-4000-8000-0000000000b2";

const entry = (overrides: Partial<LorebookEntry> = {}): LorebookEntry => ({
  keys: ["beacon"],
  content: "Lore.",

  enabled: true,
  insertionOrder: 100,
  useRegex: false,
  ...overrides,
});

const timed = (effects: { sticky?: number; cooldown?: number; delay?: number }) => ({
  settings: effects,
});

/** A test digest of the entry's JSON (32-bit FNV-1a, hex); the server injects its own. */
function digest(value: LorebookEntry): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** A chat of `length` turns, oldest first, ending with the user's `last`. */
function chat(length: number, last: string): ActivationInput["turns"] {
  return Array.from({ length }, (_, index) =>
    index === length - 1
      ? { role: "user" as const, content: last }
      : { role: index % 2 === 0 ? ("assistant" as const) : ("user" as const), content: "Calm." },
  );
}

interface Send {
  length: number;
  text: string;
}

function activate(
  entries: LorebookEntry[],
  { length, text }: Send,
  state: LorebookState | null,
  overrides: Partial<ActivationInput> = {},
) {
  const activation = activateLorebook({
    book: { entries },
    turns: chat(length, text),
    names: { char: "Mara", user: "Aria" },
    macros: (value) => value,
    count: (value) => value.length,
    budget: 1_000,
    scanDepth: 2,
    blocks: { before: true, after: true, examples: true, authorsNote: true },
    timed: { state, characterId: CHARACTER, digest },
    random: () => 0,
    ...overrides,
  });
  expect(lorebookReportSchema.parse(activation.report)).toEqual(activation.report);
  if (activation.state !== null) {
    expect(lorebookStateSchema.parse(activation.state)).toEqual(activation.state);
  }
  return activation;
}

/** Sends in order, each with the state the one before returned; which entries went in each time. */
function play(entries: LorebookEntry[], sends: Send[]): number[][] {
  let state: LorebookState | null = null;
  return sends.map((send) => {
    const activation = activate(entries, send, state);
    state = activation.state;
    return activation.before.map((sent) => sent.index);
  });
}

const status = (activation: ReturnType<typeof activate>, index: number) =>
  activation.report.entries.find((line) => line.index === index);

const keyed = (length: number): Send => ({ length, text: "Is the beacon lit?" });
const quiet = (length: number): Send => ({ length, text: "Any news?" });

describe("timed effects", () => {
  it("holds a sticky entry without its keys while the length is below start plus sticky", () => {
    const entries = [entry(timed({ sticky: 4 })), entry()];
    expect(play(entries, [keyed(2), quiet(4), quiet(6), quiet(8)])).toEqual([[1, 0], [0], [], []]);
  });

  it("says a sticky entry went in for its effect, with the messages left", () => {
    const first = activate([entry(timed({ sticky: 6 }))], keyed(2), null);
    const second = activate([entry(timed({ sticky: 6 }))], quiet(4), first.state);
    expect(status(second, 0)).toMatchObject({
      status: "sent",
      pass: 0,
      reason: { kind: "sticky", left: 4 },
    });
  });

  it("puts a sticky entry on cooldown when its sticky span ends", () => {
    const entries = [entry(timed({ sticky: 2, cooldown: 2 }))];
    const sends = [keyed(2), keyed(4), keyed(6), keyed(8), keyed(10)];
    expect(play(entries, sends)).toEqual([[0], [], [0], [], [0]]);
  });

  it("reports an entry on cooldown with the messages left", () => {
    const entries = [entry(timed({ cooldown: 4 }))];
    const first = activate(entries, keyed(2), null);
    const second = activate(entries, keyed(4), first.state);
    expect(status(second, 0)).toMatchObject({ status: "cooldown", left: 2 });
    expect(second.before).toEqual([]);
  });

  it("never blocks a cooldown as long as the gap between sends", () => {
    const entries = [entry(timed({ cooldown: 2 }))];
    expect(play(entries, [keyed(2), keyed(4), keyed(6), keyed(8)])).toEqual([[0], [0], [0], [0]]);
  });

  it("keeps a delayed entry out, constant or not, until the chat is long enough", () => {
    const entries = [
      entry(timed({ delay: 2 })),
      entry(timed({ delay: 3 })),
      entry({ ...timed({ delay: 3 }), keys: [], constant: true }),
    ];
    const short = activate(entries, keyed(2), null);
    expect(short.before.map((sent) => sent.index)).toEqual([0]);
    expect(status(short, 1)).toMatchObject({ status: "delayed", until: 3 });
    expect(status(short, 2)).toMatchObject({ status: "delayed", until: 3 });
    expect(activate(entries, keyed(4), null).before.map((sent) => sent.index)).toEqual([2, 1, 0]);
  });

  it("delays without any timed state", () => {
    const activation = activate([entry(timed({ delay: 3 }))], keyed(2), null, { timed: null });
    expect(status(activation, 0)?.status).toBe("delayed");
    expect(activation.state).toBeNull();
  });

  it("does not refresh a sticky entry whose keys are seen again", () => {
    const entries = [entry(timed({ sticky: 4 }))];
    expect(play(entries, [keyed(2), keyed(4), keyed(6)])).toEqual([[0], [0], [0]]);
    let state: LorebookState | null = null;
    for (const send of [keyed(2), keyed(4)]) state = activate(entries, send, state).state;
    expect(state?.effects).toEqual([
      { index: 0, digest: digest(entries[0] as LorebookEntry), start: 2 },
    ]);
  });

  it("drops an effect the chat did not advance past: a swipe, regenerate or resend", () => {
    const entries = [
      entry(timed({ sticky: 6 })),
      entry({ ...timed({ sticky: 6 }), keys: ["ferry"] }),
    ];
    const first = activate(entries, keyed(2), null);
    const second = activate(entries, { length: 4, text: "The ferry?" }, first.state);
    // The swipe answers the same length: B's effect from this exchange is read by its keys again,
    // A's from the exchange before holds.
    const swipe = activate(entries, { length: 4, text: "Calm." }, second.state);
    expect(status(swipe, 0)?.reason).toEqual({ kind: "sticky", left: 4 });
    expect(status(swipe, 1)?.status).toBe("notMatched");
    expect(swipe.state?.effects.map((effect) => effect.index)).toEqual([0]);
    const resent = activate(entries, keyed(2), second.state);
    expect(status(resent, 0)?.reason).toMatchObject({ kind: "key" });
  });

  it("keeps a sticky effect through a Continue that outlasts it, for a regenerate going back", () => {
    const entries = [entry(timed({ sticky: 3 }))];
    const first = activate(entries, keyed(2), null);
    const send = activate(entries, quiet(4), first.state);
    expect(status(send, 0)?.reason).toEqual({ kind: "sticky", left: 1 });
    const continued = activate(entries, quiet(5), send.state);
    expect(status(continued, 0)?.status).toBe("notMatched");
    const regenerate = activate(entries, quiet(4), continued.state);
    expect(status(regenerate, 0)?.reason).toEqual({ kind: "sticky", left: 1 });
  });

  it("delays an entry whatever the state says, and discards a record its delay rules out", () => {
    const entries = [
      entry(timed({ sticky: 4, delay: 100 })),
      entry(timed({ sticky: 10, delay: 3 })),
    ];
    const impossible: LorebookState = {
      characterId: CHARACTER,
      effects: [
        { index: 0, digest: digest(entries[0] as LorebookEntry), start: 1 },
        { index: 1, digest: digest(entries[1] as LorebookEntry), start: 1 },
      ],
    };
    const early = activate(entries, quiet(2), impossible);
    expect(status(early, 0)).toMatchObject({ status: "delayed", until: 100 });
    const later = activate(entries, quiet(4), impossible);
    expect(status(later, 1)?.status).toBe("notMatched");
    expect(later.state?.effects).toEqual([]);
  });

  it("ends the effect of an edited entry and keeps the others", () => {
    const entries = [
      entry(timed({ sticky: 6 })),
      entry({ ...timed({ sticky: 6 }), content: "B." }),
    ];
    const first = activate(entries, keyed(2), null);
    const edited = [
      entries[0] as LorebookEntry,
      { ...(entries[1] as LorebookEntry), content: "C." },
    ];
    const next = activate(edited, quiet(4), first.state);
    expect(status(next, 0)?.reason?.kind).toBe("sticky");
    expect(status(next, 1)?.status).toBe("notMatched");
  });

  it("drops the effect of a removed entry", () => {
    const entries = [
      entry(timed({ sticky: 6 })),
      entry({ ...timed({ sticky: 6 }), content: "B." }),
    ];
    const first = activate(entries, keyed(2), null);
    const next = activate([entries[0] as LorebookEntry], quiet(4), first.state);
    expect(next.state?.effects.map((effect) => effect.index)).toEqual([0]);
  });

  it("keeps effects with their entries when an earlier entry is removed or duplicated", () => {
    const entries = [
      entry({ keys: ["tide"], content: "A." }),
      entry({ ...timed({ sticky: 6 }), content: "B." }),
    ];
    const first = activate(entries, keyed(2), null);
    expect(first.state?.effects.map((effect) => effect.index)).toEqual([1]);
    const removed = activate([entries[1] as LorebookEntry], quiet(4), first.state);
    expect(status(removed, 0)?.reason).toEqual({ kind: "sticky", left: 4 });
    expect(removed.state?.effects.map((effect) => effect.index)).toEqual([0]);
    const duplicated = activate(
      [entries[0] as LorebookEntry, entries[0] as LorebookEntry, entries[1] as LorebookEntry],
      quiet(4),
      first.state,
    );
    expect(status(duplicated, 2)?.reason).toEqual({ kind: "sticky", left: 4 });
  });

  it("discards another character's state", () => {
    const entries = [entry(timed({ sticky: 6 }))];
    const first = activate(entries, keyed(2), null);
    const foreign = { ...(first.state as LorebookState), characterId: OTHER };
    const next = activate(entries, quiet(4), foreign);
    expect(status(next, 0)?.status).toBe("notMatched");
    expect(next.state).toEqual({ characterId: CHARACTER, effects: [] });
  });

  it("fits a sticky entry before every other entry", () => {
    const entries = [
      entry({ ...timed({ sticky: 4 }), content: "x".repeat(600), insertionOrder: 10 }),
      entry({ keys: ["gale"], content: "y".repeat(600), insertionOrder: 90 }),
    ];
    const first = activate(entries, keyed(2), null);
    const next = activate(entries, { length: 4, text: "The gale." }, first.state);
    expect(status(next, 0)?.status).toBe("sent");
    expect(status(next, 1)?.status).toBe("doesNotFit");
  });
});

/** Activates a character's books together, as `activate` does one book. */
function activateBooks(
  sources: LorebookSource[],
  { length, text }: Send,
  state: LorebookState | null,
) {
  const { books, budget } = combineLorebooks(sources, 100_000);
  const activation = settled(
    activateLorebooks({
      books,
      turns: chat(length, text),
      names: { char: "Mara", user: "Aria" },
      macros: (value) => value,
      count: (value) => value.length,
      budget,
      blocks: { before: true, after: true, examples: true, authorsNote: true },
      timed: { state, characterId: CHARACTER, digest },
      random: () => 0,
    }),
  );
  expect(lorebookReportSchema.parse(activation.report)).toEqual(activation.report);
  expect(lorebookStateSchema.parse(activation.state)).toEqual(activation.state);
  return activation;
}

const inBook = (id: string | null, entries: LorebookEntry[]): LorebookSource => ({
  id,
  name: id ?? "Card",
  book: { entries },
});

describe("timed effects across books", () => {
  // The same entry in three books: only the book it was sent from may hold it.
  const sticky = entry(timed({ sticky: 8 }));
  const sources = () => [
    inBook(null, [sticky]),
    inBook(BOOK_A, [sticky]),
    inBook(BOOK_B, [sticky]),
  ];

  it("names the library book an effect belongs to, and none for the card's own", () => {
    const first = activateBooks(sources(), keyed(2), null);
    expect(first.state?.effects.map(({ book, index }) => [book, index])).toEqual([
      [undefined, 0],
      [BOOK_A, 0],
      [BOOK_B, 0],
    ]);
    expect(first.state?.effects[0]).not.toHaveProperty("book");
  });

  it("keeps an effect with its own book when another book is removed", () => {
    const first = activateBooks(sources(), keyed(2), null);
    const without = activateBooks(
      [inBook(null, [sticky]), inBook(BOOK_B, [sticky])],
      quiet(4),
      first.state,
    );
    expect(without.report.entries.map((line) => [line.index, line.status])).toEqual([
      [0, "sent"],
      [1, "sent"],
    ]);
    expect(without.state?.effects.map(({ book }) => book)).toEqual([undefined, BOOK_B]);
  });

  it("does not let a book that was not linked before hold another's effect", () => {
    // Only the card's book sent the entry; the linked book with the same entry must not inherit it.
    const first = activateBooks([inBook(null, [sticky])], keyed(2), null);
    const next = activateBooks(
      [inBook(null, [sticky]), inBook(BOOK_A, [sticky])],
      quiet(4),
      first.state,
    );
    expect(next.report.entries.map((line) => [line.index, line.status])).toEqual([
      [0, "sent"],
      [1, "notMatched"],
    ]);
  });

  it("keeps effects with their books when the books are reordered", () => {
    const first = activateBooks(
      [inBook(null, []), inBook(BOOK_A, [sticky, entry({ keys: ["tide"], content: "B." })])],
      keyed(2),
      null,
    );
    const reordered = activateBooks(
      [
        inBook(null, []),
        inBook(BOOK_B, [sticky]),
        inBook(BOOK_A, [sticky, entry({ keys: ["tide"], content: "B." })]),
      ],
      quiet(4),
      first.state,
    );
    expect(reordered.report.entries.map((line) => [line.index, line.status])).toEqual([
      [0, "notMatched"],
      [1, "sent"],
      [2, "notMatched"],
    ]);
    expect(reordered.state?.effects).toEqual([
      { book: BOOK_A, index: 0, digest: digest(sticky), start: 2 },
    ]);
  });

  it("moves an effect by digest only inside its own book", () => {
    const other = entry({ keys: ["tide"], content: "B." });
    const first = activateBooks(
      [inBook(BOOK_A, [other, sticky]), inBook(BOOK_B, [sticky])],
      keyed(2),
      null,
    );
    // An entry added before it in book A shifts it; book B's identical entry stays book B's.
    const shifted = activateBooks(
      [inBook(BOOK_A, [other, other, sticky]), inBook(BOOK_B, [sticky])],
      quiet(4),
      first.state,
    );
    expect(shifted.report.entries.map((line) => [line.index, line.status])).toEqual([
      [0, "notMatched"],
      [1, "notMatched"],
      [2, "sent"],
      [3, "sent"],
    ]);
    expect(shifted.state?.effects.map(({ book, index }) => [book, index])).toEqual([
      [BOOK_A, 2],
      [BOOK_B, 0],
    ]);
  });

  it("reads state without a book as the card's own", () => {
    const written: LorebookState = {
      characterId: CHARACTER,
      effects: [{ index: 0, digest: digest(sticky), start: 2 }],
    };
    const next = activateBooks(
      [inBook(null, [sticky]), inBook(BOOK_A, [sticky])],
      quiet(4),
      written,
    );
    expect(next.report.entries.map((line) => [line.index, line.status])).toEqual([
      [0, "sent"],
      [1, "notMatched"],
    ]);
    expect(next.report.entries[0]?.reason).toEqual({ kind: "sticky", left: 6 });
  });

  it("leaves a library book's effect unread when the book is no longer linked", () => {
    const first = activateBooks([inBook(null, []), inBook(BOOK_A, [sticky])], keyed(2), null);
    const next = activateBooks([inBook(null, [sticky])], quiet(4), first.state);
    expect(next.report.entries[0]?.status).toBe("notMatched");
    expect(next.state?.effects).toEqual([]);
  });

  it("relocates many moved effects in one pass over the entries", () => {
    const entries = Array.from({ length: 2_000 }, (_, index) =>
      entry({ ...timed({ sticky: 8 }), content: `Entry ${index}.` }),
    );
    const first = activateBooks([inBook(BOOK_A, entries)], keyed(2), null);
    expect(first.state?.effects).toHaveLength(2_000);
    const prefixed = [entry({ keys: ["tide"], content: "Front." }), ...entries];
    const started = performance.now();
    const next = activateBooks([inBook(BOOK_A, prefixed)], quiet(4), first.state);
    expect(next.report.counts.sent).toBe(2_000);
    expect(next.state?.effects.map(({ index }) => index)).toEqual(
      Array.from({ length: 2_000 }, (_, index) => index + 1),
    );
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("the next state", () => {
  it("records every sent entry with a sticky or cooldown, at the request's length", () => {
    const entries = [
      entry(timed({ sticky: 2 })),
      entry(timed({ cooldown: 2 })),
      entry(timed({ delay: 1 })),
      entry(),
    ];
    const { state } = activate(entries, keyed(2), null);
    expect(state).toEqual({
      characterId: CHARACTER,
      effects: [
        { index: 0, digest: digest(entries[0] as LorebookEntry), start: 2 },
        { index: 1, digest: digest(entries[1] as LorebookEntry), start: 2 },
      ],
    });
  });

  it("starts no effect for an entry the budget left out", () => {
    const entries = [
      entry({ content: "x".repeat(600), insertionOrder: 90 }),
      entry({ ...timed({ sticky: 4 }), content: "y".repeat(600), insertionOrder: 10 }),
    ];
    const activation = activate(entries, keyed(2), null);
    expect(status(activation, 1)?.status).toBe("doesNotFit");
    expect(activation.state?.effects).toEqual([]);
  });

  it("keeps an expired record, and replaces it when the entry is sent again", () => {
    const entries = [entry(timed({ sticky: 2 }))];
    const first = activate(entries, keyed(2), null);
    const expired = activate(entries, quiet(4), first.state);
    expect(status(expired, 0)?.status).toBe("notMatched");
    expect(expired.state?.effects).toEqual(first.state?.effects);
    const again = activate(entries, keyed(6), expired.state);
    expect(again.state?.effects).toEqual([
      { index: 0, digest: digest(entries[0] as LorebookEntry), start: 6 },
    ]);
  });
});

describe("the state schema", () => {
  const valid: LorebookState = {
    characterId: CHARACTER,
    effects: [{ index: 0, digest: "a1b2", start: 2 }],
  };

  it("accepts a bounded state", () => {
    expect(lorebookStateSchema.parse(valid)).toEqual(valid);
  });

  it("accepts the same index in the card's book and in library books", () => {
    const state = {
      ...valid,
      effects: [
        { index: 0, digest: "a1", start: 2 },
        { book: BOOK_A, index: 0, digest: "a1", start: 2 },
        { book: BOOK_B, index: 0, digest: "a1", start: 2 },
      ],
    };
    expect(lorebookStateSchema.parse(state)).toEqual(state);
  });

  it("accepts as many effects as the combined entry bound", () => {
    const effects = Array.from({ length: LOREBOOK_RULES.combinedEntries }, (_, index) => ({
      ...(index < CARD_LIMITS.lorebookEntries ? {} : { book: BOOK_A }),
      index: index % CARD_LIMITS.lorebookEntries,
      digest: "a1",
      start: 2,
    }));
    expect(lorebookStateSchema.safeParse({ ...valid, effects }).success).toBe(true);
  });

  it.each([
    ["a character id that is not a uuid", { ...valid, characterId: "mara" }],
    ["a negative index", { ...valid, effects: [{ index: -1, digest: "a1", start: 2 }] }],
    ["a fractional start", { ...valid, effects: [{ index: 0, digest: "a1", start: 2.5 }] }],
    [
      "a start before the folded-turn bound",
      { ...valid, effects: [{ index: 0, digest: "a1", start: -MAX_FOLDED_TURNS - 1 }] },
    ],
    [
      "a start past the longest chat",
      { ...valid, effects: [{ index: 0, digest: "a1", start: MAX_CHAT_TURNS + 1 }] },
    ],
    ["a digest that is not hex", { ...valid, effects: [{ index: 0, digest: "xyz", start: 2 }] }],
    [
      "a digest past 32 characters",
      { ...valid, effects: [{ index: 0, digest: "a".repeat(33), start: 2 }] },
    ],
    [
      "two effects for one entry",
      {
        ...valid,
        effects: [
          { index: 0, digest: "a1", start: 2 },
          { index: 0, digest: "b2", start: 4 },
        ],
      },
    ],
    [
      "more effects than the combined entry bound",
      {
        ...valid,
        effects: Array.from({ length: LOREBOOK_RULES.combinedEntries + 1 }, (_, index) => ({
          book: index < CARD_LIMITS.lorebookEntries ? undefined : BOOK_A,
          index: index % CARD_LIMITS.lorebookEntries,
          digest: "a1",
          start: 2,
        })),
      },
    ],
    [
      "an index past a book's entries",
      {
        ...valid,
        effects: [{ index: CARD_LIMITS.lorebookEntries, digest: "a1", start: 2 }],
      },
    ],
    [
      "a book that is not a uuid",
      {
        ...valid,
        effects: [{ book: "notes", index: 0, digest: "a1", start: 2 }],
      },
    ],
    [
      "two effects for one entry of a book",
      {
        ...valid,
        effects: [
          { book: BOOK_A, index: 0, digest: "a1", start: 2 },
          { book: BOOK_A, index: 0, digest: "b2", start: 4 },
        ],
      },
    ],
    [
      "an unknown field",
      { ...valid, effects: [{ index: 0, digest: "a1", start: 2, kind: "sticky" }] },
    ],
  ])("rejects %s", (_, state) => {
    expect(lorebookStateSchema.safeParse(state).success).toBe(false);
  });
});

describe("timed state after a fold", () => {
  const carried: LorebookState = {
    characterId: CHARACTER,
    effects: [
      { index: 0, digest: "a1", start: 2 },
      { index: 1, digest: "b2", start: 6 },
    ],
  };

  it("moves every start down, preserving an effect started inside the folded span", () => {
    expect(lorebookStateAfterFold(carried, 4)).toEqual({
      characterId: CHARACTER,
      effects: [
        { index: 0, digest: "a1", start: -2 },
        { index: 1, digest: "b2", start: 2 },
      ],
    });
  });

  it("preserves an early sticky effect and its cooldown through folds and unfolding", () => {
    const entries = [entry(timed({ sticky: 6, cooldown: 4, delay: 2 }))];
    const sent = activate(entries, keyed(2), null);
    const folded = lorebookStateAfterFold(sent.state, 4);
    expect(lorebookStateSchema.safeParse(folded).success).toBe(true);
    const after = activate(entries, quiet(2), folded, { folded: 4 });
    expect(status(after, 0)).toMatchObject({ status: "sent", reason: { kind: "sticky", left: 2 } });
    expect(status(activate(entries, keyed(4), folded, { folded: 4 }), 0)).toMatchObject({
      status: "cooldown",
      left: 4,
    });
    expect(status(activate(entries, keyed(8), folded, { folded: 4 }), 0)?.status).toBe("sent");
    const twice = lorebookStateAfterFold(folded, 2);
    expect(twice).toEqual(lorebookStateAfterFold(sent.state, 6));
    expect(lorebookStateAfterFold(twice, -6)).toEqual(sent.state);
    // A regenerate of the exchange that originally started it reads the keys again.
    expect(status(activate(entries, quiet(2), sent.state), 0)?.status).not.toBe("sent");
    expect(
      lorebookStateSchema.safeParse({
        characterId: CHARACTER,
        effects: [{ index: 0, digest: "a1", start: -MAX_FOLDED_TURNS }],
      }).success,
    ).toBe(true);
  });

  it("moves every start up again when the turns unfold, and changes nothing for no fold", () => {
    expect(lorebookStateAfterFold(carried, -3)).toEqual({
      characterId: CHARACTER,
      effects: [
        { index: 0, digest: "a1", start: 5 },
        { index: 1, digest: "b2", start: 9 },
      ],
    });
    expect(lorebookStateAfterFold(carried, 0)).toBe(carried);
    expect(lorebookStateAfterFold(null, 4)).toBeNull();
  });

  it("measures delay over the whole chat, the folded turns included", () => {
    const entries = [entry(timed({ delay: 6 }))];
    // Four live turns are short of the delay alone; with four folded the chat has eight.
    expect(status(activate(entries, keyed(4), null), 0)).toMatchObject({
      status: "delayed",
      until: 6,
    });
    expect(activate(entries, keyed(4), null, { folded: 4 }).before).toHaveLength(1);
    expect(status(activate(entries, keyed(2), null, { folded: 3 }), 0)?.status).toBe("delayed");
  });

  it("keeps a delayed entry's sticky effect through a fold", () => {
    const entries = [entry(timed({ sticky: 6, delay: 6 }))];
    const sent = activate(entries, keyed(8), null);
    expect(sent.before).toHaveLength(1);
    // Six turns fold: the effect's start moves from 8 to 2, the next request has four live turns.
    const after = activate(entries, quiet(4), lorebookStateAfterFold(sent.state, 6), {
      folded: 6,
    });
    expect(status(after, 0)).toMatchObject({ status: "sent", reason: { kind: "sticky", left: 4 } });
    expect(after.state?.effects).toEqual([
      { index: 0, digest: digest(entries[0] as LorebookEntry), start: 2 },
    ]);
  });
});
