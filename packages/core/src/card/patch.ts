import type { CharacterCard, CharacterPatch } from "./schema.ts";

/** Applies a sparse sheet edit; null removes an optional note or book. */
export function applySheetPatch(card: CharacterCard, patch: CharacterPatch): CharacterCard {
  const { characterNote, lorebook, ...fields } = patch;
  const { characterNote: oldNote, lorebook: oldBook, ...base } = card;
  const note = characterNote === undefined ? oldNote : characterNote;
  const book = lorebook === undefined ? oldBook : lorebook;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    ...(note == null ? {} : { characterNote: note }),
    ...(book == null ? {} : { lorebook: book }),
  };
}
