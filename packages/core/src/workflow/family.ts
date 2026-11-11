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

/*
 * The size a family's model renders at before a scaled template shrinks the
 * picture to the portrait size. MiniMax H3 Image is made for large renders,
 * about 4 to 20 megapixels, and paints at about eight here: 2304 x 3456 (2:3,
 * both edges multiples of 32). Every other family renders at the portrait
 * size itself.
 */
export function renderSizeOf(family: ArtFamily): {
  readonly width: number;
  readonly height: number;
} {
  return family === "h3"
    ? { width: 2304, height: 3456 }
    : { width: CREATOR_ART.width, height: CREATOR_ART.height };
}
