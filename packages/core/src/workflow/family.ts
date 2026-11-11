import { z } from "zod";
import { CREATOR_ART } from "../creator/limits.ts";
import { ART_FAMILIES, type ArtFamily } from "../creator/prompts.ts";

export const artFamilySchema = z.enum(ART_FAMILIES);

/*
 * The family a workflow file's id names: its first hyphen-separated word when
 * that is "krea2", "moss" or "h3", so "krea2-gonzalomo" runs Krea 2, and
 * General for any other first word.
 */
export function fileFamilyOf(id: string): ArtFamily {
  const first = id.split("-", 1)[0];
  return first === "krea2" || first === "moss" || first === "h3" ? first : "general";
}

/** What a picture is for: a card's cover or a scene picture in chat. */
export type ArtSurface = "cover" | "scene";

/*
 * The size a family's model renders at before a scaled template shrinks the
 * picture to the portrait size. MiniMax H3 Image is made for about 4 to 20
 * megapixels: covers paint at about eight, 2304 x 3456, and scene pictures at
 * about four, 1664 x 2496, which is also the size its reference pictures
 * render cleanly at (both 2:3, every edge a multiple of 32). Every other
 * family renders at the portrait size itself for either use.
 */
export function renderSizeOf(
  family: ArtFamily,
  surface: ArtSurface,
): {
  readonly width: number;
  readonly height: number;
} {
  if (family !== "h3") return { width: CREATOR_ART.width, height: CREATOR_ART.height };
  return surface === "cover" ? { width: 2304, height: 3456 } : { width: 1664, height: 2496 };
}
