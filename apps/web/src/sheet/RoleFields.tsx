import { PRESET_LIMITS, type PromptRole } from "@ephemera/core";
import type { ReactNode } from "react";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { isPromptRole, ROLE_NAMES } from "@/lib/roles";
import { Labelled } from "./Labelled.tsx";

/*
 * Where a text placed in the chat goes: its depth and the role it is sent
 * as, the same controls for the Author's Note, a Character's Note and a
 * lorebook entry.
 */

/** A depth under its label: messages from the end; an emptied field keeps the depth. */
export function DepthField({
  value,
  onChange,
  note,
  disabled,
  readOnly,
}: {
  value: number;
  onChange: (depth: number) => void;
  note?: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  return (
    <Labelled label="Depth" {...(note === undefined ? {} : { note })}>
      {() => (
        <NumberField
          label="Depth"
          value={value}
          min={0}
          max={PRESET_LIMITS.maxDepth}
          {...(disabled === undefined ? {} : { disabled })}
          {...(readOnly === undefined ? {} : { readOnly })}
          onValueChange={(depth) => onChange(Math.trunc(depth ?? value))}
        />
      )}
    </Labelled>
  );
}

/** The role a placed text is sent as, under its label. */
export function RoleField({
  value,
  onChange,
  readOnly,
}: {
  value: PromptRole;
  onChange: (role: PromptRole) => void;
  readOnly?: boolean;
}) {
  return (
    <Labelled label="Role">
      {(labelId) => (
        <Select
          value={value}
          items={ROLE_NAMES}
          {...(readOnly === undefined ? {} : { readOnly })}
          onValueChange={(role) => {
            if (isPromptRole(role)) onChange(role);
          }}
        >
          <SelectTrigger aria-labelledby={labelId} placeholder="Role" />
          <SelectContent label="Roles">
            {Object.entries(ROLE_NAMES).map(([key, text]) => (
              <SelectItem key={key} value={key}>
                {text}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Labelled>
  );
}
