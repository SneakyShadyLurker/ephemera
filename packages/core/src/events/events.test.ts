import { describe, expect, it } from "vitest";
import type { ChatRole } from "../chat.ts";
import { MAX_FOLDED_TURNS } from "../memory/state.ts";
import {
  type EventScope,
  eventApplies,
  eventCreateRequestSchema,
  eventFieldsSchema,
  eventMessage,
  eventPatchRequestSchema,
  storedEventSchema,
} from "./event.ts";
import {
  type EventsState,
  eventStanding,
  eventsAfterDeletion,
  eventsAfterFold,
  eventsAfterInsertion,
  eventsAfterTruncation,
  eventsStateSchema,
  type FiredEvent,
  nextEventsState,
  type RolledEvent,
  rollEvents,
} from "./state.ts";

const CHARACTER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const C = "00000000-0000-4000-8000-0000000000c3";

const ALL: EventScope = { kind: "all" };
const event = (id: string, overrides: Partial<RolledEvent> = {}): RolledEvent => ({
  id,
  chance: 100,
  cooldown: 0,
  enabled: true,
  scope: ALL,
  ...overrides,
});
const character = { id: CHARACTER, tags: ["noir", "harbour"] };

/** A chat of `replies` exchanges after the greeting, ending with the user's turn. */
const chat = (replies: number): ChatRole[] => [
  "assistant",
  ...Array.from({ length: replies }, (): ChatRole[] => ["user", "assistant"]).flat(),
  "user",
];

/** A random source that returns these values in order, then fails. */
const draws = (...values: number[]) => {
  const left = [...values];
  return () => {
    const next = left.shift();
    if (next === undefined) throw new Error("drew more than expected");
    return next;
  };
};

const state = (...fired: FiredEvent[]): EventsState => ({
  characterId: CHARACTER,
  fired,
});

describe("event definitions", () => {
  it("reads widened converted events and disabled empty events, retaining public and structural validation", () => {
    const row = {
      id: A,
      text: `{{char}}${"x".repeat(495)}`,
      chance: 12.5,
      cooldown: 3,
      enabled: true,
      scope: ALL,
      revision: 1,
      createdAt: 11,
      updatedAt: 12,
    };
    expect(storedEventSchema.parse(row)).toEqual(row);
    expect(storedEventSchema.parse({ ...row, text: "", enabled: false }).text).toBe("");
    for (const text of ["", "  "]) {
      expect(storedEventSchema.safeParse({ ...row, text }).success).toBe(false);
      expect(
        eventCreateRequestSchema.safeParse({
          id: A,
          text,
          chance: row.chance,
          cooldown: row.cooldown,
          enabled: false,
          scope: ALL,
        }).success,
      ).toBe(false);
      expect(eventPatchRequestSchema.safeParse({ text, enabled: false, revision: 1 }).success).toBe(
        false,
      );
    }
    expect(eventFieldsSchema.safeParse(row).success).toBe(false);
    expect(
      eventCreateRequestSchema.safeParse({
        id: A,
        text: row.text,
        chance: row.chance,
        cooldown: row.cooldown,
        enabled: true,
        scope: ALL,
      }).success,
    ).toBe(false);
    expect(eventPatchRequestSchema.safeParse({ text: row.text, revision: 1 }).success).toBe(false);
    for (const invalid of [
      { text: 1 },
      { text: "two\nlines", enabled: false },
      { chance: 101 },
      { cooldown: 1001 },
      { id: "invalid" },
      { revision: -1 },
      { unknown: true },
    ])
      expect(storedEventSchema.safeParse({ ...row, ...invalid }).success).toBe(false);
  });
  it("wraps the trimmed text as one direction, closing an open sentence with a full stop", () => {
    const close = " Work it into the scene naturally and do not mention this note.]";
    expect(eventMessage("  A storm breaks ")).toBe(
      `[Direction for your next reply: A storm breaks.${close}`,
    );
    for (const text of ["Run.", "Run!", "Run?", "Run\u2026"]) {
      expect(eventMessage(text)).toBe(`[Direction for your next reply: ${text}${close}`);
    }
  });

  it("takes one trimmed line, a chance with one decimal and a bounded cooldown", () => {
    const fields = {
      text: "  Rain starts.  ",
      chance: 12.5,
      cooldown: 3,
      enabled: true,
      scope: ALL,
    };
    expect(eventFieldsSchema.parse(fields).text).toBe("Rain starts.");
    for (const bad of [
      { text: "Two\nlines" },
      { text: "   " },
      { text: "x".repeat(501) },
      { chance: 12.25 },
      { chance: 101 },
      { cooldown: 1.5 },
      { cooldown: 1001 },
      { scope: { kind: "selected", characters: [CHARACTER, CHARACTER], tags: [] } },
    ]) {
      expect(eventFieldsSchema.safeParse({ ...fields, ...bad }).success).toBe(false);
    }
    const repeated = { kind: "selected", characters: [], tags: ["Noir", "noir", "noir"] };
    expect(eventFieldsSchema.parse({ ...fields, scope: repeated }).scope).toEqual({
      ...repeated,
      tags: ["Noir"],
    });
  });

  it("applies to every card, or to the chosen characters and any chosen tag", () => {
    expect(eventApplies(ALL, character)).toBe(true);
    const selected = (characters: string[], tags: string[]): EventScope => ({
      kind: "selected",
      characters,
      tags,
    });
    expect(eventApplies(selected([CHARACTER], []), character)).toBe(true);
    expect(eventApplies(selected([OTHER], ["noir"]), character)).toBe(true);
    expect(eventApplies(selected([OTHER], ["Noir"]), character)).toBe(true);
    expect(eventApplies(selected([OTHER], ["attic"]), character)).toBe(false);
    expect(eventApplies(selected([], []), character)).toBe(false);
  });
});

