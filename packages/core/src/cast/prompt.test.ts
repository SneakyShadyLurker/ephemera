import { describe, expect, it } from "vitest";
import { blankCard } from "../card/index.ts";
import {
  castCanon,
  KEEPER_OPENING,
  keeperInstructions,
  keeperMessage,
  SHEET_OPENING,
  sheetInstructions,
  sheetMessage,
} from "./prompt.ts";
import { emptyCastAnchor, emptyCastState } from "./register.ts";

const names = { char: "Mara", user: "Ash" };
const register = {
  entries: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      role: "principal" as const,
      anchor: { ...emptyCastAnchor("Mara Battin", "female"), age: "18" },
      aka: [],
      state: { ...emptyCastState(true), mood: "nervous" },
    },
  ],
};
const turns = [
  { role: "assistant" as const, content: "Mara waits at the stop." },
  { role: "user" as const, content: "I sit beside her." },
];

const message = (canon: string | null, full = false) =>
  keeperMessage({ canon, names, register, turns, mode: "update", full });

describe("the keeper prompt", () => {
  it("keeps the instructions identical across calls, opening with KEEPER_OPENING", () => {
    expect(keeperInstructions()).toBe(keeperInstructions());
    expect(keeperInstructions().startsWith(KEEPER_OPENING)).toBe(true);
  });

  it("asks for every garment worn and the state the clothes are in", () => {
    const instructions = keeperInstructions();
    expect(instructions).toMatch(/- "outfit": every garment they have on now/);
    expect(instructions).toMatch(/- "disarray": the state of their clothes/);
    expect(instructions.indexOf('"outfit"')).toBeLessThan(instructions.indexOf('"disarray"'));
  });

  it("orders canon, player, register and turns, then the task", () => {
    const text = message("Description:\nMara keeps the light.");
    const at = ["<canon>", "<player>", "<register>", "<turn>", "Answer with what changed."].map(
      (part) => text.indexOf(part),
    );
    expect(at.every((index) => index !== -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("The player is Ash: never an entry.");
    expect(text).toContain("Mara: Mara waits at the stop.\nAsh: I sit beside her.");
    expect(text).toContain('"name":"Mara Battin"');
    expect(text).not.toContain("00000000-0000");
    expect(text).not.toContain("The register is full");
  });

  it("leaves canon out when there is none, and says when the register is full", () => {
    const text = message(null, true);
    expect(text).not.toContain("<canon>");
    expect(text.startsWith("<player>")).toBe(true);
    expect(text).toContain("The register is full: add no one; update and mark absent only.");
  });

  it("asks a seed call to set who is present", () => {
    expect(
      keeperMessage({ canon: null, names, register, turns, mode: "seed", full: false }),
    ).toContain("This is the opening.");
  });

  it("builds canon from the card's fields with the names filled, null when blank", () => {
    const card = { ...blankCard("Mara"), description: "{{char}} meets {{user}}." };
    expect(castCanon(card, names)).toBe("Description:\nMara meets Ash.");
    expect(castCanon(blankCard("Mara"), names)).toBeNull();
  });
});

describe("the sheet prompt", () => {
  it("keeps the instructions identical across calls, opening with SHEET_OPENING", () => {
    expect(sheetInstructions()).toBe(sheetInstructions());
    expect(sheetInstructions().startsWith(SHEET_OPENING)).toBe(true);
  });

  it("names the card's kind, or none, and keeps {{user}} as written", () => {
    const card = { ...blankCard("Mara"), description: "{{char}} waits for {{user}}." };
    expect(sheetMessage({ ...card, tags: ["Multiple Subjects"] })).toContain(
      "Kind: Multiple Subjects",
    );
    const untagged = sheetMessage({ ...card, tags: ["romance"] });
    expect(untagged).toContain("Kind: none");
    expect(untagged).toContain("Mara waits for {{user}}.");
  });
});
