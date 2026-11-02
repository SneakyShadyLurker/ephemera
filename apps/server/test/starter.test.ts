import { describe, expect, it } from "vitest";
import { loadStarterCharacter } from "../src/starter.ts";

describe("starter character", () => {
  it("reads the bundled card with its portrait", async () => {
    const { card, portrait } = await loadStarterCharacter();
    expect(card.name).toBe("Friday Abbams");
    expect(card.firstMessage).toContain("{{char}}");
    expect(portrait).toMatchObject({ width: 1024, height: 1536 });
  });
});
