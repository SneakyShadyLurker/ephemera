import type { ChangeEvent } from "react";
import { describe, expect, it } from "vitest";
import { charLimit, charLimitOf, fitChange } from "./text.ts";

/** What the field holds after a change to `next` that left the caret at `end`, as its own `onChange` would read it. */
function changed(limit: number, value: string, next: string, end = next.length) {
  const target = {
    value: next,
    selectionEnd: end,
    caret: end,
    setSelectionRange(start: number) {
      this.caret = start;
    },
  };
  charLimit(limit, value).onChangeCapture({ target } as unknown as ChangeEvent<HTMLInputElement>);
  return { text: target.value, caret: target.caret };
}

describe("a field held to a number of characters", () => {
  it("has the limit as its maxLength for text of one unit a character", () => {
    expect(charLimit(200, "").maxLength).toBe(200);
    expect(charLimit(200, "Mara").maxLength).toBe(200);
  });

  it("allows a unit more for each character written as two, so the limit counts characters", () => {
    // 150 characters in 300 units: 50 more characters fit, as the schema allows.
    expect(charLimit(200, "🌙".repeat(150)).maxLength).toBe(350);
    expect(charLimit(200, "🌙".repeat(200)).maxLength).toBe(400);
  });

  it("cuts a whole replacement at its end, as when plain text replaces two-unit characters", () => {
    const name = "🌙".repeat(32) + "x".repeat(32);
    // The attribute would let 96 units of plain text replace the 64 characters.
    expect(charLimit(64, name).maxLength).toBe(96);
    expect(changed(64, name, "y".repeat(96))).toEqual({ text: "y".repeat(64), caret: 64 });
    expect(changed(64, name, "🌙".repeat(70)).text).toBe("🌙".repeat(64));
  });

  it("cuts only what an edit put in, keeping the text around it whole", () => {
    const value = "🌙".repeat(100) + "x".repeat(100);
    // The first 50 moons replaced by 100 letters: 250 characters in the 300 units the attribute allows.
    const next = "y".repeat(100) + "🌙".repeat(50) + "x".repeat(100);
    expect(changed(200, value, next, 100)).toEqual({
      text: "y".repeat(50) + "🌙".repeat(50) + "x".repeat(100),
      caret: 50,
    });
    // An insertion in the middle of a full text leaves both sides as they were.
    const full = "a".repeat(100) + "🌙".repeat(100);
    expect(changed(200, full, `${"a".repeat(100)}zz${"🌙".repeat(100)}`, 102)).toEqual({
      text: full,
      caret: 100,
    });
  });

  it("cuts a pasted text that ends as the old one did at the paste's own end", () => {
    const value = "🌙".repeat(100) + "x".repeat(100);
    // Select all, paste 300 units that share the old ending: every character is the paste's.
    const pasted = "y".repeat(200) + "x".repeat(100);
    expect(changed(200, value, pasted)).toEqual({ text: "y".repeat(200), caret: 200 });
  });

  it("keeps or cuts a two-unit character whole, and a lone surrogate as the character it counts as", () => {
    expect(fitChange(3, "🌙🌙🌙", "🌙🌙🌕🌕🌙", 8).text).toBe("🌙🌙🌙");
    expect(fitChange(4, "🌙🌙🌙", "🌙🌙🌕🌕🌙", 8).text).toBe("🌙🌙🌕🌙");
    // A stored lone low surrogate after the edit is text the edit did not touch.
    const suffix = `\udc00${"x".repeat(99)}`;
    const value = "🌙".repeat(100) + suffix;
    const fitted = fitChange(200, value, "a".repeat(200) + suffix, 200);
    expect(fitted).toEqual({ text: "a".repeat(100) + suffix, caret: 100 });
  });

  it("holds the limit when a pasted lone surrogate pairs with one after the caret", () => {
    const suffix = `\udc00${"x".repeat(197)}`;
    // Two moons replaced by four units whose last pairs with the stored low surrogate.
    const within = fitChange(200, `🌙🌙${suffix}`, `abc\ud800${suffix}`, 4);
    expect(within).toEqual({ text: `ab${suffix}`, caret: 2 });
    const stored = `🌙🌙🌙\udc00${"x".repeat(196)}`;
    const grown = fitChange(199, stored, `abcd\ud800\udc00${"x".repeat(196)}`, 5);
    expect(grown).toEqual({ text: `abc${"\udc00"}${"x".repeat(196)}`, caret: 3 });
    for (const { text } of [within, grown]) expect([...text].length).toBe(200);
  });

  it("lets a text already past its limit shrink, and never grow", () => {
    const stored = "x".repeat(12);
    expect(changed(10, stored, "x".repeat(11), 5).text).toBe("x".repeat(11));
    expect(changed(10, stored, `${"x".repeat(6)}yy${"x".repeat(6)}`, 8)).toEqual({
      text: stored,
      caret: 6,
    });
  });

  it("leaves a change within the limit as typed", () => {
    expect(changed(64, "Mara", "Mara B").text).toBe("Mara B");
    expect(changed(4, "🌙🌙🌙", "🌙🌙🌙🌙").text).toBe("🌙🌙🌙🌙");
  });

  it("reads a field's props, leaving a field without a limit or a text value alone", () => {
    expect(charLimitOf({ maxLength: 10, value: "🌙a" })).toMatchObject({ maxLength: 11 });
    expect(charLimitOf({ value: "🌙a" })).toEqual({});
    expect(charLimitOf({ maxLength: 10 })).toEqual({});
    expect(charLimitOf({ maxLength: 10, value: ["a"] })).toEqual({});
  });
});
