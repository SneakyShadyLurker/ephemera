import {
  type CharacterSummary,
  EVENT_LIMITS,
  type EventScope,
  hasTag,
  sameTag,
  tagKey,
} from "@ephemera/core";
import { type ReactNode, useId, useState } from "react";
import { type Choice, ChoicePicker } from "@/app/ChoicePicker.tsx";
import { CharactersIcon, TagIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { cn } from "@/lib/cn";
import { byName } from "@/lib/find";
import { isComposing } from "@/lib/keys.ts";
import { countOf, formatCount } from "@/lib/text";
import { tagCounts } from "../characters/filter.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { FIELD } from "../sheet/fields.ts";
import { Labelled } from "../sheet/Labelled.tsx";
import type { EventSaveFields } from "./autosave.ts";

const HELP = "text-pretty text-note text-reed";
const LABEL = "font-medium text-ink text-ui";
/** The count of the instruction's characters shows from here. */
const COUNT_FROM = 450;
/** Line breaks of any kind: the instruction is one line. */
const BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/g;

/**
 * An open event's editor: the instruction as one line that wraps, the
 * chance and the quiet replies after it, where it applies, and Delete.
 * Every change goes to the row at once; the row saves it.
 */
export function EventEditor({
  fields,
  characters,
  rule,
  focusOnMount,
  onChange,
  deleting,
  onDelete,
}: {
  fields: EventSaveFields;
  /** Every character, or undefined until the list has loaded. */
  characters: readonly CharacterSummary[] | undefined;
  /** The rule sentence with its average, repeated under the numbers. */
  rule: ReactNode;
  /** A new event: the instruction takes focus. */
  focusOnMount: boolean;
  onChange: (patch: Partial<EventSaveFields>) => void;
  /** A deletion is on its way: Delete waits for it. */
  deleting: boolean;
  onDelete: () => void;
}) {
  const instructionId = useId();
  const helpId = useId();
  const ruleId = useId();
  const length = fields.name.length;
  return (
    <div className="grid max-w-help gap-5">
      <div className="grid gap-1.5">
        <label htmlFor={instructionId} className={LABEL}>
          Instruction
        </label>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: a new event opens because Add was chosen.
          autoFocus={focusOnMount}
          id={instructionId}
          value={fields.name}
          rows={1}
          maxLength={EVENT_LIMITS.text}
          aria-describedby={helpId}
          onKeyDown={(event) => {
            // One line: Enter never breaks it, and is left alone while an IME composes.
            if (event.key === "Enter" && !isComposing(event)) event.preventDefault();
          }}
          // Pasted line breaks become spaces.
          onChange={(event) => onChange({ name: event.target.value.replace(BREAKS, " ") })}
          className={cn(FIELD, "text-ui")}
        />
        <p id={helpId} className={cn(HELP, "flex flex-wrap justify-between gap-x-3")}>
          <span>One line, told to the model as an instruction for a single reply.</span>
          {length >= COUNT_FROM && (
            <span className="tabular-nums">
              {formatCount(length)} of {formatCount(EVENT_LIMITS.text)}
            </span>
          )}
        </p>
      </div>

      <div className="grid gap-2">
        <div className="grid gap-3 tablet:grid-cols-[auto_auto] tablet:justify-start tablet:gap-x-8">
          <Labelled label="Chance per reply">
            {() => (
              <span className="flex items-center gap-1.5">
                <NumberField
                  label="Chance per reply in percent"
                  describedBy={ruleId}
                  value={fields.chance}
                  min={0}
                  max={100}
                  smallStep={0.1}
                  format={{ maximumFractionDigits: 1 }}
                  inputMode="decimal"
                  className="w-32 touch:w-40"
                  onValueChange={(value) => {
                    // Out of range waits for the blur, which clamps it.
                    if (value === null || value < 0 || value > 100) return;
                    onChange({ chance: Math.round(value * 10) / 10 });
                  }}
                />
                <span aria-hidden="true" className="text-ink text-ui">
                  %
                </span>
              </span>
            )}
          </Labelled>
          <Labelled label="Quiet afterwards">
            {() => (
              <span className="flex items-center gap-1.5">
                <NumberField
                  label="Quiet afterwards in replies"
                  describedBy={ruleId}
                  value={fields.cooldown}
                  min={0}
                  max={EVENT_LIMITS.cooldown}
                  format={{ maximumFractionDigits: 0 }}
                  inputMode="numeric"
                  className="w-32 touch:w-40"
                  onValueChange={(value) => {
                    if (value === null || value < 0 || value > EVENT_LIMITS.cooldown) return;
                    onChange({ cooldown: Math.round(value) });
                  }}
                />
                <span aria-hidden="true" className="text-ink text-ui">
                  replies
                </span>
              </span>
            )}
          </Labelled>
        </div>
        <p id={ruleId} className="text-pretty text-ink text-note">
          {rule}
        </p>
      </div>

      <AppliesTo
        scope={fields.scope}
        characters={characters}
        onChange={(scope) => onChange({ scope })}
      />

      <Button
        variant="quiet"
        className="-ml-3.5 justify-self-start"
        disabled={deleting}
        focusableWhenDisabled
        onClick={onDelete}
      >
        Delete event
      </Button>
    </div>
  );
}

type Chosen = { characters: string[]; tags: string[] };

/**
 * All characters, or the chosen characters and tags, each from its picker.
 * The chosen lists are kept while All is chosen, so choosing again brings them back.
 */
function AppliesTo({
  scope,
  characters,
  onChange,
}: {
  scope: EventScope;
  characters: readonly CharacterSummary[] | undefined;
  onChange: (scope: EventScope) => void;
}) {
  const labelId = useId();
  const [kept, setKept] = useState<Chosen>(() =>
    scope.kind === "selected"
      ? { characters: scope.characters, tags: scope.tags }
      : { characters: [], tags: [] },
  );
  // The pickers rise in when the choice brings them, not on opening.
  const [revealed, setRevealed] = useState(false);
  const all = characters ?? [];
  const known = new Map(all.map((character) => [character.id, character]));
  // A chosen character since deleted is left out silently, once the list has loaded to say so.
  // Until then the ids chosen are kept as they are, so a change here never drops them.
  const listed = scope.kind === "selected" ? scope.characters.filter((id) => known.has(id)) : [];
  const chosen: Chosen =
    scope.kind === "selected"
      ? { characters: characters === undefined ? scope.characters : listed, tags: scope.tags }
      : kept;
  const select = (next: Chosen) => {
    setKept(next);
    onChange({ kind: "selected", ...next });
  };
  const atLimit = chosen.characters.length >= EVENT_LIMITS.characters;

  const characterChoices: Choice[] = [...all]
    .sort((a, b) => byName(a.name, b.name))
    .map((character) => {
      const checked = chosen.characters.includes(character.id);
      return {
        id: character.id,
        name: character.name,
        leaf: (
          <PortraitLeaf
            id={character.id}
            name={character.name}
            version={character.portrait}
            className="w-5"
          />
        ),
        checked,
        ...(atLimit && !checked
          ? {
              disabled: true,
              note: `An event names at most ${formatCount(EVENT_LIMITS.characters)} characters.`,
            }
          : {}),
      };
    });
  const counts = tagCounts([...all]);
  const carried = new Set(counts.map(([tag]) => tagKey(tag)));
  const tagChoices: Choice[] = [
    ...counts.map(([tag, count]) => ({
      id: tag,
      name: tag,
      checked: hasTag(chosen.tags, tag),
      note: countOf(count, "card"),
    })),
    // A chosen tag no card carries any more stays, said so.
    ...chosen.tags
      .filter((tag) => !carried.has(tagKey(tag)))
      .map((tag) => ({ id: tag, name: tag, checked: true, note: "on no card" })),
  ];
  const pickedNames = chosen.characters.flatMap((id) => {
    const name = known.get(id)?.name;
    return name === undefined ? [] : [name];
  });

  return (
    <div className="grid gap-2">
      <span id={labelId} className={LABEL}>
        Applies to
      </span>
      <RadioGroup<EventScope["kind"]>
        aria-labelledby={labelId}
        value={scope.kind}
        onValueChange={(kind) => {
          if (kind === scope.kind) return;
          setRevealed(kind === "selected");
          if (kind === "all") onChange({ kind: "all" });
          else select(kept);
        }}
        className="gap-0"
      >
        <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-ink text-ui touch:min-h-11">
          <Radio value="all" />
          All characters
        </label>
        <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-ink text-ui touch:min-h-11">
          <Radio value="selected" />
          Chosen characters and tags
        </label>
      </RadioGroup>
      {scope.kind === "selected" && (
        <div className={cn("grid gap-2 pl-6.5 touch:pl-7.5", revealed && "arrive")}>
          <div className="flex flex-wrap gap-2">
            <ChoicePicker
              trigger={
                <>
                  <CharactersIcon size={16} />
                  <span className="max-w-60 truncate">
                    {pickedNames.length === 0
                      ? "Characters"
                      : `Characters: ${pickedNames.join(", ")}`}
                  </span>
                </>
              }
              title="Characters this event applies to"
              sheetTitle="Characters"
              findLabel="Find a character"
              empty="No characters yet."
              noMatch="No match."
              choices={characterChoices}
              onToggle={(choice, checked) =>
                select({
                  ...chosen,
                  characters: checked
                    ? [...chosen.characters, choice.id]
                    : chosen.characters.filter((id) => id !== choice.id),
                })
              }
            />
            <ChoicePicker
              trigger={
                <>
                  <TagIcon size={16} />
                  <span className="max-w-60 truncate">
                    {chosen.tags.length === 0 ? "Tags" : `Tags: ${chosen.tags.join(", ")}`}
                  </span>
                </>
              }
              title="Tags this event applies to"
              sheetTitle="Tags"
              findLabel="Find a tag"
              empty="No card has a tag yet."
              noMatch="No match."
              choices={tagChoices}
              onToggle={(choice, checked) =>
                select({
                  ...chosen,
                  tags: checked
                    ? [...chosen.tags, choice.id]
                    : chosen.tags.filter((tag) => !sameTag(tag, choice.id)),
                })
              }
            />
          </div>
          {chosen.characters.length === 0 && chosen.tags.length === 0 && (
            <p className={HELP}>Applies to no one yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
