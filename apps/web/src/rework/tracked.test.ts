import type { PlacedChange } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { clearWordDiffs, type Segment, segmentField } from "./tracked.ts";

const OPTIONS = { collapseWords: 60 };

/** A change to the description replacing `text.slice(start, end)`. */
const change = (at: number, start: number, end: number, replace: string): PlacedChange => ({
  at,
  field: { kind: "text", key: "description" },
  why: "",
  find: "",
  replace,
  start,
  end,
  whole: false,
});

/** The field as the segments rebuild it. */
const joined = (segments: Segment[]) =>
  segments.map((segment) => (segment.kind === "change" ? segment.find : segment.text)).join("");

/** Ten words a sentence: "Sentence 3 has words a b c d e f." */
const sentence = (index: number) => `Sentence ${index} has words a b c d e f.`;
const sentences = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => sentence(from + i)).join(" ");

/** The offset of the word "d" in sentence `index` of `text`. */
const dOf = (text: string, index: number) =>
  text.indexOf(`Sentence ${index} `) + `Sentence ${index} has words a b c `.length;

describe("segmentField", () => {
  it("folds a 500-word field around two changes, keeping each change's sentence", () => {
    const text = sentences(0, 50);
    const first = dOf(text, 10);
    const second = dOf(text, 40);
    const segments = segmentField(
      text,
      [change(1, second, second + 1, "D"), change(0, first, first + 1, "delta")],
      OPTIONS,
    );

    expect(segments.map((segment) => segment.kind)).toEqual([
      "collapsed",
      "same",
      "change",
      "same",
      "collapsed",
      "same",
      "change",
      "same",
      "collapsed",
    ]);
    expect(
      segments.flatMap((segment) => (segment.kind === "collapsed" ? [segment.words] : [])),
    ).toEqual([100, 290, 90]);
    const visible = segments.flatMap((segment) => (segment.kind === "same" ? [segment.text] : []));
    expect(visible).toEqual([
      "Sentence 10 has words a b c ",
      " e f. ",
      "Sentence 40 has words a b c ",
      " e f. ",
    ]);
    const changes = segments.flatMap((segment) => (segment.kind === "change" ? [segment] : []));
    expect(changes.map(({ id, find, replace }) => ({ id, find, replace }))).toEqual([
      { id: "0", find: "d", replace: "delta" },
      { id: "1", find: "d", replace: "D" },
    ]);
    expect(joined(segments)).toBe(text);
  });

  it("keeps the 12 nearest words when the change's sentence passes 40 words", () => {
    const long = `${Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ")} target`;
    const text = `${sentences(0, 10)} ${long}`;
    const start = text.indexOf("target");
    const segments = segmentField(text, [change(0, start, text.length, "aim")], OPTIONS);
    expect(segments.map((segment) => segment.kind)).toEqual(["collapsed", "same", "change"]);
    const context = segments[1];
    expect(context?.kind === "same" ? context.text : "").toBe(
      `${Array.from({ length: 12 }, (_, i) => `w${38 + i}`).join(" ")} `,
    );
    expect(segments[0]).toMatchObject({ words: 100 + 38 });
    expect(joined(segments)).toBe(text);
  });

  it("ends the context at a paragraph break inside the run", () => {
    const text = `She keeps the light on the rock\n${sentences(0, 10)}`;
    const start = text.indexOf("light");
    const segments = segmentField(text, [change(0, start, start + 5, "lamp")], OPTIONS);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "same",
      "change",
      "same",
      "collapsed",
    ]);
    expect(segments[2]).toEqual({ kind: "same", text: " on the rock\n" });
    expect(segments[3]).toMatchObject({ words: 100 });
    expect(joined(segments)).toBe(text);
  });

  it("leaves a short field unfolded", () => {
    const text = sentences(0, 5);
    const start = dOf(text, 2);
    const segments = segmentField(text, [change(0, start, start + 1, "x")], OPTIONS);
    expect(segments.map((segment) => segment.kind)).toEqual(["same", "change", "same"]);
    expect(joined(segments)).toBe(text);
  });

  it("gives a whole-field change one segment", () => {
    const text = sentences(0, 20);
    const segments = segmentField(
      text,
      [{ ...change(0, 0, text.length, "All new."), whole: true }],
      OPTIONS,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "change", find: text, replace: "All new." });
  });

  it("puts nothing between adjacent changes", () => {
    const text = "one two three four";
    const segments = segmentField(
      text,
      [change(0, 0, 3, "uno"), change(1, 3, 7, " dos"), change(2, 7, text.length, " tres")],
      OPTIONS,
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["change", "change", "change"]);
    expect(joined(segments)).toBe(text);
  });

  it("shows a large, low-overlap rewrite as one passage and a light edit inline", () => {
    const original = sentences(0, 5);
    const rewrite = Array.from({ length: 50 }, (_, i) => `fresh${i}`).join(" ");
    const [passage] = segmentField(original, [change(0, 0, original.length, rewrite)], OPTIONS);
    expect(passage).toMatchObject({ kind: "change", mode: "passage" });

    const edited = original.replace("Sentence 2", "Line 2");
    const [light] = segmentField(original, [change(0, 0, original.length, edited)], OPTIONS);
    expect(light).toMatchObject({ kind: "change", mode: "inline" });

    // Small rewrites interleave, however little they keep.
    const [small] = segmentField("a short line", [change(0, 0, 12, "something else")], OPTIONS);
    expect(small).toMatchObject({ kind: "change", mode: "inline" });

    // A pure insertion has no original to disclose.
    const [inserted] = segmentField("", [change(0, 0, 0, rewrite.repeat(2))], OPTIONS);
    expect(inserted).toMatchObject({ kind: "change", mode: "inline" });
  });

  it("gives up on the word diff of a large dissimilar rewrite quickly, as a passage", () => {
    const original = Array.from({ length: 4_000 }, (_, i) => `old${i % 997}`).join(" ");
    const rewrite = Array.from({ length: 4_000 }, (_, i) => `new${i % 991}`).join(" ");
    const started = performance.now();
    const [rewritten] = segmentField(original, [change(0, 0, original.length, rewrite)], OPTIONS);
    expect(performance.now() - started).toBeLessThan(500);
    expect(rewritten).toMatchObject({
      kind: "change",
      mode: "passage",
      runs: [
        { kind: "del", text: original },
        { kind: "ins", text: rewrite },
      ],
    });

    // A replacement too short to keep enough of the original is a passage by size alone.
    const [shortened] = segmentField(original, [change(1, 0, original.length, "Brief.")], OPTIONS);
    expect(shortened).toMatchObject({ kind: "change", mode: "passage" });
  });

  it("keeps a long removal struck in view, never folded behind its original", () => {
    const original = sentences(0, 40);
    const [removed] = segmentField(original, [change(0, 0, original.length, "")], OPTIONS);
    expect(removed).toMatchObject({
      kind: "change",
      mode: "inline",
      runs: [{ kind: "del", text: original }],
    });
  });
});

