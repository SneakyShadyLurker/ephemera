import { describe, expect, it } from "vitest";
import { withKnownIdentities, withSheet } from "../cast/apply.ts";
import { emptyCastAnchor, emptyCastState } from "../cast/register.ts";
import { unnamedAnswer } from "./answer.ts";
import { fillMemoryCastEntries, memoryCastEntries, readMemoryCastLine } from "./cast.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import {
  applyMemoryAnswer,
  clampMemoryAnswer,
  emptyNotebook,
  memoryAnswerSchema,
  memoryNotebookSchema,
  memoryStatePatchRequestSchema,
} from "./memory.ts";
import {
  memoryStoryText,
  notebookHasContent,
  openingMessage,
  rememberInstructions,
  rememberMessage,
} from "./prompt.ts";

const line = JSON.stringify({
  name: "Ilse Brandt",
  gender: "female",
  age: "31",
  hair: "black bob",
});
const edits = { change: [], drop: [], add: [] };
const answer = () =>
  memoryAnswerSchema.parse({
    title: "Harbour",
    summary: "They met.",
    cues: [],
    notebook: { situation: "", relationships: edits, facts: edits, threads: edits, cast: edits },
  });

describe("notebook cast", () => {
  it("accepts fixed partial anchors only and leaves invalid owner lines editable", () => {
    expect(readMemoryCastLine(line)).toMatchObject({ name: "Ilse Brandt", age: "31" });
    for (const extra of [
      { id: "id" },
      { state: {} },
      { present: true },
      { aka: [] },
      { outfit: "coat" },
    ]) {
      expect(
        readMemoryCastLine(JSON.stringify({ name: "Ilse", gender: "female", ...extra })),
      ).toBeNull();
    }
    expect(readMemoryCastLine('{"name":"Ilse"}')).toBeNull();
    expect(memoryNotebookSchema.parse({ ...emptyNotebook(), cast: ["unfinished {"] }).cast).toEqual(
      ["unfinished {"],
    );
    expect(
      memoryStatePatchRequestSchema.parse({
        notebook: { ...emptyNotebook(), cast: ["unfinished {"] },
        revision: 1,
      }).notebook?.cast,
    ).toEqual(["unfinished {"]);
  });

  it("validates model additions and changes without cutting JSON", () => {
    const withCast = (cast: unknown) => ({ ...answer(), notebook: { ...answer().notebook, cast } });
    for (const bad of [
      "",
      "unfinished {",
      JSON.stringify({ name: "Ilse", gender: "female", mood: "calm" }),
      line + " ".repeat(MEMORY_LIMITS.castLine),
    ]) {
      for (const cast of [
        { ...edits, add: [bad] },
        { ...edits, change: [{ line: 1, text: bad }] },
      ]) {
        expect(memoryAnswerSchema.parse(clampMemoryAnswer(withCast(cast))).notebook.cast).toEqual(
          edits,
        );
      }
    }
    const original = { ...emptyNotebook(), cast: ["unfinished {", line] };
    const changed = memoryAnswerSchema.parse(
      withCast({ change: [{ line: 2, text: line.replace("31", "32") }], drop: [], add: [line] }),
    );
    expect(applyMemoryAnswer(original, changed).notebook.cast).toEqual([
      "unfinished {",
      line.replace("31", "32"),
      line,
    ]);
    expect(
      memoryNotebookSchema.safeParse({ ...original, cast: Array(33).fill(line) }).success,
    ).toBe(false);
    expect(memoryNotebookSchema.safeParse({ ...original, cast: ["x".repeat(1201)] }).success).toBe(
      false,
    );
  });

  it("discards malformed optional cast edits individually while keeping other edits and owner lines", () => {
    const response = answer();
    const invalid = JSON.stringify({ name: "Wrong", gender: "female", mood: "calm" });
    const parsed = memoryAnswerSchema.parse(
      clampMemoryAnswer({
        ...response,
        summary: "A valid summary survives.",
        notebook: {
          ...response.notebook,
          facts: { ...edits, add: ["A valid fact"] },
          cast: {
            change: [
              { line: 1, text: "" },
              { line: 2, text: invalid },
              { line: 3, text: line },
            ],
            drop: [],
            add: [{ name: "Wrong", gender: "female" }, invalid, line],
          },
        },
      }),
    );
    expect(parsed.summary).toBe("A valid summary survives.");
    expect(parsed.notebook.cast).toEqual({
      change: [{ line: 3, text: line }],
      drop: [],
      add: [line],
    });
    const output = applyMemoryAnswer(
      { ...emptyNotebook(), cast: ["unfinished owner {", invalid, "old owner line"] },
      parsed,
    );
    expect(output.notebook.cast).toEqual(["unfinished owner {", invalid, line]);
    expect(output.notebook.facts).toEqual(["A valid fact"]);
  });

  it("numbers full notebook prompts and keeps narrator cast authoritative", () => {
    const notebook = { ...emptyNotebook(), cast: [line] };
    expect(notebookHasContent(notebook)).toBe(true);
    expect(
      rememberMessage({ canon: null, notebook, previous: [], transcript: "A span", room: 4000 }),
    ).toContain(`Cast (1 of 32):\n1. ${line}`);
    expect(openingMessage({ canon: null, notebook, episodes: [] })).toContain(line);
    expect(memoryStoryText(notebook, { recap: [] })).not.toContain(line);
    expect(rememberInstructions({ char: "Mara", user: "Ash" }, { words: 120 })).toContain(
      "never card subjects",
    );
  });

  it("substitutes persona references inside JSON strings without breaking their escaping", () => {
    const response = answer();
    response.notebook.cast.add = [
      JSON.stringify({ name: "Ilse", gender: "female", relationship: 'Met Ash "AJ" Reed' }),
    ];
    const unnamed = unnamedAnswer(
      response,
      ['Ash "AJ" Reed'],
      memoryAnswerSchema,
      clampMemoryAnswer,
    );
    expect(readMemoryCastLine(unnamed.notebook.cast.add[0] ?? "")?.relationship).toBe(
      "Met {{user}}",
    );
    const entries = memoryCastEntries(unnamed.notebook.cast.add, () => "chat-id");
    expect(fillMemoryCastEntries(entries, 'Rae "R" Fox')[0]?.anchor.relationship).toBe(
      'Met Rae "R" Fox',
    );
    expect(entries[0]?.anchor.relationship).toBe("Met {{user}}");
  });

  it("admits card anchors before remembered minor entries, idempotently and without scene state", () => {
    let n = 0;
    const memory = {
      entries: memoryCastEntries([line, line, "unfinished"], () => `memory-${n++}`),
    };
    expect(memory.entries).toHaveLength(1);
    const card = {
      entries: [
        {
          id: "card",
          role: "principal" as const,
          aka: [],
          anchor: { ...emptyCastAnchor("Ilse", "female"), hair: "copper" },
        },
      ],
    };
    const register = withSheet(memory, withSheet(card, { entries: [] }), { fillOnly: true });
    expect(register.entries).toHaveLength(1);
    expect(register.entries[0]).toMatchObject({
      id: "card",
      role: "principal",
      anchor: { hair: "copper", age: "31" },
      state: emptyCastState(false),
    });
    expect(withSheet(memory, register, { fillOnly: true })).toEqual(register);
    expect(withSheet(memory, { entries: [] }, { player: "Ilse Brandt" }).entries).toEqual([]);
    expect(withSheet(memory, { entries: [] }).entries[0]?.role).toBe("minor");
  });

  it("never evicts known entries at capacity, with deterministic seed admission", () => {
    const base = {
      entries: Array.from({ length: 39 }, (_, i) => ({
        id: `known-${i}`,
        role: "minor" as const,
        aka: [],
        anchor: emptyCastAnchor(`Known ${i}`, "female"),
        state: emptyCastState(true),
      })),
    };
    const memory = { entries: memoryCastEntries([line], () => "memory") };
    const card = {
      entries: [
        {
          id: "card",
          role: "principal" as const,
          aka: [],
          anchor: emptyCastAnchor("Mara", "female"),
        },
      ],
    };
    const seeded = withSheet(memory, withSheet(card, base), { fillOnly: true });
    expect(seeded.entries.map((entry) => entry.id)).toEqual([
      ...base.entries.map((entry) => entry.id),
      "card",
    ]);
    expect(withSheet(memory, seeded, { fillOnly: true })).toEqual(seeded);
    expect(withKnownIdentities(seeded, withSheet(memory, { entries: [] }))).toEqual(seeded);
  });
});
