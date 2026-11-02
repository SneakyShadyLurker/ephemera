import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { notReached } from "../signin/signin.ts";
import { LINKS_FULL_TEXT } from "./library.ts";
import { refreshLibrary, setLink, updateCachedLink } from "./queries.ts";

/** One link between a book and a character, by name for what is said about it. */
interface LinkChange {
  lorebookId: string;
  characterId: string;
  /** The character's name, for a refusal at its limit. */
  character: string;
  linked: boolean;
}

const keyOf = (change: Pick<LinkChange, "lorebookId" | "characterId">) =>
  `${change.lorebookId}:${change.characterId}`;

/**
 * Links and unlinks at once, each change pending until the server answers.
 * A refused or failed change leaves the link as it was, said in words; a
 * made one updates the cached library at once, then reloads it. Shared by
 * both pickers and the sheet's Unlink.
 */
export function useLinks() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const change = async (link: LinkChange): Promise<boolean> => {
    const key = keyOf(link);
    setPending((now) => ({ ...now, [key]: link.linked }));
    setError(null);
    const outcome = await setLink(link.lorebookId, link.characterId, link.linked);
    setPending((now) => Object.fromEntries(Object.entries(now).filter(([other]) => other !== key)));
    if (outcome === "done")
      updateCachedLink(queryClient, link.lorebookId, link.characterId, link.linked);
    const verb = link.linked ? "Not linked" : "Not unlinked";
    if (outcome === "full") setError(`${verb}: ${link.character} already has ${LINKS_FULL_TEXT}.`);
    else if (outcome === "gone") setError(`${verb}: the lorebook or the character was deleted.`);
    else if (outcome === "failed") setError(`${verb}: ${notReached()}.`);
    await refreshLibrary(queryClient, link.lorebookId);
    return outcome === "done";
  };

  return {
    /** The state a link is on its way to, while it is. */
    pendingOf: (lorebookId: string, characterId: string): boolean | undefined =>
      pending[keyOf({ lorebookId, characterId })],
    error,
    clearError: () => setError(null),
    change,
  };
}
