import type { LorebookStatus, LorebookReport as Report } from "@ephemera/core";
import { LOREBOOK_STATUSES } from "@ephemera/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chanceMissedText, poolLostText } from "../lorebook/copy.ts";
import { LorebookReport } from "./LorebookReport.tsx";

const counts = (set: Partial<Record<LorebookStatus, number>>) =>
  Object.fromEntries(LOREBOOK_STATUSES.map((status) => [status, set[status] ?? 0])) as Record<
    LorebookStatus,
    number
  >;

const listed = (status: LorebookStatus, amount: number): Report["entries"] =>
  Array.from({ length: amount }, (_, index) => ({
    index,
    title: `Entry ${index}`,
    placement: "before" as const,
    status,
    reason: { kind: "constant" as const },
    tokens: 1,
  }));

describe("the inspector's lorebook report", () => {
  it("says how many entries past the listed 200 are counted but not named", () => {
    const report: Report = {
      scanDepth: 2,
      scannedTurns: 2,
      passes: 1,
      budget: 1_000,
      used: 5,
      entries: [...listed("sent", 5), ...listed("doesNotFit", 1), ...listed("afterCutoff", 199)],
      counts: counts({ sent: 5, doesNotFit: 1, afterCutoff: 4_000 }),
      sources: [{ id: null, name: "", count: 200 }],
      keyProblems: [],
    };
    const out = renderToStaticMarkup(<LorebookReport report={report} name="Maren" draft={false} />);
    expect(out).toContain("5 entries went in, 4,001 over the budget");
    expect(out).toContain("And 3,801 more, counted but not listed.");
  });

  it("names the entry whose text brought a recursed entry in", () => {
    const report: Report = {
      scanDepth: 2,
      scannedTurns: 2,
      passes: 3,
      budget: 1_000,
      used: 2,
      entries: [
        { ...(listed("sent", 1)[0] as Report["entries"][number]), title: "The ferry", pass: 0 },
        {
          index: 1,
          title: "The anchor",
          placement: "before",
          status: "sent",
          pass: 1,
          reason: { kind: "recursed", key: "ferry", matched: "ferry", from: 0 },
          tokens: 1,
        },
      ],
      counts: counts({ sent: 2 }),
      sources: [{ id: null, name: "", count: 200 }],
      keyProblems: [],
    };
    const out = renderToStaticMarkup(<LorebookReport report={report} name="Maren" draft={false} />);
    expect(out).toContain("brought in by");
    expect(out).toContain('<span class="text-ink">The ferry</span>');
  });
});