describe("event standing", () => {
  it("holds for the next `cooldown` replies after the one it fired on", () => {
    // Fired at length 2: the reply at index 2 is the one it fired on.
    expect(eventStanding(2, 2, chat(1))).toEqual({ kind: "cooldown", left: 2 });
    expect(eventStanding(2, 2, chat(2))).toEqual({ kind: "cooldown", left: 1 });
    expect(eventStanding(2, 2, chat(3))).toEqual({ kind: "free" });
    expect(eventStanding(2, 0, chat(1))).toEqual({ kind: "free" });
  });

  it("counts folded replies and live replies after a firing reply inside memory", () => {
    const carried = state({ id: A, start: -5, foldedReplies: 2 });
    const roles: ChatRole[] = ["user", "assistant", "user", "assistant", "user"];
    expect(eventStanding(-5, 5, roles, 2)).toEqual({ kind: "cooldown", left: 1 });
    const roll = rollEvents({
      events: [event(A, { cooldown: 5 })],
      character,
      state: carried,
      roles,
      random: draws(),
    });
    expect(roll).toEqual({ fired: null, kept: carried.fired });
    expect(eventStanding(-5, 5, [...roles, "assistant", "user"], 2)).toEqual({ kind: "free" });
  });

  it("is over when the chat has not advanced past it (a regenerate, a deletion)", () => {
    expect(eventStanding(2, 5, chat(0))).toBeNull();
    expect(eventStanding(4, 5, chat(1))).toBeNull();
  });

  it("is over when the reply it fired on failed or came back empty, so was never sent on", () => {
    // Fired at length 2; that reply failed, and the user sent another message instead.
    expect(eventStanding(2, 5, [...chat(0), "user"])).toBeNull();
    expect(
      rollEvents({
        events: [event(A, { cooldown: 5 })],
        character,
        state: state({ id: A, start: 2 }),
        roles: [...chat(0), "user"],
        random: draws(0),
      }),
    ).toEqual({ fired: event(A, { cooldown: 5 }), kept: [] });
  });
});

