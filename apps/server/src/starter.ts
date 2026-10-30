import { join } from "node:path";
import type { CharacterCard } from "@ephemera/core";
import { readCardFile } from "./cards.ts";
import { readStarterCardFile } from "./persistence/starter-file.ts";
import type { Portrait } from "./persistence/store.ts";

/** The example character a new user's library starts with, so a fresh install is not empty. */
export interface StarterCharacter {
  card: CharacterCard;
  portrait?: Portrait;
}

/** A native card PNG bundled with the server. */
const STARTER_CARD = join(import.meta.dirname, "starter", "friday-abbams.png");

/** Reads the bundled card once at startup, through the same reader as an import. */
export async function loadStarterCharacter(): Promise<StarterCharacter> {
  const result = await readCardFile(await readStarterCardFile(STARTER_CARD));
  if (!result.ok) throw new Error(`The bundled starter card does not read: ${result.error}`);
  return result.portrait === undefined
    ? { card: result.card }
    : { card: result.card, portrait: result.portrait };
}
