import type { InspectedPrompt } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { promptParts } from "./prompt-parts.ts";

type Message = InspectedPrompt["messages"][number];

const message = (
  role: Message["role"],
  source: Message["source"],
  tokens: number,
  merged?: Message["source"][],
): Message => ({ role, content: "…", tokens, source, ...(merged ? { merged } : {}) });

const main = message("system", { kind: "block", id: "main" }, 100);
const post = message("system", { kind: "block", id: "postHistory" }, 10);
const turn = (index: number, tokens = 20) =>
  message(index % 2 === 0 ? "user" : "assistant", { kind: "history", index }, tokens);

describe("promptParts", () => {
  it("splits blocks, chat and draft for an unprocessed prompt", () => {
    const parts = promptParts([main, turn(0), turn(1), turn(2, 7), post], 2);
    expect(parts).toMatchObject({ blocks: 110, draft: 7, turns: 2, hasDraft: true });
    expect(parts.band).toHaveLength(3);
  });

  it("shows a Continue's reply after the post-history instructions, still counted as chat", () => {
    const nudge = message("system", { kind: "instruction", id: "continue" }, 5);
    const parts = promptParts([main, turn(0), turn(1), post, turn(2, 7), nudge], null);
    expect(parts.band).toEqual([turn(0), turn(1)]);
    expect(parts.after).toEqual([post, turn(2, 7), nudge]);
    expect(parts).toMatchObject({ blocks: 115, draft: 0, turns: 3 });
  });

  it("keeps a chat turn merged into a block in the chat, and counts its turns (semi-strict)", () => {
    const note = { kind: "authorsNote", depth: 1 } as const;
    const merged = message("user", note, 40, [{ kind: "history", index: 2 }, post.source]);
    const parts = promptParts([main, turn(0), turn(1), merged], 2);
    expect(parts.after).toEqual([]);
    expect(parts).toMatchObject({ blocks: 100, draft: 0, turns: 2, hasDraft: true });
  });

  it("counts every turn of a single user message as chat history", () => {
    const single = message("user", main.source, 200, [
      { kind: "history", index: 0 },
      { kind: "history", index: 1 },
      { kind: "history", index: 2 },
      post.source,
    ]);
    const parts = promptParts([single], null);
    expect(parts.band).toEqual([single]);
    expect(parts).toMatchObject({ blocks: 0, draft: 0, turns: 3, hasDraft: false });
  });
  it("keeps recalled memories and the cast state in the chat band", () => {
    const recalled = message(
      "system",
      { kind: "memory", part: "recalled", episodes: 2, depth: 4 },
      30,
    );
    const cast = message("system", { kind: "castState", depth: 1 }, 15);
    const parts = promptParts(
      [main, turn(0), recalled, turn(1), turn(2), turn(3), cast, turn(4), post],
      null,
    );
    expect(parts.band).toEqual([turn(0), recalled, turn(1), turn(2), turn(3), cast, turn(4)]);
    expect(parts).toMatchObject({ blocks: 110, turns: 5 });
  });
});

describe("lorebook entries placed in the chat", () => {
  it("counts depth and in-chat Author's Note entries inside the chat band", () => {
    const depth = message(
      "system",
      { kind: "lorebook", position: "depth", depth: 1, role: "system", entries: 2 },
      30,
    );
    const note = message("system", { kind: "authorsNote", depth: 1 }, 20, [
      { kind: "lorebook", position: "authorsNote", depth: 1, entries: 1 },
    ]);
    const parts = promptParts([main, turn(0), depth, note, turn(1), post], null);
    expect(parts.band).toEqual([turn(0), depth, note, turn(1)]);
    expect(parts.blocks).toBe(110);
    expect(parts).toMatchObject({ turns: 2, lorebookBlocks: 2 });
  });

  it("counts a lorebook block merged into a chat turn once, and none outside the chat", () => {
    const before = message("system", { kind: "lorebook", position: "before", entries: 3 }, 30);
    const merged = message("user", { kind: "history", index: 0 }, 50, [
      { kind: "lorebook", position: "depth", depth: 0, role: "user", entries: 1 },
    ]);
    const note = message("system", { kind: "authorsNote", depth: null }, 20, [
      { kind: "lorebook", position: "authorsNote", depth: null, entries: 1 },
    ]);
    const parts = promptParts([main, before, note, merged, turn(1), post], null);
    expect(parts.band).toEqual([merged, turn(1)]);
    expect(parts).toMatchObject({ turns: 2, lorebookBlocks: 1 });
  });
});
