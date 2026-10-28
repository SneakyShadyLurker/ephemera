import { describe, expect, it, vi } from "vitest";

describe("the creator session in this tab", () => {
  it("pagehide empties it, the description included", async () => {
    // The tests run without a DOM: the page's events come from a plain target.
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    try {
      const { creatorStore } = await import("./session.ts");
      creatorStore.getState().choose("subject");
      creatorStore.getState().setDescription("A placeholder lighthouse keeper");
      creatorStore.getState().setArtComposition("diptych");
      creatorStore.getState().setArtLook("film");
      // Leaving the route keeps the description for a visit to Settings.
      creatorStore.getState().returnToDescription();
      expect(creatorStore.getState().description).toBe("A placeholder lighthouse keeper");
      expect(creatorStore.getState().artComposition).toBe("diptych");
      expect(creatorStore.getState().artLook).toBe("film");

      page.dispatchEvent(new Event("pagehide"));
      expect(creatorStore.getState()).toMatchObject({
        stage: "choose",
        kind: null,
        description: "",
        card: null,
        art: null,
        artComposition: "regular",
        artLook: "auto",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