describe("event roll", () => {
  it("injects a hit and records it at the request's length", () => {
    const roll = rollEvents({
      events: [event(A)],
      character,
      state: null,
      roles: chat(0),
      random: draws(0.5),
    });
    expect(roll.fired?.id).toBe(A);
    expect(nextEventsState(CHARACTER, roll.kept, A, 2)).toEqual(state({ id: A, start: 2 }));
  });

  it("rolls each chance once and leaves out disabled, out-of-scope and 0% events", () => {
    const events = [
      event(A, { chance: 30 }),
      event(B, { enabled: false }),
      event(C, { scope: { kind: "selected", characters: [OTHER], tags: [] } }),
      event(OTHER, { chance: 0 }),
    ];
    // A misses at 0.3 (30% hits below it); B and C draw nothing; the 0% event never hits.
    const miss = rollEvents({
      events,
      character,
      state: null,
      roles: chat(0),
      random: draws(0.3, 0),
    });
    expect(miss.fired).toBeNull();
    const hit = rollEvents({
      events,
      character,
      state: null,
      roles: chat(0),
      random: draws(0.29, 0),
    });
    expect(hit.fired?.id).toBe(A);
  });

  it("picks exactly one of several hits, uniformly, and records only that one", () => {
    const events = [event(A), event(B), event(C)];
    const pick = (value: number) =>
      rollEvents({ events, character, state: null, roles: chat(0), random: draws(0, 0, 0, value) })
        .fired?.id;
    expect([pick(0), pick(0.34), pick(0.99)]).toEqual([A, B, C]);
    const roll = rollEvents({
      events,
      character,
      state: null,
      roles: chat(0),
      random: draws(0, 0, 0, 0.5),
    });
    expect(nextEventsState(CHARACTER, roll.kept, roll.fired?.id ?? null, 2).fired).toEqual([
      { id: B, start: 2 },
    ]);
  });

  it("keeps an event off during its cooldown and lets it roll on the reply after", () => {
    const events = [event(A, { cooldown: 1 })];
    const carried = state({ id: A, start: 2 });
    const during = rollEvents({
      events,
      character,
      state: carried,
      roles: chat(1),
      random: draws(),
    });
    expect(during.fired).toBeNull();
    expect(during.kept).toEqual(carried.fired);
    const after = rollEvents({
      events,
      character,
      state: carried,
      roles: chat(2),
      random: draws(0),
    });
    expect(after.fired?.id).toBe(A);
    expect(nextEventsState(CHARACTER, after.kept, A, 6)).toEqual(state({ id: A, start: 6 }));
  });

  it("rolls again when the reply it fired on is regenerated", () => {
    const roll = rollEvents({
      events: [event(A, { cooldown: 5 })],
      character,
      state: state({ id: A, start: 2 }),
      roles: chat(0),
      random: draws(0),
    });
    expect(roll.kept).toEqual([]);
    expect(roll.fired?.id).toBe(A);
  });

  it("drops records of deleted or out-of-scope events and another character's state", () => {
    const events = [
      event(A, { cooldown: 9, scope: { kind: "selected", characters: [OTHER], tags: [] } }),
    ];
    const carried = state({ id: A, start: 2 }, { id: B, start: 2 });
    const roll = rollEvents({ events, character, state: carried, roles: chat(1), random: draws() });
    expect(roll.kept).toEqual([]);
    const other = rollEvents({
      events: [event(A, { cooldown: 9 })],
      character,
      state: { characterId: OTHER, fired: [{ id: A, start: 2 }] },
      roles: chat(1),
      random: draws(0),
    });
    expect(other.fired?.id).toBe(A);
    expect(other.kept).toEqual([]);
  });

  it("refuses a state with two records for one event", () => {
    expect(
      eventsStateSchema.safeParse(state({ id: A, start: 2 }, { id: A, start: 4 })).success,
    ).toBe(false);
  });

  it("bounds signed records and accepts folded reply counts only for folded anchors", () => {
    const valid = state({ id: A, start: -MAX_FOLDED_TURNS, foldedReplies: MAX_FOLDED_TURNS });
    expect(eventsStateSchema.parse(valid)).toEqual(valid);
    expect(eventsStateSchema.parse(state({ id: A, start: -1 }))).toEqual(
      state({ id: A, start: -1 }),
    );
    for (const record of [
      { id: A, start: -MAX_FOLDED_TURNS - 1 },
      { id: A, start: -1, foldedReplies: -1 },
      { id: A, start: -1, foldedReplies: MAX_FOLDED_TURNS + 1 },
      { id: A, start: -1, foldedReplies: undefined },
      { id: A, start: 0, foldedReplies: 0 },
    ]) {
      expect(eventsStateSchema.safeParse({ characterId: CHARACTER, fired: [record] }).success).toBe(
        false,
      );
    }
  });
});

