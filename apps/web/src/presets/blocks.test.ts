import {
  isPlaceable,
  PRESET_LIMITS,
  type PromptBlock,
  promptPresetFileSchema,
} from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { plainPromptPreset } from "../../../../packages/core/test-fixtures/preset.ts";
import {
  addOptional,
  BLOCK_SOURCE,
  blockName,
  inChat,
  insertCustom,
  missingOptional,
  moveBefore,
  moveInOrder,
  removeBlock,
  restoreBlock,
  runningOrder,
  setOrder,
  setPlace,
  setTriggers,
  shiftDepth,
} from "./blocks.ts";

const custom = (id: string, depth: number | null = null): PromptBlock => ({
  kind: "custom",
  id,
  name: id,
  role: "system",
  content: "",
  enabled: true,
  depth,
});

const ids = (blocks: PromptBlock[]) => blocks.map((block) => block.id);
const base = () => plainPromptPreset().blocks;

describe("prompt block rules", () => {
  it("splits the running order from in-chat blocks, deepest first, ties in list order", () => {
    const blocks = [...base(), custom("a", 0), custom("b", 4), custom("c", 4), custom("d")];
    expect(ids(runningOrder(blocks))).not.toContain("a");
    expect(ids(runningOrder(blocks)).at(-1)).toBe("d");
    expect(ids(inChat(blocks))).toEqual(["b", "c", "a"]);
  });

  it("lists in-chat blocks in sending order: lower order, then assistant, user, system", () => {
    const at = (id: string, role: "system" | "user" | "assistant", order?: number) => ({
      ...custom(id, 2),
      role,
      ...(order === undefined ? {} : { order }),
    });
    // An imported order of 200 goes after a new block's default order at the same depth.
    const blocks = [...base(), at("imported", "system", 200), at("new", "system"), at("u", "user")];
    expect(ids(inChat(blocks))).toEqual(["u", "new", "imported"]);
  });

  it("moves a block one place in the running order, stopping at the ends", () => {
    const blocks = base();
    expect(ids(moveInOrder(blocks, "lorebookBefore", -1)).slice(0, 2)).toEqual([
      "lorebookBefore",
      "main",
    ]);
    expect(moveInOrder(blocks, "main", -1)).toBe(blocks);
    expect(moveInOrder(blocks, "postHistory", 1)).toBe(blocks);
  });

  it("moves a block before a named one", () => {
    const moved = moveBefore(base(), "postHistory", "main");
    expect(ids(runningOrder(moved))[0]).toBe("postHistory");
  });

  it("places a block inside the chat at the default depth, and back above the chat history", () => {
    const blocks = [...base(), custom("x")];
    const inside = setPlace(blocks, "x", PRESET_LIMITS.defaultDepth);
    expect(inChat(inside).map((block) => block.id)).toEqual(["x"]);
    const back = setPlace(inside, "x", null);
    const order = ids(runningOrder(back));
    expect(order.indexOf("x")).toBe(order.indexOf("chatHistory") - 1);
  });

  it("changes depth within its range", () => {
    const blocks = [...base(), custom("x", 0)];
    expect(inChat(shiftDepth(blocks, "x", 1))[0]).toMatchObject({ depth: 1 });
    expect(inChat(shiftDepth(blocks, "x", -1))[0]).toMatchObject({ depth: 0 });
    const deep = [...base(), custom("y", PRESET_LIMITS.maxDepth)];
    expect(inChat(shiftDepth(deep, "y", 1))[0]).toMatchObject({ depth: PRESET_LIMITS.maxDepth });
  });

  it("inserts a new block after the open one, or just above the chat history", () => {
    const afterMain = insertCustom(base(), custom("n"), "main");
    expect(ids(runningOrder(afterMain)).slice(0, 2)).toEqual(["main", "n"]);
    const noneOpen = insertCustom(base(), custom("n"), null);
    const order = ids(runningOrder(noneOpen));
    expect(order.indexOf("n")).toBe(order.indexOf("chatHistory") - 1);
  });

  it("removes a custom block and restores it where it was", () => {
    const blocks = [...base().slice(0, 3), custom("x"), ...base().slice(3)];
    const { blocks: without, removed } = removeBlock(blocks, "x");
    expect(ids(without)).not.toContain("x");
    expect(ids(restoreBlock(without, removed))).toEqual(ids(blocks));
  });
});

