import { describe, expect, it } from "vitest";
import { textLength } from "../card/limits.ts";
import { CREATOR_LIMITS, validateCardAnswer } from "../creator/index.ts";
import { clipTailToTokens, estimateTokens, utf8Bytes } from "../tokens.ts";
import {
  SCENE_LIMITS,
  SCENE_REFERENCE_NOTE,
  sceneExcerpt,
  scenePrompt,
  sceneRequestSchema,
  sceneSource,
} from "./index.ts";

const NAMES = { user: "Rowan", char: "Ava" };
const turn = (role: "user" | "assistant", content: string, name?: string) =>
  name === undefined ? { role, content } : { role, content, name };
const card = {
  description: "Ava is a tall lighthouse keeper with short copper hair.",
  personality: "Calm. Dry humour.",
  scenario: "",
  firstMessage: "",
};

describe("clipTailToTokens", () => {
  it("keeps a text that fits whole and the end of one that does not", () => {
    expect(clipTailToTokens("abcdefgh", 2)).toBe("abcdefgh");
    expect(clipTailToTokens("abcdefghij", 2)).toBe("cdefghij");
    expect(clipTailToTokens("abc", 0)).toBe("");
  });

  it("cuts multibyte text at a code point boundary, within the estimate", () => {
    // "é" is two UTF-8 bytes, the emoji four (a surrogate pair).
    const text = "é🌊é🌊é🌊";
    for (let tokens = 0; tokens <= 5; tokens++) {
      const clipped = clipTailToTokens(text, tokens);
      expect(text.endsWith(clipped)).toBe(true);
      expect(clipped).toBe(Array.from(clipped).join(""));
      expect(clipped.isWellFormed()).toBe(true);
      expect(estimateTokens(clipped)).toBeLessThanOrEqual(tokens);
    }
    expect(clipTailToTokens(text, 2)).toBe("é🌊");
    expect(clipTailToTokens(text, 1)).toBe("🌊");
  });
});

describe("sceneExcerpt", () => {
  it("is empty without turns", () => {
    expect(sceneExcerpt([], NAMES)).toBe("");
  });

  it("names each speaker as generation does and keeps the turns oldest first", () => {
    const excerpt = sceneExcerpt(
      [
        turn("assistant", "The lamp hums."),
        turn("user", "I climb up."),
        turn("user", "Hi.", "Kit"),
      ],
      NAMES,
    );
    expect(excerpt).toBe("Ava: The lamp hums.\n\nRowan: I climb up.\n\nKit: Hi.");
  });

  it("keeps the newest turns within the token budget, labels and separators counted", () => {
    const turns = Array.from({ length: 6 }, (_, i) => turn("assistant", `${i}`.repeat(30)));
    // Each line is "Ava: " and 30 digits, 35 bytes; with separators, three lines are 109 bytes.
    const excerpt = sceneExcerpt(turns, NAMES, { excerptTokens: 28, excerptTurns: 40 });
    expect(excerpt.split("\n\n").map((line) => line.slice(5, 6))).toEqual(["3", "4", "5"]);
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(28);
    const two = sceneExcerpt(turns, NAMES, { excerptTokens: 27, excerptTurns: 40 });
    expect(two.split("\n\n")).toHaveLength(2);
  });

  it("keeps at most the turn limit", () => {
    const turns = Array.from({ length: 50 }, (_, i) => turn("user", `turn ${i}`));
    const lines = sceneExcerpt(turns, NAMES).split("\n\n");
    expect(lines).toHaveLength(SCENE_LIMITS.excerptTurns);
    expect(lines.at(-1)).toBe("Rowan: turn 49");
  });

  it("keeps the end of a newest turn that alone passes the budget, where its latest state is", () => {
    const long = `${"She talks about the harbour. ".repeat(2_000)}She takes off her coat.`;
    const excerpt = sceneExcerpt([turn("user", "Earlier."), turn("assistant", long)], NAMES);
    expect(excerpt.startsWith("Ava: ")).toBe(true);
    expect(excerpt.endsWith("She takes off her coat.")).toBe(true);
    expect(excerpt).not.toContain("Earlier.");
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(SCENE_LIMITS.excerptTokens);
    const multibyte = sceneExcerpt([turn("assistant", `${"海".repeat(9_000)}終`)], NAMES, {
      excerptTokens: 100,
      excerptTurns: 40,
    });
    expect(multibyte.endsWith("終")).toBe(true);
    expect(utf8Bytes(multibyte)).toBeLessThanOrEqual(400);
  });
});

