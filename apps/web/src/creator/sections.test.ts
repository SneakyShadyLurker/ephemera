import { type CreatorKind, parseCardAnswer } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { cardRows, writingCaption, writingEdge, writingProgress } from "./sections.ts";

const subject = (name: string) =>
  [
    `<${name}>`,
    "<backgroundstory>Keeps the archive.</backgroundstory>",
    "<appearance>Tall, grey eyes.</appearance>",
    "<personality>Calm and exact.</personality>",
    "<vocabulary>Short sentences.</vocabulary>",
    `</${name}>`,
  ].join("\n");

const ANSWERS: Record<CreatorKind, string> = {
  subject: [
    "<name>Ada Reed</name>",
    `<description>\n${subject("ada_reed")}\n</description>`,
    "<firstMessage>Location: the archive, dusk.\nRain ticks on the roof.</firstMessage>",
    "<creatorNotes>An archivist to meet.</creatorNotes>",
  ].join("\n"),
  group: [
    "<name>Ada Reed and Bo Lind</name>",
    `<description>\n${subject("ada_reed")}\n${subject("bo_lind")}\n</description>`,
    "<firstMessage>Location: the archive, dusk.\nRain ticks on the roof.</firstMessage>",
    "<creatorNotes>An archivist to meet.</creatorNotes>",
  ].join("\n"),
  scenario: [
    "<name>The Slate Valley</name>",
    `<description>\n<Roleplay>\nA surveyor arrives.\n</Roleplay>\n<Setting>A valley town.</Setting>\n<People>Millers.</People>\n<Tone>Quiet.</Tone>\n</description>`,
    "<firstMessage>Location: the pass, dawn.\nFog sits in the valley.</firstMessage>",
    "<creatorNotes>A valley to enter.</creatorNotes>",
  ].join("\n"),
};

/** The answer as it streams in, a few characters at a time. */
const prefixes = (text: string) =>
  Array.from({ length: Math.ceil(text.length / 7) + 1 }, (_, index) => text.slice(0, index * 7));

describe("writing progress", () => {
  for (const kind of ["subject", "group", "scenario"] as const) {
    it(`runs from 0 to 1 and never steps back while a ${kind} streams in`, () => {
      const measures = prefixes(ANSWERS[kind]).map((text) =>
        writingProgress(parseCardAnswer(text)),
      );
      expect(measures[0]).toBe(0);
      expect(measures.at(-1)).toBe(1);
      for (const [index, measure] of measures.entries()) {
        expect(measure).toBeGreaterThanOrEqual(measures[index - 1] ?? 0);
      }
    });
  }
});

describe("the frame's caption", () => {
  const caption = (text: string) => {
    const answer = parseCardAnswer(text);
    const rows = cardRows("subject", answer);
    return writingCaption(answer, rows, writingEdge(answer, rows));
  };

  it("names nothing before the model writes, then the section text arrives in", () => {
    expect(caption("")).toBe("Writing");
    expect(caption("<name>Ada")).toBe("Writing the name");
    expect(caption("<name>Ada</name>\n<description>\n<ada_reed>\n<backgroundstory>Keeps")).toBe(
      "Writing the background",
    );
    expect(caption(ANSWERS.subject.slice(0, ANSWERS.subject.indexOf("Rain")))).toBe(
      "Writing the opening",
    );
    expect(caption(ANSWERS.subject.slice(0, ANSWERS.subject.indexOf("archivist to meet")))).toBe(
      "Writing the tagline",
    );
  });
});