describe("built-in block names", () => {
  it("lists the cast block as Cast, from the chat's cast register, after the scenario", () => {
    const named = runningOrder(base()).map(
      (block) => `${blockName(block)}: ${BLOCK_SOURCE[block.id as keyof typeof BLOCK_SOURCE]}`,
    );
    expect(named).toContain("Cast: From the chat's cast register");
    expect(named.indexOf("Cast: From the chat's cast register")).toBe(
      named.indexOf("Scenario: From the character") + 1,
    );
  });
});

describe("optional built-in blocks", () => {
  it("offers a missing cast block and adds it back after the scenario", () => {
    const without = base().filter((block) => block.id !== "castAnchors");
    expect(missingOptional(base())).toEqual([]);
    expect(missingOptional(without)).toEqual(["castAnchors"]);
    const added = addOptional(without, "castAnchors");
    expect(ids(added)).toEqual(ids(base()));
    expect(added.find((block) => block.id === "castAnchors")).toEqual({
      kind: "source",
      id: "castAnchors",
      enabled: true,
    });
    expect(missingOptional(added)).toEqual([]);
  });
});

describe("built-in block placement", () => {
  /** An imported preset's main prompt and description, placed inside the chat. */
  const imported = (): PromptBlock[] =>
    base().map((block): PromptBlock => {
      if (block.id === "main" && block.kind === "text") {
        const placed = { ...block };
        placed.role = "user";
        placed.depth = 2;
        placed.order = 50;
        placed.forbidOverrides = true;
        return placed;
      }
      if (block.id === "charDescription" && block.kind === "source") {
        const placed = { ...block };
        placed.role = "assistant";
        placed.depth = 2;
        placed.triggers = ["swipe"];
        return placed;
      }
      return block;
    });

  it("places the main prompt, post-history and character sources inside the chat, never lorebook or examples", () => {
    const blocks = imported();
    expect(ids(inChat(blocks))).toEqual(["main", "charDescription"]);
    expect(ids(runningOrder(blocks))).not.toContain("main");
    const lore = base().map((block) =>
      block.id === "lorebookBefore" && block.kind === "source" ? { ...block, depth: 3 } : block,
    );
    expect(ids(inChat(lore))).toEqual([]);
    expect(
      base()
        .filter(isPlaceable)
        .map((block) => block.id),
    ).toEqual([
      "main",
      "personaDescription",
      "charDescription",
      "charPersonality",
      "scenario",
      "postHistory",
    ]);
  });

  it("sorts built-ins with custom blocks by the core comparator, the default role being the system's", () => {
    const blocks = [...imported(), custom("c", 2)];
    // Order 50 first; at order 100, the assistant's description before the system's custom block.
    expect(ids(inChat(blocks))).toEqual(["main", "charDescription", "c"]);
    expect(ids(inChat(setOrder(blocks, "main", 200)))).toEqual(["charDescription", "c", "main"]);
    expect(
      inChat(setOrder(blocks, "c", 10 * PRESET_LIMITS.maxOrder)).find((b) => b.id === "c"),
    ).toMatchObject({ order: PRESET_LIMITS.maxOrder });
  });

  it("moves a built-in into the chat and back in place, keeping what it was imported with", () => {
    const blocks = base();
    const inside = setPlace(blocks, "scenario", PRESET_LIMITS.defaultDepth);
    expect(ids(inChat(inside))).toEqual(["scenario"]);
    expect(ids(inside)).toEqual(ids(blocks));
    const back = setPlace(imported(), "main", null);
    expect(ids(runningOrder(back))[0]).toBe("main");
    const [main] = base();
    if (main?.kind !== "text") throw new Error("the default preset starts with its main prompt");
    expect(back[0]).toEqual({
      kind: "text",
      id: "main",
      enabled: true,
      content: main.content,
      role: "user",
      depth: null,
      order: 50,
      forbidOverrides: true,
    });
    expect(inChat(shiftDepth(imported(), "main", 1))[0]).toMatchObject({ depth: 3, order: 50 });
  });

  it("keeps triggers in the shared generation-type order, each once, and none for every generation", () => {
    const blocks = setTriggers(imported(), "main", ["continue", "normal", "continue"]);
    expect(blocks.find((block) => block.id === "main")).toMatchObject({
      triggers: ["normal", "continue"],
    });
    const cleared = setTriggers(blocks, "main", []);
    expect(cleared.find((block) => block.id === "main")).toMatchObject({ triggers: [] });
    expect(setTriggers(base(), "chatHistory", ["normal"])).toEqual(base());
  });

  it("keeps in-chat built-ins at their stored places through moves and inserts, and returns them there", () => {
    // As imported: the main prompt inside the chat at the first slot, a note after it, the
    // character description and the post-history instructions inside the chat too.
    const blocks = base().flatMap((block): PromptBlock[] => {
      if (block.kind === "text" && block.id === "main") {
        return [{ ...block, depth: 2 }, custom("note")];
      }
      if (isPlaceable(block) && (block.id === "charDescription" || block.id === "postHistory")) {
        return [{ ...block, depth: 1 }];
      }
      return [block];
    });
    const stored = ids(blocks);
    let edited = moveInOrder(blocks, "scenario", -1);
    edited = moveBefore(edited, "lorebookAfter", "lorebookBefore");
    edited = insertCustom(edited, custom("added"), null);
    edited = insertCustom(edited, custom("afterNote"), "note");
    // Unrelated edits leave every in-chat block where it was stored.
    expect(ids(edited).indexOf("main")).toBe(0);
    expect(ids(edited).indexOf("note")).toBe(1);
    expect(ids(inChat(edited))).toEqual(["main", "charDescription", "postHistory"]);
    let back = edited;
    for (const id of ["main", "charDescription", "postHistory"]) back = setPlace(back, id, null);
    expect(ids(runningOrder(back))).toEqual([
      "main",
      "note",
      "afterNote",
      "lorebookAfter",
      "lorebookBefore",
      "personaDescription",
      "charDescription",
      "scenario",
      "charPersonality",
      "castAnchors",
      "dialogueExamples",
      "added",
      "chatHistory",
      "postHistory",
    ]);
    // An in-chat block has no place in the order to move from: the stored list stays.
    expect(ids(moveInOrder(blocks, "main", 1))).toEqual(stored);
    const exported = promptPresetFileSchema.parse({
      format: "ephemera.prompt-preset",
      version: 1,
      data: {
        ...plainPromptPreset(),
        blocks: back.map((block) =>
          block.kind === "custom" ? { ...block, id: crypto.randomUUID() } : block,
        ),
      },
    });
    expect(exported.data.blocks.map(blockName)).toEqual(back.map(blockName));
  });

  it("custom block operations keep an imported order and triggers", () => {
    const x: PromptBlock = {
      kind: "custom",
      id: "x",
      name: "x",
      role: "system",
      content: "",
      enabled: true,
      depth: 1,
      order: 7,
      triggers: ["impersonate"],
    };
    const blocks = [...base(), x];
    const moved = shiftDepth(setPlace(blocks, "x", null), "x", 1);
    expect(moved.find((block) => block.id === "x")).toMatchObject({
      depth: null,
      order: 7,
      triggers: ["impersonate"],
    });
  });
});
