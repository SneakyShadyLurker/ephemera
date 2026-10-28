import type { ModelInfo } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { portraitDefault } from "./portrait-switch.ts";

const model = (images: boolean | null): ModelInfo => ({
  id: "m",
  contextWindow: 1000,
  reasoning: null,
  images,
});

describe("portraitDefault", () => {
  it("turns the switch on for a model that reads images", () => {
    expect(portraitDefault(model(true), true)).toEqual({
      shown: true,
      enabled: true,
      on: true,
      description: "Reads the portrait to check appearance",
    });
  });

  it("leaves it off but available when the catalog does not say", () => {
    for (const info of [model(null), undefined]) {
      expect(portraitDefault(info, true)).toEqual({
        shown: true,
        enabled: true,
        on: false,
        description: "Not reported for this model; try it",
      });
    }
  });

  it("disables it for a model that reads text only", () => {
    expect(portraitDefault(model(false), true)).toEqual({
      shown: true,
      enabled: false,
      on: false,
      description: "This model reads text only",
    });
  });

  it("hides the row when the card has no portrait", () => {
    expect(portraitDefault(model(true), false).shown).toBe(false);
  });
});
