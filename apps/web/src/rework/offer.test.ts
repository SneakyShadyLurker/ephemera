import { CARD_LIMITS } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { fitsRework, legacyBlockLabels, OFFER_REQUEST, offerText, prefillOffer } from "./offer.ts";
import { createReworkStore } from "./store.ts";

describe("the sheet's Rework offer", () => {
  it("labels the blocks found in description order, each once", () => {
    expect(legacyBlockLabels(["instructions", "scenario", "example_dialogue"])).toEqual([
      "Instructions",
      "Scenario",
      "Example dialogue",
    ]);
    expect(legacyBlockLabels(["personality", "scenario", "personality"])).toEqual([
      "Personality",
      "Scenario",
    ]);
    expect(legacyBlockLabels([])).toEqual([]);
  });

  it("names the blocks with commas and 'and', in the singular for one", () => {
    expect(offerText(["Scenario", "Personality", "Instructions"])).toBe(
      "Scenario, Personality and Instructions blocks were folded in from an older card format. Rework can rewrite them into the card's layout.",
    );
    expect(offerText(["Example dialogue"])).toBe(
      "The Example dialogue block was folded in from an older card format. Rework can rewrite it into the card's layout.",
    );
  });

  it("asks Rework to convert the folded blocks and remove them from the description", () => {
    expect(OFFER_REQUEST).toBe(
      "Convert the folded <scenario>, <personality>, <example_dialogue> and <instructions> blocks at the end of the description into the card's layout, and remove them from the description.",
    );
  });

  it("fits a description Rework accepts, up to the text limit in code points", () => {
    expect(fitsRework("x".repeat(CARD_LIMITS.textLength))).toBe(true);
    expect(fitsRework("x".repeat(CARD_LIMITS.textLength + 1))).toBe(false);
    // An emoji is two UTF-16 units but one code point, as the request schema counts it.
    expect(fitsRework("😀".repeat(CARD_LIMITS.textLength))).toBe(true);
  });

  it("prefills an empty request and keeps one the owner typed", () => {
    const store = createReworkStore({ streamRework: async () => (async function* () {})() });
    store.getState().setRequest("  \n");
    prefillOffer(store.getState());
    expect(store.getState().request).toBe(OFFER_REQUEST);

    store.getState().setRequest("Make her older.");
    prefillOffer(store.getState());
    expect(store.getState().request).toBe("Make her older.");
  });
});