describe("where a change's reason stands", () => {
  /** Each change's reason offset, in text order. */
  const reasons = (text: string, changes: PlacedChange[]) =>
    segmentField(text, changes, OPTIONS).flatMap((segment) =>
      segment.kind === "change" ? [segment.reasonAt] : [],
    );

  it("after the sentence holding the change, so the sentence reads on unbroken", () => {
    const text = "The ledger lists every ship that left the harbour. It is kept in the back room.";
    const start = text.indexOf("every ship");
    const end = start + "every ship that left".length;
    expect(reasons(text, [change(0, start, end, "every ship and cargo that left")])).toEqual([
      text.indexOf("It is kept"),
    ]);
  });

  it("before the line break that ends the sentence", () => {
    const text = "She keeps the light on the rock\n\nThe tide is out.";
    const start = text.indexOf("light");
    expect(reasons(text, [change(0, start, start + 5, "lamp")])).toEqual([text.indexOf("\n")]);
  });

  it("stacks the rows of changes that end in one sentence there, in text order", () => {
    const text = "Mara is 24 and tall. She reads.";
    const close = text.indexOf("She");
    expect(reasons(text, [change(1, 15, 19, "short"), change(0, 8, 10, "34")])).toEqual([
      close,
      close,
    ]);
  });

  it("waits for a later change that runs past the sentence's end", () => {
    const text = "Mara is 24 and tall. She reads maps. The end.";
    const later = change(1, text.indexOf("tall"), text.indexOf("maps") + 4, "short and reads");
    expect(reasons(text, [change(0, 8, 10, "34"), later])).toEqual([
      text.indexOf("The end"),
      text.indexOf("The end"),
    ]);
  });

  it("at the field's end for a change that reaches it", () => {
    const text = "One sentence. Two sentence";
    expect(reasons(text, [change(0, text.indexOf("Two"), text.length, "Three")])).toEqual([
      text.length,
    ]);
  });
});

/** The word diff the review shows for a change replacing the whole of `find`. */
const wordDiff = (find: string, replace: string) => {
  const [segment] = segmentField(find, [change(0, 0, find.length, replace)], OPTIONS);
  if (segment?.kind !== "change") throw new Error("expected a change");
  return segment.runs;
};

describe("a change's word diff", () => {
  it("diffs a one-word replacement into same, del, ins, same with whitespace kept", () => {
    expect(wordDiff("the  old house\n", "the  new house\n")).toEqual([
      { kind: "same", text: "the  " },
      { kind: "del", text: "old" },
      { kind: "ins", text: "new" },
      { kind: "same", text: " house\n" },
    ]);
  });

  it("diffs a pair once until cleared", () => {
    const runs = wordDiff("a b", "a c");
    expect(wordDiff("a b", "a c")).toBe(runs);
    clearWordDiffs();
    const again = wordDiff("a b", "a c");
    expect(again).not.toBe(runs);
    expect(again).toEqual(runs);
  });
});