describe("the report's words for each reason and status", () => {
  type Line = Report["entries"][number];
  const sent = (index: number, title: string, rest: Partial<Line>): Line => ({
    index,
    title,
    placement: "before",
    status: "sent",
    reason: { kind: "constant" },
    tokens: 3,
    ...rest,
  });
  const key = (secondary: Partial<Extract<Line["reason"], { kind: "key" }>> = {}) => ({
    kind: "key" as const,
    key: "harbour",
    matched: "harbour",
    ...secondary,
  });
  const markup = (entries: Line[], set: Partial<Report> = {}) => {
    const report: Report = {
      scanDepth: 2,
      scannedTurns: 2,
      passes: 1,
      budget: 1_000,
      used: 10,
      entries,
      counts: counts(
        Object.fromEntries(
          LOREBOOK_STATUSES.map((status) => [
            status,
            entries.filter((entry) => entry.status === status).length,
          ]),
        ),
      ),
      sources: [{ id: null, name: "", count: 200 }],
      keyProblems: [],
      ...set,
    };
    return renderToStaticMarkup(
      <LorebookReport report={report} name="Maren" draft={false} />,
    ).replaceAll("&#x27;", "'");
  };
  /** Tags out: the words as they read. */
  const text = (entries: Line[], set: Partial<Report> = {}) =>
    markup(entries, set).replace(/<[^>]+>/g, "");

  it.each([
    [
      "AND ANY",
      key({ logic: "andAny", secondary: [{ key: "gull", matched: "gull" }] }),
      "matched harbour, with gull",
    ],
    [
      "AND ALL",
      key({
        logic: "andAll",
        secondary: [
          { key: "gull", matched: "gull" },
          { key: "rope", matched: "rope" },
        ],
      }),
      "matched harbour, with gull and rope",
    ],
    [
      "NOT ANY",
      key({
        logic: "notAny",
        secondary: [
          { key: "storm", matched: "" },
          { key: "squall", matched: "" },
        ],
      }),
      "matched harbour, without storm or squall",
    ],
    [
      "NOT ALL",
      key({ logic: "notAll", secondary: [{ key: "storm", matched: "" }] }),
      "matched harbour, and not all of its other words were there",
    ],
    ["no secondary keys", key(), "Before the character, matched harbour"],
  ])("words a secondary match under %s", (_, reason, words) => {
    expect(text([sent(0, "Harbour", { reason })])).toContain(words);
  });

  it("names the placement as the editor does, the entry that brought one in, and a sticky span", () => {
    const out = text(
      [
        sent(0, "The Grey Lantern", {
          placement: "after",
          reason: key({ key: "lamp", matched: "lamp" }),
        }),
        sent(1, "Gull omen", {
          placement: "depth",
          depth: 4,
          role: "system",
          pass: 1,
          reason: { kind: "recursed", key: "lamp", matched: "lamp", from: 0 },
        }),
        sent(2, "Fog manner", { placement: "anTop", reason: { kind: "sticky", left: 2 } }),
        sent(3, "Keeper's log", { placement: "examplesTop", reason: { kind: "sticky", left: 1 } }),
        sent(4, "Wake", { placement: "depth", depth: 0, role: "user" }),
      ],
      { passes: 3 },
    );
    expect(out).toContain("After the character, matched lamp");
    expect(out).toContain(
      "In the chat at depth 4 as system, brought in by The Grey Lantern, matched lamp",
    );
    expect(out).toContain("Above the Author's Note, stays in, 2 more messages");
    expect(out).toContain("Before the example dialogue, stays in, 1 more message");
    expect(out).toContain("In the chat after the last message as user, always on");
    expect(out).toContain("Entries' text was read 2 more times for entries it brings in.");
  });

  it("says which entries went in by chance, and counts those their roll left out", () => {
    const out = text([
      sent(0, "Gull", { reason: { kind: "constant", chance: 10 } }),
      sent(1, "Harbour", { reason: key({ chance: 25 }) }),
      {
        index: 2,
        title: "Squall",
        placement: "before",
        status: "chanceMissed",
        reason: { kind: "constant", chance: 5 },
      },
    ]);
    expect(out).toContain("Before the character, passed the 10% chance");
    expect(out).toContain("Before the character, matched harbour, passed the 25% chance");
    // The closed list of other entries says it after the title.
    expect(chanceMissedText(5)).toBe("chance did not pass (5%)");
    expect(markup([sent(0, "Squall", { status: "chanceMissed" })])).toContain(
      `aria-label="Other entries: 1 left out by chance"`,
    );
  });

  it("says a sticky entry with a chance was kept without a roll", () => {
    const out = text([
      sent(0, "Fog", { reason: { kind: "sticky", left: 2, chance: 10 } }),
      sent(1, "Rope", { reason: { kind: "sticky", left: 1 } }),
    ]);
    expect(out).toContain(
      "Before the character, stays in, 2 more messages, kept by sticky without a roll (10% chance)",
    );
    expect(out).toContain("Before the character, stays in, 1 more message");
    expect(out).not.toContain("1 more message, kept");
  });

  it("names each entry's book when several were read, and the card's after its character", () => {
    const sources = [
      { id: null, name: "", count: 1 },
      { id: "00000000-0000-4000-8000-000000000002", name: "Harbour events", count: 2 },
    ];
    const out = text([sent(0, "Lantern", {}), sent(2, "Gull", {})], { sources });
    expect(out).toContain("Maren's 2 lorebooks, read together, read against the last 2 messages");
    expect(out).toContain("LanternMaren's lorebook");
    expect(out).toContain("GullHarbour events");
    // One book: no line names it, and the header names the book.
    const single = text([sent(0, "Gull", {})], { sources: sources.slice(1) });
    expect(single).toContain("Harbour events, read against");
    expect(single).not.toContain("GullHarbour");
  });

  it("counts entries an event pool left out and says which entry took the pool", () => {
    const lost = (index: number, title: string, pool: Line["pool"]): Line => ({
      index,
      title,
      placement: "before",
      status: "poolLost",
      reason: key(),
      ...(pool === undefined ? {} : { pool }),
    });
    expect(
      markup([
        sent(0, "Rain", {}),
        lost(1, "Fog", { name: "Weather", holder: 0 }),
        lost(2, "Night", { name: "Sky" }),
      ]),
    ).toContain(`aria-label="Other entries: 2 left out by an event pool"`);
    expect(poolLostText("Weather", "Rain")).toBe("pool Weather went to Rain");
    expect(poolLostText("Sky", null)).toBe("pool Sky was already taken");
  });

  it("reads against the book's depth, and further only when an entry asks for it", () => {
    const plain = text([sent(0, "Tide", {})]);
    expect(plain).toContain("read against the last 2 messages.");
    expect(plain).not.toContain("more time");
    expect(text([sent(0, "Tide", { scanDepth: 6 })])).toContain(
      "read against the last 2 messages, further for entries that ask for it.",
    );
    expect(text([sent(0, "Tide", {})], { passes: 2 })).toContain(
      "Entries' text was read 1 more time for entries it brings in.",
    );
  });

  it("words the other entries' statuses, the timed ones first", () => {
    const other = (
      index: number,
      title: string,
      status: LorebookStatus,
      rest: Partial<Line> = {},
    ) => ({
      index,
      title,
      placement: "before" as const,
      status,
      ...rest,
    });
    const out = markup([
      other(0, "Bell", "notMatched"),
      other(1, "Gull omen", "cooldown", { left: 2 }),
      other(2, "Rope", "cooldown", { left: 1 }),
      other(3, "Wreck", "delayed", { until: 4 }),
      other(4, "Storm", "filtered"),
      other(5, "Fog", "noteOff"),
      other(6, "Heron", "chainOnly"),
    ]);
    expect(out).toContain(
      `aria-label="Other entries: 2 resting after going in, 1 waiting for a longer chat, 1 waiting for another entry, 1 ruled out by its other words, 1 not matched, 1 not sent without the Author's Note"`,
    );
  });
});
