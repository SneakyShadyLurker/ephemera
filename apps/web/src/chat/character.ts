import type { CharacterSummary, PersonaSummary } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { charactersQuery } from "../characters/queries.ts";
import { personasQuery } from "../personas/queries.ts";
import { useSetting } from "../settings/settings.ts";

/*
 * Each reads one entry of a list through `select`, so a refetch of the list
 * re-renders a reader only when its entry changed (structural sharing).
 */

/**
 * The character this chat is with, from the saved settings and the gallery's
 * list; undefined when none is chosen or it was deleted (the cue then falls
 * back to "Model").
 */
export function useChatCharacter(): CharacterSummary | undefined {
  const id = useSetting((settings) => settings.characterId);
  const { data } = useQuery({
    ...charactersQuery,
    enabled: id !== null,
    select: (list) => list.find((character) => character.id === id),
  });
  return id === null ? undefined : data;
}

/** A persona from the list by id; undefined for none or a deleted one (the cue then says "You"). */
export function usePersona(id: string | null | undefined): PersonaSummary | undefined {
  const { data } = useQuery({
    ...personasQuery,
    enabled: id != null,
    select: (list) => list.find((persona) => persona.id === id),
  });
  return id == null ? undefined : data;
}

/**
 * The name a user turn shows: the name it was sent under, so a renamed or
 * deleted persona keeps it, else the persona's current one; undefined
 * without a persona (the cue then says "You").
 */
export const speakerName = (
  personaId: string | null | undefined,
  sentName: string | null | undefined,
  persona: PersonaSummary | undefined,
): string | undefined => (personaId == null ? undefined : (sentName ?? persona?.name));

/** The persona the next message is sent as. */
export function useChatPersona(): PersonaSummary | undefined {
  return usePersona(useSetting((settings) => settings.personaId));
}
