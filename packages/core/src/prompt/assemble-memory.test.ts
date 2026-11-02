import { describe, expect, it } from "vitest";
import { plainPromptPreset } from "../../test-fixtures/preset.ts";
import { blankCard } from "../card/index.ts";
import { emptyCastAnchor, emptyCastState } from "../cast/register.ts";
import type { ChatTurn } from "../chat.ts";
import { MEMORY_LIMITS } from "../memory/limits.ts";
import { emptyNotebook, type StoredEpisode } from "../memory/memory.ts";
import {
  CONTINUED_SCENE,
  fillUserPlaceholder,
  memoryStoryText,
  NEW_SCENE,
} from "../memory/prompt.ts";
import { estimateTokens } from "../tokens.ts";
import { type AssemblyInput, assemblePrompt, flatten } from "./assemble.ts";
import { promptSourceSchema } from "./inspect.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const episode = (seq: number, overrides: Partial<StoredEpisode> = {}): StoredEpisode => ({
  id: id(seq),
  characterId: id(999),
  seq,
  kind: "episode",
  title: `Scene ${seq}`,
  summary: `Summary ${seq}.`,
  cues: [],
  pinned: false,
  turns: 4,
  chapterId: null,
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const history: ChatTurn[] = [
  { role: "assistant", content: "Welcome aboard." },
  { role: "user", content: "Is the {{char}} key safe?" },
  { role: "assistant", content: "Sit." },
  { role: "user", content: "Show me the brass key." },
  { role: "assistant", content: "Here." },
  { role: "user", content: "Thanks." },
];

function input(memory?: NonNullable<AssemblyInput["memory"]>): AssemblyInput {
  return {
    preset: plainPromptPreset(),
    character: blankCard("Mara Voss"),
    persona: { name: "Aria", description: "" },
    history,
    clock: { now: 0, timeZone: "UTC" },
    pickSeed: 0,
    random: () => 0,
    ...(memory === undefined ? {} : { memory }),
  };
}

const notebook = {
  situation: "They hide in the hold, {{user}} keeps watch.",
  relationships: ["Mara Voss and {{ User }}: partners since the vault, wary of each other."],
  facts: ["The {{char}} key opens the vault."],
  threads: [],
  cast: [],
};
const memory = (overrides: Partial<NonNullable<AssemblyInput["memory"]>> = {}) => ({
  notebook,
  recap: [episode(1), episode(2)],
  candidates: [episode(3, { cues: ["brass key"] }), episode(4, { cues: ["lantern"] })],
  count: estimateTokens,
  window: 100_000,
  ...overrides,
});

