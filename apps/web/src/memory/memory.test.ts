import {
  DEFAULT_SETTINGS,
  episodeFieldsSchema,
  MEMORY_LIMITS,
  type MemoryState,
  type StoredEpisode,
} from "@ephemera/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatMemory,
  type ChatMessage,
  type ChatState,
  createChatStore,
  NO_MEMORY,
} from "../chat/store.ts";
import {
  bookRows,
  cueProblem,
  episodeOverLimit,
  type OpeningWrite,
  openingRequestFor,
  openingWriteAfter,
  regenerateReason,
  rememberNowHeld,
  rowAfterDelete,
  setMemoryOn,
} from "./memory.ts";
import { focusAfterRemoval, saveNotebook } from "./Notebook.tsx";
import { MEMORY_KEY, saveMemoryState } from "./queries.ts";

vi.mock("./queries.ts", async (original) => ({
  ...(await original<typeof import("./queries.ts")>()),
  saveMemoryState: vi.fn(),
  refreshMemory: vi.fn(async () => {}),
}));

const CHARACTER = "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";
const STATE: MemoryState = {
  enabled: true,
  notebook: { situation: "", relationships: [], facts: [], threads: [], cast: [] },
  opening: "",
  revision: 3,
  updatedAt: 0,
};

afterEach(() => vi.mocked(saveMemoryState).mockReset());

describe("the memory switch", () => {
  it("turns memory on with a first save, and the cache follows", async () => {
    vi.mocked(saveMemoryState).mockResolvedValue({ ok: true, saved: { ...STATE, revision: 0 } });
    const client = new QueryClient();
    const result = await setMemoryOn(client, CHARACTER, true, null);
    expect(result.ok).toBe(true);
    expect(saveMemoryState).toHaveBeenCalledWith(CHARACTER, { enabled: true }, 0);
    expect(client.getQueryData(MEMORY_KEY(CHARACTER))).toEqual({
      state: { ...STATE, revision: 0 },
      episodes: [],
    });
  });

  it("says off again against the revision another tab left", async () => {
    vi.mocked(saveMemoryState)
      .mockResolvedValueOnce({ ok: false, reason: "conflict", revision: 5 })
      .mockResolvedValueOnce({ ok: true, saved: { ...STATE, enabled: false, revision: 6 } });
    const result = await setMemoryOn(new QueryClient(), CHARACTER, false, STATE);
    expect(result.ok).toBe(true);
    expect(vi.mocked(saveMemoryState).mock.calls).toEqual([
      [CHARACTER, { enabled: false }, 3],
      [CHARACTER, { enabled: false }, 5],
    ]);
  });
});

describe("Remember now's hold for an open message edit", () => {
  const messages = ["m0", "m1", "m2", "m3", "m4", "m5"].map(
    (id): ChatMessage => ({
      id,
      role: "user",
      text: "The quay at dusk.",
      personaId: null,
      sentAt: 0,
    }),
  );
  const base = createChatStore(
    async function* () {},
    () => ({
      model: null,
      samplerPresetId: null,
      promptPresetId: null,
      characterId: null,
      personaId: null,
      reasoning: null,
    }),
    {
      clock: () => ({ now: 0, timeZone: "UTC" }),
      fetchPreview: () => Promise.reject(new Error("No previews here")),
    },
  ).getState();
  /** The six messages with an edit of `id` open. */
  const editing = (id: string, memory: ChatMemory = NO_MEMORY): ChatState => ({
    ...base,
    messages,
    memory,
    editing: { id, text: "The quay at dawn.", target: "text" },
  });

  it("holds for an edit in the span it takes, never for one kept out of it", () => {
    // The newest four kept out: the span is the first two.
    expect(rememberNowHeld(editing("m1"), 4)).toBe(true);
    expect(rememberNowHeld(editing("m2"), 4)).toBe(false);
    expect(rememberNowHeld({ ...editing("m1"), editing: null }, 4)).toBe(false);
  });

  it("measures a lost answer's retry over its own span", () => {
    const lost: ChatMemory = {
      ...NO_MEMORY,
      status: "failed",
      failure: "unreachable",
      pending: { attempt: "a", boundary: 4, from: 0 },
    };
    expect(rememberNowHeld(editing("m3", lost), 4)).toBe(true);
    expect(rememberNowHeld(editing("m4", lost), 1)).toBe(false);
  });
});