describe("event state after a deletion", () => {
  it("drops the record of the deleted reply and moves the later ones down", () => {
    const carried = state({ id: A, start: 2 }, { id: B, start: 4 }, { id: C, start: 6 });
    expect(eventsAfterDeletion(carried, 4)).toEqual(
      state({ id: A, start: 2 }, { id: C, start: 5 }),
    );
    expect(eventsAfterDeletion(carried, 3)).toEqual(
      state({ id: A, start: 2 }, { id: B, start: 3 }, { id: C, start: 5 }),
    );
    expect(eventsAfterDeletion(carried, 7)).toEqual(carried);
  });

  it("keeps firing replies inside a fold and unfolds them as their return", () => {
    const carried = state({ id: A, start: 2 }, { id: B, start: 4 }, { id: C, start: 6 });
    expect(eventsAfterFold(carried, 3, chat(3).slice(0, 3))).toEqual(
      state({ id: A, start: -1, foldedReplies: 0 }, { id: B, start: 1 }, { id: C, start: 3 }),
    );
    expect(eventsAfterFold(carried, -2, [])).toEqual(
      state({ id: A, start: 4 }, { id: B, start: 6 }, { id: C, start: 8 }),
    );
    expect(eventsAfterFold(carried, 0, [])).toBe(carried);
    expect(eventsAfterFold(null, 3, [])).toBeNull();
  });

  it("preserves cooldown through successive folds and partial or complete unfolding", () => {
    const carried = state({ id: A, start: 2 });
    const roles = chat(5);
    const first = eventsAfterFold(carried, 3, roles.slice(0, 3));
    const folded = eventsAfterFold(first, 4, roles.slice(3, 7));
    expect(folded).toEqual(state({ id: A, start: -5, foldedReplies: 2 }));
    expect(folded).toEqual(eventsAfterFold(carried, 7, roles.slice(0, 7)));
    expect(eventStanding(-5, 5, roles.slice(7), 2)).toEqual({ kind: "cooldown", left: 1 });
    const partial = eventsAfterFold(folded, -2, roles.slice(5, 7));
    expect(partial).toEqual(state({ id: A, start: -3, foldedReplies: 1 }));
    expect(eventStanding(-3, 5, roles.slice(5), 1)).toEqual({ kind: "cooldown", left: 1 });
    expect(eventsAfterFold(partial, -5, roles.slice(0, 5))).toEqual(carried);
    // Restoring the triggering reply restores regeneration's ordinary invalidation.
    expect(eventStanding(2, 5, roles.slice(0, 2))).toBeNull();
  });

  it("drops crossed user-pointing anchors before their role evidence is folded away", () => {
    const carried = state(
      { id: A, start: 2 },
      { id: B, start: 0 },
      { id: C, start: 3 },
      { id: OTHER, start: -2, foldedReplies: 1 },
    );
    // A failed firing reply never entered the history; a later user turn now occupies its index.
    const folded = eventsAfterFold(carried, 3, ["assistant", "user", "user"]);
    expect(folded).toEqual(
      state(
        { id: B, start: -3, foldedReplies: 0 },
        { id: C, start: 0 },
        { id: OTHER, start: -5, foldedReplies: 2 },
      ),
    );
    const roll = rollEvents({
      events: [event(A, { cooldown: 5 }), event(B, { cooldown: 5 })],
      character,
      state: folded,
      roles: ["user"],
      random: draws(0),
    });
    expect(roll.fired?.id).toBe(A);
    expect(roll.kept).toEqual([{ id: B, start: -3, foldedReplies: 0 }]);
  });

  it("distinguishes folded user turns from assistant replies, excluding the triggering reply", () => {
    const carried = state({ id: A, start: 0 });
    const users = eventsAfterFold(carried, 2, ["assistant", "user"]);
    expect(users).toEqual(state({ id: A, start: -2, foldedReplies: 0 }));
    expect(eventStanding(-2, 3, ["user"], 0)).toEqual({ kind: "cooldown", left: 3 });
    const replies = eventsAfterFold(carried, 2, ["assistant", "assistant"]);
    expect(replies).toEqual(state({ id: A, start: -2, foldedReplies: 1 }));
    expect(eventStanding(-2, 3, ["user"], 1)).toEqual({ kind: "cooldown", left: 2 });
  });

  it("keeps a folded firing reply through live deletion, Undo and truncation", () => {
    const carried = state({ id: A, start: -5, foldedReplies: 2 });
    const roles: ChatRole[] = ["user", "assistant", "user", "assistant", "user"];
    expect(eventStanding(-5, 5, roles, 2)).toEqual({ kind: "cooldown", left: 1 });
    const deleted = eventsAfterDeletion(carried, 1);
    expect(deleted).toEqual(carried);
    expect(
      eventStanding(
        -5,
        5,
        roles.filter((_, index) => index !== 1),
        2,
      ),
    ).toEqual({
      kind: "cooldown",
      left: 2,
    });
    expect(eventsAfterInsertion(deleted, 1)).toEqual(carried);
    expect(eventsAfterTruncation(carried, 0)).toEqual(carried);
    expect(eventStanding(-5, 5, [], 2)).toEqual({ kind: "cooldown", left: 3 });
  });

  it("drops every record at or past a cut and keeps the earlier ones as they were", () => {
    const carried = state({ id: A, start: 2 }, { id: B, start: 4 }, { id: C, start: 6 });
    expect(eventsAfterTruncation(carried, 4)).toEqual(state({ id: A, start: 2 }));
    expect(eventsAfterTruncation(carried, 7)).toEqual(carried);
    expect(eventsAfterTruncation(carried, 0)).toEqual(state());
  });

  it("moves every record at or after an inserted turn up one, and undoes a deletion there", () => {
    const carried = state({ id: A, start: 2 }, { id: B, start: 4 }, { id: C, start: 6 });
    expect(eventsAfterInsertion(carried, 4)).toEqual(
      state({ id: A, start: 2 }, { id: B, start: 5 }, { id: C, start: 7 }),
    );
    expect(eventsAfterInsertion(carried, 7)).toEqual(carried);
    expect(eventsAfterInsertion(eventsAfterDeletion(carried, 3), 3)).toEqual(carried);
  });
});
