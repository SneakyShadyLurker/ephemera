import type { CharacterSummary, PersonaSummary } from "@ephemera/core";
import { ChoicePicker } from "@/app/ChoicePicker.tsx";
import { BindIcon } from "@/components/icons";
import { PortraitLeaf } from "../portraits/Portrait.tsx";

/**
 * Add character: the characters this persona goes with, checked, each other
 * one naming the persona it goes with now (a character goes with one at
 * most). A popover on desktop and tablet, a bottom sheet with Done on phones.
 */
export function BindingPicker({
  persona,
  characters,
  personas,
  onToggle,
}: {
  persona: PersonaSummary;
  characters: CharacterSummary[];
  personas: PersonaSummary[];
  onToggle: (character: CharacterSummary, checked: boolean) => void;
}) {
  const holder = (id: string) =>
    personas.find((other) => other.id !== persona.id && other.characterIds.includes(id));
  const choices = characters.map((character) => {
    const checked = persona.characterIds.includes(character.id);
    const other = checked ? undefined : holder(character.id);
    return {
      id: character.id,
      name: character.name,
      checked,
      leaf: (
        <PortraitLeaf
          id={character.id}
          name={character.name}
          version={character.portrait}
          className="w-5"
        />
      ),
      ...(other === undefined ? {} : { note: `Currently with ${other.name}` }),
    };
  });
  return (
    <ChoicePicker
      trigger={
        <>
          <BindIcon size={16} />
          Add character
        </>
      }
      title={`Characters for ${persona.name}`}
      sheetTitle="Characters"
      findLabel="Find a character"
      empty="No characters yet."
      noMatch="No character matches."
      choices={choices}
      onToggle={(choice, checked) => {
        const character = characters.find((item) => item.id === choice.id);
        if (character !== undefined) onToggle(character, checked);
      }}
    />
  );
}
