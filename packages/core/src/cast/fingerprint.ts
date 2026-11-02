import type { CharacterCard } from "../card/schema.ts";
import { taggedCardKind } from "../creator/saved-art-source.ts";

/**
 * What a cast sheet's fingerprint hashes (sha256 on the server): the card's
 * name, description and the kind its tags name (null for none, as the sheet
 * call reads it). A first message is not part of it: greetings place people, they do not describe them.
 */
export const castFingerprintInput = (
  card: Pick<CharacterCard, "name" | "description" | "tags">,
): string => JSON.stringify([card.name, card.description, taggedCardKind(card.tags)]);
