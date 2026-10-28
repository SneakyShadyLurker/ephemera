import type { AuthorsNote } from "@ephemera/core";
import { PRESET_LIMITS } from "@ephemera/core";
import { useId } from "react";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { FIELD } from "../sheet/fields.ts";
import { Labelled } from "../sheet/Labelled.tsx";
import { DepthField, RoleField } from "../sheet/RoleFields.tsx";

/* The prompt preset's Author's Note fields: the text, then where and how often it goes. */

const POSITIONS: Record<AuthorsNote["position"], string> = {
  inChat: "In the chat",
  afterMain: "After the main prompt",
};

const ordinal = new Intl.PluralRules("en", { type: "ordinal" });
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };

/** How often the note goes out, counted in the user's messages . */
function frequencyText(frequency: number): string {
  if (frequency === 0) return "Never sent";
  if (frequency === 1) return "With each of your messages";
  return `With every ${frequency}${SUFFIX[ordinal.select(frequency)]} of your messages`;
}

/** An Author's Note and where it goes: position, depth, role and frequency, each labelled. */
export function NoteEditor({
  note,
  onChange,
}: {
  note: AuthorsNote;
  onChange: (patch: Partial<AuthorsNote>) => void;
}) {
  const textId = useId();
  const inChat = note.position === "inChat";
  return (
    <>
      <div>
        <label htmlFor={textId} className="sr-only">
          Author's Note
        </label>
        <textarea
          id={textId}
          name="authors-note"
          value={note.text}
          maxLength={PRESET_LIMITS.blockText}
          rows={2}
          autoComplete="off"
          placeholder="Steer the story from inside the chat, for example: Keep the fog thick."
          onChange={(event) => onChange({ text: event.target.value })}
          className={FIELD}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3 tablet:grid-cols-4">
        <Labelled label="Position">
          {(labelId) => (
            <Select
              value={note.position}
              items={POSITIONS}
              onValueChange={(value) => {
                if (value === "inChat" || value === "afterMain") onChange({ position: value });
              }}
            >
              <SelectTrigger aria-labelledby={labelId} placeholder="Position" />
              <SelectContent label="Positions">
                {Object.entries(POSITIONS).map(([value, text]) => (
                  <SelectItem key={value} value={value}>
                    {text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Labelled>
        <DepthField
          value={note.depth}
          note={inChat ? "Messages from the end" : "Used in the chat only"}
          disabled={!inChat}
          onChange={(depth) => onChange({ depth })}
        />
        <RoleField value={note.role} onChange={(role) => onChange({ role })} />
        <Labelled label="Frequency" note={frequencyText(note.frequency)}>
          {() => (
            <NumberField
              label="Frequency"
              value={note.frequency}
              min={0}
              max={PRESET_LIMITS.maxDepth}
              onValueChange={(value) => onChange({ frequency: value ?? 0 })}
            />
          )}
        </Labelled>
      </div>
    </>
  );
}
