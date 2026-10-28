import type { ModelInfo } from "@ephemera/core";

/** How the composer's "Include portrait" row shows for a model. */
interface PortraitSwitch {
  /** The card has a portrait; without one the row is left out. */
  shown: boolean;
  /** Whether the switch can be turned on; a model that reads text only cannot be shown one. */
  enabled: boolean;
  /** Where the switch stands until the owner turns it. */
  on: boolean;
  /** The switch's description. */
  description: string;
}

/**
 * The portrait switch for a model, from what the catalog says it reads: on
 * for a model that reads images, off and disabled for one that reads text
 * only, off but available when the catalog does not say (or the model is
 * not listed). The row keeps its shape across models; only this changes.
 */
export function portraitDefault(info: ModelInfo | undefined, hasPortrait: boolean): PortraitSwitch {
  if (!hasPortrait) return { shown: false, enabled: false, on: false, description: "" };
  switch (info?.images ?? null) {
    case true:
      return {
        shown: true,
        enabled: true,
        on: true,
        description: "Reads the portrait to check appearance",
      };
    case false:
      return { shown: true, enabled: false, on: false, description: "This model reads text only" };
    default:
      return {
        shown: true,
        enabled: true,
        on: false,
        description: "Not reported for this model; try it",
      };
  }
}
