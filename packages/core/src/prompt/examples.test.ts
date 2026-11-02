import { describe, expect, it } from "vitest";
import { EXAMPLE_SEPARATOR, exampleBlocks } from "./examples.ts";

const AFTER = { side: "after", entries: 2 } as const;

describe("native example passages", () => {
  it("keeps speaker labels and ordinary narration in self-contained system blocks", () => {
    const blocks = exampleBlocks(
      `Narration.\nMira: Hello.\nVale: Hi.${EXAMPLE_SEPARATOR}Only prose.`,
      AFTER,
    );
    expect(blocks.map((block) => block.map((message) => message.content))).toEqual([
      ["Narration.\nMira: Hello.\nVale: Hi."],
      ["Only prose."],
    ]);
    for (const block of blocks)
      for (const message of block) expect(message).not.toHaveProperty("name");
  });
  it("names each passage a lorebook example of its side, numbered in order", () => {
    const blocks = exampleBlocks(`One.${EXAMPLE_SEPARATOR} ${EXAMPLE_SEPARATOR}Two.`, AFTER);
    expect(blocks.map((block) => block.map((message) => message.source))).toEqual(
      [0, 1].map((index) => [
        { kind: "lorebook", position: "examples", side: "after", index, line: 0, entries: 2 },
      ]),
    );
  });
  it("wraps nonempty data only and reports original ranges", () => {
    const ranges: number[][] = [];
    const blocks = exampleBlocks(
      ` \n ${EXAMPLE_SEPARATOR}  Mira: Hello.  `,
      AFTER,
      (text) => `[${text}]`,
      (_message, start, end) => ranges.push([start, end]),
    );
    expect(blocks[0]?.[0]?.content).toBe("[Mira: Hello.]");
    expect(ranges).toHaveLength(1);
    expect(exampleBlocks(" \n ", AFTER, () => "WRAPPER")).toEqual([]);
  });
  it("does not interpret foreign grammar at runtime", () => {
    expect(exampleBlocks("<START>\nMira: Hi.", AFTER)[0]?.[0]?.content).toBe("<START>\nMira: Hi.");
  });
});