describe("sceneSource", () => {
  it("holds the notes, who speaks, and the excerpt", () => {
    const source = sceneSource({ kind: "subject", card, excerpt: "Ava: Hello.", names: NAMES });
    expect(source).toContain("<notes>\n");
    expect(source).toContain("short copper hair");
    expect(source).toContain('The character is "Ava". "Rowan" is {{user}}');
    expect(source.endsWith("<excerpt>\nAva: Hello.\n</excerpt>")).toBe(true);
  });

  it("names a Scenario's card name as its title, never as a character, and letters no title", () => {
    const source = sceneSource({ kind: "scenario", card, excerpt: "Ava: Hello.", names: NAMES });
    expect(source).toContain('"Ava" is the scenario\'s title, under which the narrator speaks.');
    expect(source).not.toContain("The character is");
    expect(source).not.toContain("<Title>");
  });

  it("leaves out empty notes", () => {
    const blank = { description: "", personality: "", scenario: "", firstMessage: "" };
    const source = sceneSource({ kind: "subject", card: blank, excerpt: "Ava: Hi.", names: NAMES });
    expect(source).not.toContain("<notes>");
  });

  it("cuts the notes before the excerpt when the whole is too long", () => {
    const huge = { ...card, description: `${"Copper hair. ".repeat(20_000)}` };
    const excerpt = `Ava: ${"x".repeat(20_000)} the end`;
    const source = sceneSource({ kind: "subject", card: huge, excerpt, names: NAMES });
    expect(textLength(source)).toBeLessThanOrEqual(SCENE_LIMITS.sourceLength);
    expect(source).toContain(excerpt);
    expect(source).toContain("</notes>");
  });

  it("holds the people present between the notes and the excerpt", () => {
    const people = "Ilse Brandt: 30, tall, red dress; standing at the bar.";
    const source = sceneSource({
      kind: "subject",
      card,
      excerpt: "Ava: Hi.",
      names: NAMES,
      people,
    });
    expect(source.indexOf("</notes>")).toBeLessThan(source.indexOf("<people>"));
    expect(source).toContain(`<people>\n${people}\n</people>`);
    expect(source.indexOf("</people>")).toBeLessThan(source.indexOf("<excerpt>"));
    const none = sceneSource({
      kind: "subject",
      card,
      excerpt: "Ava: Hi.",
      names: NAMES,
      people: "",
    });
    expect(none).not.toContain("<people>");
  });

  it("cuts the notes before the people, and both before the excerpt", () => {
    const excerpt = `Ava: ${"x".repeat(SCENE_LIMITS.sourceLength / 2)}`;
    const people = "Ilse: red dress. ".repeat(20_000);
    const source = sceneSource({ kind: "subject", card, excerpt, names: NAMES, people });
    expect(textLength(source)).toBeLessThanOrEqual(SCENE_LIMITS.sourceLength);
    expect(source).toContain(excerpt);
    expect(source).not.toContain("<notes>");
    expect(source).toContain("<people>\nIlse: red dress.");
    expect(source).toContain("</people>");
    expect(source.endsWith(`\n${excerpt}\n</excerpt>`)).toBe(true);
  });

  it("keeps the current people and excerpt ahead of three valid subjects' long static notes", () => {
    const description = ["ava", "ilse", "mina"]
      .map(
        (name) => `<${name}>
<backgroundstory>Grew up by the sea.</backgroundstory>
<appearance>${"Copper hair. ".repeat(250)}</appearance>
<personality>${"Calm. ".repeat(CREATOR_LIMITS.artPersonalityLength / 6)}</personality>
<vocabulary>Short sentences.</vocabulary>
</${name}>`,
      )
      .join("\n");
    expect(
      validateCardAnswer(
        "group",
        `<name>The keepers</name><description>${description}</description><firstMessage>Location: the lighthouse, dusk.</firstMessage>`,
      ).ok,
    ).toBe(true);
    const excerpt = sceneExcerpt([turn("assistant", "x".repeat(30_000))], NAMES);
    const people = "Ilse: red dress, standing at the bar. Mina: blue coat, seated by the door.";
    const source = sceneSource({
      kind: "group",
      card: { ...card, description },
      excerpt,
      names: NAMES,
      people,
    });
    expect(textLength(source)).toBeLessThanOrEqual(SCENE_LIMITS.sourceLength);
    expect(source).toContain("<notes>\n");
    expect(source.indexOf("</notes>")).toBeLessThan(source.indexOf("<people>"));
    expect(source).toContain(`<people>\n${people}\n</people>`);
    expect(source.endsWith(`<excerpt>\n${excerpt}\n</excerpt>`)).toBe(true);
  });
});

describe("scenePrompt", () => {
  it("adds the reference note only with a portrait", () => {
    expect(scenePrompt("SOURCE", false)).toBe("SOURCE");
    expect(scenePrompt("SOURCE", true)).toBe(`SOURCE\n\n${SCENE_REFERENCE_NOTE}`);
    expect(SCENE_REFERENCE_NOTE).toContain("a change the excerpt makes");
  });
});

describe("sceneRequestSchema", () => {
  const valid = {
    model: "m",
    characterId: crypto.randomUUID(),
    kind: "subject",
    source: "Ava: Hi.",
  };

  it("takes a request and refuses extra keys, an empty source or a bad character id", () => {
    expect(sceneRequestSchema.parse({ ...valid, workflow: "krea2-second" })).toMatchObject(valid);
    expect(sceneRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(sceneRequestSchema.safeParse({ ...valid, source: "  " }).success).toBe(false);
    expect(sceneRequestSchema.safeParse({ ...valid, characterId: "ava" }).success).toBe(false);
    expect(sceneRequestSchema.safeParse({ ...valid, kind: "other" }).success).toBe(false);
    expect(
      sceneRequestSchema.safeParse({ ...valid, source: "x".repeat(SCENE_LIMITS.sourceLength + 1) })
        .success,
    ).toBe(false);
  });
});
