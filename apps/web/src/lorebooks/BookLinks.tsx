import { useQuery } from "@tanstack/react-query";
import { ChoicePicker } from "@/app/ChoicePicker.tsx";
import { CharactersIcon } from "@/components/icons";
import { byName } from "@/lib/find";
import { charactersQuery } from "../characters/queries.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { Leaves } from "./Leaves.tsx";
import { LINKS_FULL_TEXT, linkedCharacters, linkedConsequence, linksFull } from "./library.ts";
import { libraryQuery } from "./queries.ts";
import { useLinks } from "./useLinks.ts";

/**
 * A library book's characters, always in view in its editor: how many it is
 * linked to and that an edit reaches all of them, a few portraits, and one
 * way to change them. A character at its limit of linked books cannot take
 * this one, and says so; unlinking always stays possible.
 */
export function BookLinks({ id, name }: { id: string; name: string }) {
  const library = useQuery(libraryQuery);
  const characters = useQuery(charactersQuery);
  const links = useLinks();
  const all = [...(characters.data ?? [])].sort((a, b) => byName(a.name, b.name));
  const allLinks = library.data?.links ?? [];
  const linked = linkedCharacters(allLinks, id, all);
  const ready = library.data !== undefined && characters.data !== undefined;
  const label = name.trim() || "this lorebook";

  const choices = all.map((character) => {
    const isLinked = linked.some((other) => other.id === character.id);
    const pending = links.pendingOf(id, character.id);
    const full = !isLinked && linksFull(allLinks, character.id);
    return {
      id: character.id,
      name: character.name,
      checked: pending ?? isLinked,
      pending: pending !== undefined,
      disabled: full,
      ...(full ? { note: LINKS_FULL_TEXT } : {}),
      leaf: (
        <PortraitLeaf
          id={character.id}
          name={character.name}
          version={character.portrait}
          className="w-5"
        />
      ),
    };
  });

  return (
    <section aria-label="Linked characters" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Leaves characters={linked} />
        <p className="min-w-0 flex-1 basis-40 text-pretty text-note text-ink">
          {ready ? linkedConsequence(linked.length) : " "}
        </p>
        <ChoicePicker
          trigger={
            <>
              <CharactersIcon size={16} />
              Manage characters
            </>
          }
          disabled={!ready}
          title={`Characters linked to ${label}`}
          sheetTitle="Linked characters"
          findLabel="Find a character"
          empty="No characters yet."
          noMatch="No character matches."
          choices={choices}
          onToggle={(choice, checked) =>
            void links.change({
              lorebookId: id,
              characterId: choice.id,
              character: choice.name,
              linked: checked,
            })
          }
          notice={
            links.error !== null && (
              <p role="alert" className="px-2.5 pb-1.5 text-ember text-note">
                {links.error}
              </p>
            )
          }
        />
      </div>
    </section>
  );
}