describe("the book's rows", () => {
  const episode = (
    seq: number,
    kind: StoredEpisode["kind"] = "episode",
    chapterId: number | null = null,
  ): StoredEpisode => ({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    characterId: CHARACTER,
    seq,
    kind,
    title: `Memory ${seq}`,
    summary: "What happened.",
    cues: [],
    pinned: false,
    turns: 4,
    chapterId:
      chapterId === null ? null : `00000000-0000-4000-8000-${String(chapterId).padStart(12, "0")}`,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  it("nests a chapter a later chapter absorbed, with its own members", () => {
    // Episodes 0 and 1 make chapter 2; chapter 2 and episode 3 make chapter 5; episode 4 stands alone.
    const book = [
      episode(0, "episode", 2),
      episode(1, "episode", 2),
      episode(2, "chapter", 5),
      episode(3, "episode", 5),
      episode(4),
      episode(5, "chapter"),
    ];
    const rows = bookRows(book);
    const seqs = (list: ReturnType<typeof bookRows>): unknown[] =>
      list.map((row) =>
        row.members.length === 0 ? row.episode.seq : [row.episode.seq, seqs(row.members)],
      );
    expect(seqs(rows)).toEqual([[5, [[2, [0, 1]], 3]], 4]);
  });

  it("lets a member whose chapter is missing stand on its own", () => {
    const rows = bookRows([episode(0, "episode", 9), episode(1)]);
    expect(rows.map((row) => [row.episode.seq, row.members.length])).toEqual([
      [1, 0],
      [0, 0],
    ]);
  });
});

describe("an episode's cues", () => {
  const long = "x".repeat(MEMORY_LIMITS.cue + 1);
  const many = Array.from({ length: MEMORY_LIMITS.cues + 2 }, (_, at) => `Cue ${at}`);

  it("are a problem exactly when core would refuse them", () => {
    for (const cues of [
      [],
      ["Mira", "the quay"],
      ["x".repeat(MEMORY_LIMITS.cue)],
      many.slice(0, MEMORY_LIMITS.cues),
      [long],
      ["Mira", long, long],
      many,
      [...many, long],
    ]) {
      const refused = !episodeFieldsSchema.shape.cues.safeParse(cues).success;
      expect(cueProblem(cues) !== null, JSON.stringify(cues)).toBe(refused);
    }
  });

  it("say which cue is too long, or how many to remove", () => {
    expect(cueProblem(["Mira", long])).toBe(
      `“${long}” is over ${MEMORY_LIMITS.cue} characters, the most a cue holds.`,
    );
    expect(cueProblem([long, long])).toBe(
      `2 cues are over ${MEMORY_LIMITS.cue} characters, the most a cue holds.`,
    );
    expect(cueProblem(many)).toBe(
      `A memory keeps ${MEMORY_LIMITS.cues} cues; remove 2 to save it.`,
    );
  });
});

describe("an episode field over its limit", () => {
  it("is named with its limit in plain words", () => {
    expect(episodeOverLimit("cues", ["x".repeat(MEMORY_LIMITS.cue + 1)])).toBe(
      `a cue holds at most ${MEMORY_LIMITS.cue} characters`,
    );
    const many = Array.from({ length: MEMORY_LIMITS.cues + 1 }, (_, at) => `Cue ${at}`);
    expect(episodeOverLimit("cues", many)).toBe(
      `a memory keeps at most ${MEMORY_LIMITS.cues} cues`,
    );
    expect(episodeOverLimit("name", [])).toBe(
      `a title holds at most ${MEMORY_LIMITS.title} characters`,
    );
  });
});

describe("the notebook's save", () => {
  const SAVED = {
    notebook: {
      situation: "Mira waits on the far bank.",
      relationships: [],
      facts: ["The ferryman owes Mira a favour."],
      threads: [],
      cast: [],
    },
    opening: "> Location: The far bank, dawn\n\nMira waits by the ferry.",
  };

  it("sends the opening with the notebook whole, against the revision", async () => {
    vi.mocked(saveMemoryState).mockResolvedValue({ ok: true, saved: STATE });
    const opening = "> Location: The ferry, noon\n\nMira sits at the bow.";
    await saveNotebook(CHARACTER, SAVED, { opening }, 3);
    await saveNotebook(CHARACTER, SAVED, { name: "Mira crossed." }, 4);
    expect(vi.mocked(saveMemoryState).mock.calls).toEqual([
      [CHARACTER, { notebook: SAVED.notebook, opening }, 3],
      [
        CHARACTER,
        { notebook: { ...SAVED.notebook, situation: "Mira crossed." }, opening: SAVED.opening },
        4,
      ],
    ]);
  });

  it("saves an emptied opening as none", async () => {
    vi.mocked(saveMemoryState).mockResolvedValue({ ok: true, saved: STATE });
    await saveNotebook(CHARACTER, SAVED, { opening: "" }, 3);
    expect(saveMemoryState).toHaveBeenCalledWith(
      CHARACTER,
      { notebook: SAVED.notebook, opening: "" },
      3,
    );
  });
});

describe("focus after a notebook line is removed", () => {
  it("goes to the line taking its place, or the one before at the end", () => {
    expect(focusAfterRemoval(0, 3)).toBe(0);
    expect(focusAfterRemoval(2, 3)).toBe(1);
    // Backspace in an empty line goes to the line before it.
    expect(focusAfterRemoval(2, 3, 1)).toBe(1);
  });

  it("goes to the Add button once the last line is gone", () => {
    expect(focusAfterRemoval(0, 1)).toBeNull();
    expect(focusAfterRemoval(0, 1, 0)).toBeNull();
  });
});

describe("focus after a memory is deleted", () => {
  it("goes to the row after it, or the one before it at the end", () => {
    expect(rowAfterDelete(["a", "b", "c"], "a")).toBe("b");
    expect(rowAfterDelete(["a", "b", "c"], "b")).toBe("c");
    expect(rowAfterDelete(["a", "b", "c"], "c")).toBe("b");
  });

  it("goes to the list's heading once no row is left", () => {
    expect(rowAfterDelete(["a"], "a")).toBeNull();
    expect(rowAfterDelete([], "a")).toBeNull();
  });
});

describe("regenerating the next chat's opening", () => {
  const PERSONA = "7c3a4d5e-6f7a-4b82-9c3d-4e5f6a7b8c9d";

  it("asks with the memory model and effort, else the reply's model, and the chosen persona", () => {
    expect(openingRequestFor({ ...DEFAULT_SETTINGS, model: "reply-model" })).toEqual({
      model: "reply-model",
    });
    expect(
      openingRequestFor({
        ...DEFAULT_SETTINGS,
        model: "reply-model",
        memoryModel: "memory-model",
        memoryReasoning: "low",
        personaId: PERSONA,
      }),
    ).toEqual({ model: "memory-model", reasoning: "low", personaId: PERSONA });
    expect(openingRequestFor(DEFAULT_SETTINGS)).toBeNull();
  });

  it("says why it cannot run: memory off, nothing remembered, or no model", () => {
    const can = { name: "Mira", on: true, remembered: true, model: "m" };
    expect(regenerateReason(can)).toBeNull();
    expect(regenerateReason({ ...can, on: false })).toBe("Memory is off for Mira.");
    expect(regenerateReason({ ...can, remembered: false })).toBe(
      "Nothing is remembered yet to write it from.",
    );
    expect(regenerateReason({ ...can, model: null })).toBe(
      "Choose a model in Settings to write it.",
    );
  });

  it("offers Undo once written, until the opening is edited or written again", () => {
    const idle: OpeningWrite = { kind: "idle" };
    const writing = openingWriteAfter(idle, { type: "start" });
    expect(writing).toEqual({ kind: "writing" });
    const done = openingWriteAfter(writing, { type: "written", previous: "Before." });
    expect(done).toEqual({ kind: "done", previous: "Before." });
    expect(openingWriteAfter(done, { type: "edited" })).toEqual(idle);
    expect(openingWriteAfter(done, { type: "start" })).toEqual({ kind: "writing" });
    const failed = openingWriteAfter(writing, { type: "failed", reason: "memory_failed" });
    expect(failed).toEqual({ kind: "failed", reason: "memory_failed" });
    // An edit leaves a failure's note; Try again starts over.
    expect(openingWriteAfter(failed, { type: "edited" })).toEqual(failed);
    expect(openingWriteAfter(failed, { type: "start" })).toEqual({ kind: "writing" });
    // A write stopped (memory turning off) leaves nothing to undo and no note.
    expect(openingWriteAfter(writing, { type: "stopped" })).toEqual(idle);
    expect(openingWriteAfter(done, { type: "stopped" })).toEqual(done);
    expect(openingWriteAfter(writing, { type: "failed", reason: "unsaved" })).toEqual({
      kind: "failed",
      reason: "unsaved",
    });
    // A late answer for a write no longer running changes nothing.
    expect(openingWriteAfter(idle, { type: "written", previous: "x" })).toEqual(idle);
    expect(openingWriteAfter(done, { type: "failed", reason: "timeout" })).toEqual(done);
  });
});
