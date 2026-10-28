import { describe, expect, it } from "vitest";
import { EXAMPLE_SEPARATOR, exampleBlocks } from "./examples.ts";

describe("native example passages", () => {
  it("keeps speaker labels and ordinary narration in self-contained system blocks", () => {
    const blocks = exampleBlocks(
      `Narration.\nMira: Hello.\nVale: Hi.${EXAMPLE_SEPARATOR}Only prose.`,
    );
    expect(blocks.map((block) => block.map((message) => message.content))).toEqual([
      ["Narration.\nMira: Hello.\nVale: Hi."],
      ["Only prose."],
    ]);
    for (const block of blocks)
      for (const message of block) expect(message).not.toHaveProperty("name");
  });
  it("wraps nonempty data only and reports original ranges", () => {
    const ranges: number[][] = [];
    const blocks = exampleBlocks(
      ` \n ${EXAMPLE_SEPARATOR}  Mira: Hello.  `,
      (text) => `[${text}]`,
      (_message, start, end) => ranges.push([start, end]),
    );
    expect(blocks[0]?.[0]?.content).toBe("[Mira: Hello.]");
    expect(ranges).toHaveLength(1);
    expect(exampleBlocks(" \n ", () => "WRAPPER")).toEqual([]);
  });
  it("does not interpret foreign grammar at runtime", () => {
    expect(exampleBlocks("<START>\nMira: Hi.")[0]?.[0]?.content).toBe("<START>\nMira: Hi.");
  });
});
