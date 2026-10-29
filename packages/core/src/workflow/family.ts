import { z } from "zod";
import { ART_FAMILIES, type ArtFamily } from "../creator/prompts.ts";

export const artFamilySchema = z.enum(ART_FAMILIES);

/*
 * The family a workflow file's id names: its first hyphen-separated word when
 * that is "krea2" or "moss", so "krea2-gonzalomo" runs Krea 2, and General for
 * any other first word.
 */
export function fileFamilyOf(id: string): ArtFamily {
  const first = id.split("-", 1)[0];
  return first === "krea2" || first === "moss" ? first : "general";
}