describe("memory in assembly", () => {
  it("puts the story block right before the history, filling in only the persona's name", () => {
    const assembly = assemblePrompt(input(memory()));
    const messages = flatten(assembly);
    const at = messages.findIndex((message) => message.source.kind === "memory");
    const story = messages[at];
    expect(story?.role).toBe("system");
    expect(story?.content).toBe(
      [
        "The story so far",
        "Where things stand\nThey hide in the hold, Aria keeps watch.",
        "Relationships\n- Mara Voss and Aria: partners since the vault, wary of each other.",
        "What holds true\n- The {{char}} key opens the vault.",
        "Earlier in this chat\nScene 1. Summary 1.\n\nScene 2. Summary 2.",
      ].join("\n\n"),
    );
    expect(messages[at + 1]?.source.kind).toBe("history");
    expect(messages.slice(0, at).some((message) => message.source.kind === "history")).toBe(false);
    expect(assembly.memory).toEqual({ recap: [id(1), id(2)], before: [], recalled: [id(3)] });
    expect(story?.source).toEqual({
      kind: "memory",
      part: "story",
      notebook: true,
      episodes: 2,
    });
    for (const message of messages) expect(promptSourceSchema.parse(message.source)).toBeTruthy();
  });

  it("recalls matching episodes at depth 4 in the chat", () => {
    const messages = flatten(
      assemblePrompt(
        input(
          memory({
            candidates: [
              episode(3, { summary: "{{user}} finds the key.", cues: ["brass key"] }),
              episode(4, { cues: ["lantern"] }),
            ],
          }),
        ),
      ),
    );
    const at = messages.findIndex(
      (message) => message.source.kind === "memory" && message.source.part === "recalled",
    );
    expect(messages[at]?.content).toBe("Recalled from earlier\nScene 3. Aria finds the key.");
    // A user message, so a proxy cannot hoist it into the system prompt.
    expect(messages[at]?.role).toBe("user");
    expect(messages[at]?.source).toEqual({
      kind: "memory",
      part: "recalled",
      episodes: 1,
      depth: 4,
    });
    const after = messages.slice(at + 1).filter((message) => message.source.kind === "history");
    expect(after).toHaveLength(4);
  });

  it("recalls by a cue that names the persona by its placeholder", () => {
    const assembly = assemblePrompt({
      ...input(
        memory({
          recap: [],
          candidates: [episode(3, { cues: ["{{user}}'s compass"] }), episode(4)],
        }),
      ),
      history: [...history, { role: "user", content: "Where is Aria's compass?" }],
    });
    expect(assembly.memory?.recalled).toEqual([id(3)]);
    // A generated reply keeps its macros until sent, and matches the same cue.
    const generated = assemblePrompt({
      ...input(
        memory({
          recap: [],
          candidates: [episode(3, { cues: ["{{user}}'s compass"] }), episode(4)],
        }),
      ),
      history: [
        ...history,
        { role: "assistant", content: "{{user}}'s compass spins.", macroEligible: true },
      ],
    });
    expect(generated.memory?.recalled).toEqual([id(3)]);
  });

  it("puts the recalled block right after the story block when the preset sends no history", () => {
    const preset = plainPromptPreset();
    const withoutHistory = {
      ...input(memory()),
      preset: { ...preset, blocks: preset.blocks.filter((block) => block.kind !== "chatHistory") },
    };
    const messages = flatten(assemblePrompt(withoutHistory));
    const at = messages.findIndex((message) => message.source.kind === "memory");
    expect(messages[at]?.source).toMatchObject({ kind: "memory", part: "story" });
    expect(messages[at + 1]).toMatchObject({
      role: "user",
      content: "Recalled from earlier\nScene 3. Summary 3.",
      source: { kind: "memory", part: "recalled", episodes: 1 },
    });
    expect(messages.some((message) => message.source.kind === "history")).toBe(false);
  });

  it("puts the cast's state after the recalled block when the preset sends no history", () => {
    const preset = plainPromptPreset();
    const messages = flatten(
      assemblePrompt({
        ...input(memory()),
        preset: {
          ...preset,
          blocks: preset.blocks.filter((block) => block.kind !== "chatHistory"),
        },
        cast: {
          entries: [
            {
              id: id(9),
              role: "minor",
              anchor: emptyCastAnchor("Ilse Brandt", "female"),
              aka: [],
              state: emptyCastState(true),
            },
          ],
        },
      }),
    );
    const at = messages.findIndex((message) => message.source.kind === "memory");
    expect(messages.slice(at, at + 3).map((message) => message.source.kind)).toEqual([
      "memory",
      "memory",
      "castState",
    ]);
    expect(messages[at + 2]?.content).toBe("[Cast now:\nIlse Brandt: present]");
  });

  it("keeps recall within the memory's share of the window", () => {
    const window = 2_000;
    const big = "x".repeat(400);
    const candidates = [
      episode(3, { cues: ["brass key", "key"], summary: big }),
      episode(4, { cues: ["key"], summary: big }),
    ];
    const assembly = assemblePrompt(input(memory({ candidates, window })));
    expect(assembly.memory?.recalled).toEqual([id(3)]);
    const tight = assemblePrompt(input(memory({ candidates, window: 300 })));
    expect(tight.memory?.recalled).toEqual([]);
    expect(flatten(tight).some((message) => message.source.kind === "memory")).toBe(true);
  });

  it("fits the recap newest first and lets older episodes left out be recalled", () => {
    const old = episode(1, { cues: ["brass key"] });
    const oversized = episode(5, { summary: "y".repeat(1_600) });
    const assembly = assemblePrompt(
      input(
        memory({
          notebook: emptyNotebook(),
          recap: [old, oversized, episode(2)],
          candidates: [],
          window: 3_000,
        }),
      ),
    );
    expect(assembly.memory).toEqual({ recap: [id(2)], before: [], recalled: [id(1)] });
    const story = flatten(assembly).find(
      (message) => message.source.kind === "memory" && message.source.part === "story",
    );
    expect(story?.content).toBe("The story so far\n\nEarlier in this chat\nScene 2. Summary 2.");
    expect(story?.source).toEqual({
      kind: "memory",
      part: "story",
      notebook: false,
      episodes: 1,
    });
  });

  it("recalls nothing with recall off, a recap episode left out included", () => {
    const old = episode(1, { cues: ["brass key"] });
    const oversized = episode(5, { summary: "y".repeat(1_600) });
    const assembly = assemblePrompt(
      input(
        memory({
          notebook: emptyNotebook(),
          recap: [old, oversized, episode(2)],
          candidates: [],
          window: 3_000,
          recall: false,
        }),
      ),
    );
    expect(assembly.memory).toEqual({ recap: [id(2)], before: [], recalled: [] });
    expect(
      flatten(assembly).some(
        (message) => message.source.kind === "memory" && message.source.part === "recalled",
      ),
    ).toBe(false);
  });

  it("recalls every pinned memory while it fits, beside the most others allowed", () => {
    const pins = Array.from({ length: 5 }, (_, i) => episode(10 + i, { pinned: true }));
    const others = Array.from({ length: 6 }, (_, i) => episode(20 + i, { cues: ["brass key"] }));
    const assembly = assemblePrompt(input(memory({ recap: [], candidates: [...pins, ...others] })));
    // In story order: the pins (seq 10 to 14) before the others (seq 20 on).
    const recalled = assembly.memory?.recalled ?? [];
    expect(recalled.slice(0, 5)).toEqual(pins.map((pin) => pin.id));
    expect(recalled.slice(5)).toHaveLength(MEMORY_LIMITS.recall.max);
  });

  it("skips a candidate too large for the room left, not ending the scan", () => {
    const window = 2_000;
    const big = "x".repeat(1_200);
    // The large pin leads (newest), and the large other ranks first among the rest (two cues).
    const candidates = [
      episode(3, { cues: ["brass key", "key"], summary: big }),
      episode(4, { cues: ["key"] }),
      episode(5, { pinned: true }),
      episode(6, { pinned: true, summary: big }),
    ];
    const assembly = assemblePrompt(input(memory({ recap: [], candidates, window })));
    expect(assembly.memory?.recalled).toEqual([id(4), id(5)]);
  });

  it("recalls a smaller candidate past the first four when those do not fit", () => {
    const big = "x".repeat(1_200);
    const candidates = [
      ...Array.from({ length: MEMORY_LIMITS.recall.max }, (_, i) =>
        episode(10 + i, { cues: ["brass key", "key"], summary: big }),
      ),
      episode(3, { cues: ["key"] }),
    ];
    const assembly = assemblePrompt(input(memory({ recap: [], candidates, window: 2_000 })));
    expect(assembly.memory?.recalled).toEqual([id(3)]);
  });

  it("keeps the newest recap episodes that fit, exactly at the budget's edge", () => {
    const recap = [40, 7, 300, 12, 90, 3].map((size, i) =>
      episode(i + 1, { summary: "z".repeat(size) }),
    );
    const length = (text: string) => text.length;
    // Measured as sent: the persona's name in place of its placeholder.
    const storyLength = (kept: number) =>
      fillUserPlaceholder(
        memoryStoryText(notebook, { recap: recap.slice(recap.length - kept) }),
        "Aria",
      ).length;
    /** A window whose memory share is exactly `limit` by `length`. */
    const windowFor = (limit: number) => {
      let window = Math.ceil(limit / MEMORY_LIMITS.share);
      while (Math.floor(MEMORY_LIMITS.share * window) < limit) window += 1;
      while (Math.floor(MEMORY_LIMITS.share * window) > limit) window -= 1;
      expect(Math.floor(MEMORY_LIMITS.share * window)).toBe(limit);
      return window;
    };
    for (let kept = 1; kept <= recap.length; kept += 1) {
      for (const [limit, expected] of [
        [storyLength(kept), kept],
        [storyLength(kept) - 1, kept - 1],
      ] as const) {
        const assembly = assemblePrompt(
          input(memory({ recap, candidates: [], count: length, window: windowFor(limit) })),
        );
        expect(assembly.memory?.recap).toEqual(
          recap.slice(recap.length - expected).map((episode) => episode.id),
        );
      }
    }
  });

  it("leaves memory out without input or content", () => {
    const without = assemblePrompt(input());
    expect(without.memory).toBeUndefined();
    expect(flatten(without).some((message) => message.source.kind === "memory")).toBe(false);
    const empty = assemblePrompt(
      input(memory({ notebook: emptyNotebook(), recap: [], candidates: [] })),
    );
    expect(empty.memory).toEqual({ recap: [], before: [], recalled: [] });
    expect(flatten(empty).some((message) => message.source.kind === "memory")).toBe(false);
  });

  it("tells a chat opened on the memory's opening that it continues, with nothing else to tell", () => {
    const assembly = assemblePrompt(
      input(
        memory({
          notebook: emptyNotebook(),
          recap: [],
          candidates: [],
          fresh: true,
          continued: true,
        }),
      ),
    );
    const story = flatten(assembly).find(
      (message) => message.source.kind === "memory" && message.source.part === "story",
    );
    expect(story?.content).toBe(`The story so far\n${CONTINUED_SCENE}`);
    expect(story?.source).toEqual({ kind: "memory", part: "story", notebook: false, episodes: 0 });
  });

  it("frames a chat with no memory of its own as a new scene after the story before it", () => {
    // A chapter written last (seq 9) holds scenes 1 and 2: it tells the story's start.
    const chapter = episode(9, { kind: "chapter", title: "The vault" });
    const book = [
      episode(1, { chapterId: chapter.id }),
      episode(2, { chapterId: chapter.id }),
      episode(5),
    ];
    const assembly = assemblePrompt(
      input(
        memory({
          recap: [],
          before: [episode(5), chapter],
          fresh: true,
          candidates: book.slice(0, 2),
        }),
      ),
    );
    const story = flatten(assembly).find(
      (message) => message.source.kind === "memory" && message.source.part === "story",
    );
    expect(story?.content).toBe(
      [
        `The story so far\n${NEW_SCENE}`,
        "Where the last scene ended\nThey hide in the hold, Aria keeps watch.",
        "Relationships\n- Mara Voss and Aria: partners since the vault, wary of each other.",
        "What holds true\n- The {{char}} key opens the vault.",
        "Before this chat\nThe vault. Summary 9.\n\nScene 5. Summary 5.",
      ].join("\n\n"),
    );
    // Told before this chat, never as this chat's own.
    expect(assembly.memory).toEqual({ recap: [], before: [chapter.id, id(5)], recalled: [] });
    expect(story?.source).toEqual({
      kind: "memory",
      part: "story",
      notebook: true,
      episodes: 2,
    });
  });

  it("tells the story before a chat that remembers, after its own and fitted after them", () => {
    const own = [episode(7), episode(8)];
    const before = [episode(5), episode(6)];
    const told = assemblePrompt(input(memory({ recap: own, before, candidates: [] })));
    const story = flatten(told).find(
      (message) => message.source.kind === "memory" && message.source.part === "story",
    );
    expect(story?.content).not.toContain(NEW_SCENE);
    expect(story?.content).toContain("Where things stand\n");
    expect(story?.content).toContain(
      "Before this chat\nScene 5. Summary 5.\n\nScene 6. Summary 6.\n\nEarlier in this chat\nScene 7. Summary 7.\n\nScene 8. Summary 8.",
    );
    expect(told.memory).toEqual({
      recap: [id(7), id(8)],
      before: [id(5), id(6)],
      recalled: [],
    });
    // Room for the chat's own and one more: the newest before it, the older left to recall.
    const room = (kept: StoredEpisode[]) =>
      estimateTokens(
        memoryStoryText(emptyNotebook(), {
          recap: own,
          before: kept,
        }),
      );
    const window = Math.ceil((room(before.slice(1)) + 1) / MEMORY_LIMITS.share);
    expect(room(before)).toBeGreaterThan(Math.floor(MEMORY_LIMITS.share * window));
    const tight = assemblePrompt(
      input(memory({ notebook: emptyNotebook(), recap: own, before, candidates: [], window })),
    );
    expect(tight.memory?.recap).toEqual([id(7), id(8)]);
    expect(tight.memory?.before).toEqual([id(6)]);
  });

  it("lets the story before this chat that does not fit be recalled", () => {
    const old = episode(1, { cues: ["brass key"] });
    const oversized = episode(5, { summary: "y".repeat(1_600) });
    const assembly = assemblePrompt(
      input(
        memory({
          notebook: emptyNotebook(),
          recap: [],
          before: [old, oversized, episode(6)],
          candidates: [],
          window: 3_000,
        }),
      ),
    );
    expect(assembly.memory).toEqual({ recap: [], before: [id(6)], recalled: [id(1)] });
  });

  it("tells recalled memories in story order, a chapter by the earliest scene it holds", () => {
    const chapter = episode(9, { kind: "chapter", title: "The vault", cues: ["brass key"] });
    const candidates = [
      episode(1, { chapterId: chapter.id }),
      episode(2, { chapterId: chapter.id }),
      episode(5, { cues: ["brass key", "key"] }),
      chapter,
    ];
    const assembly = assemblePrompt(input(memory({ recap: [], candidates })));
    // Ranked first, scene 5 still follows the chapter that tells scenes 1 and 2.
    expect(assembly.memory?.recalled).toEqual([chapter.id, id(5)]);
    const recalled = flatten(assembly).find(
      (message) => message.source.kind === "memory" && message.source.part === "recalled",
    );
    expect(recalled?.content).toBe(
      "Recalled from earlier\nThe vault. Summary 9.\n\nScene 5. Summary 5.",
    );
  });
});
