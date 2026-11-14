import { describe, expect, it } from "vitest";
import { isOneLine, oneLine } from "./lines.ts";

const BREAKS = ["\n", "\r", "\r\n", "\u0085", "\u2028", "\u2029"];

describe("one-line text", () => {
  it.each(BREAKS)("refuses %j and writes it as one space", (line) => {
    expect(isOneLine(`a${line}b`)).toBe(false);
    expect(oneLine(`a${line}b`)).toBe("a b");
    expect(isOneLine(oneLine(`a${line}b${line}`))).toBe(true);
  });

  it("leaves a line as it is, tabs and other spaces included", () => {
    expect(isOneLine("a\tb\u00a0c")).toBe(true);
    expect(oneLine("a\tb\u00a0c")).toBe("a\tb\u00a0c");
    expect(isOneLine("")).toBe(true);
  });
});
