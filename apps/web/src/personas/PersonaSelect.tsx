import type { PersonaSummary } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import {
  LEAF_TRIGGER,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { useChatPersona } from "../chat/character.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { useUpdateSettings } from "../settings/settings.ts";
import { personasQuery } from "./queries.ts";

const NO_PERSONA = "none";

const SIZES = {
  /** The Session panel's field. */
  field: { trigger: LEAF_TRIGGER.trigger, popup: "" },
  /** A compact row control. */
  row: { trigger: cn(LEAF_TRIGGER.trigger, "w-full max-w-72 tablet:w-64"), popup: "min-w-64" },
} as const;

/**
 * Who the user is now: the saved persona, which chat and Create with AI
 * both follow. Choosing here saves it.
 */
export function PersonaSelect({
  labelId,
  size = "field",
  onChosen,
}: {
  labelId: string;
  size?: keyof typeof SIZES;
  /** Called after a choice, before it is saved. */
  onChosen?: () => void;
}) {
  const personas = useQuery(personasQuery);
  const persona = useChatPersona();
  const updateSettings = useUpdateSettings();
  const list = personas.data ?? [];
  const sizing = SIZES[size];

  return (
    <Select
      value={persona?.id ?? NO_PERSONA}
      onValueChange={(value) => {
        if (typeof value !== "string") return;
        onChosen?.();
        updateSettings({ personaId: value === NO_PERSONA ? null : value });
      }}
    >
      <SelectTrigger aria-labelledby={labelId} placeholder="You" className={sizing.trigger}>
        <span
          key={persona?.id ?? NO_PERSONA}
          className={cn(
            "flex min-w-0 flex-1 items-center transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
            size === "field" ? "gap-3" : "gap-2",
          )}
        >
          {persona && (
            <PortraitLeaf
              owner="personas"
              id={persona.id}
              name={persona.name}
              version={persona.portrait}
              className={LEAF_TRIGGER.leaf}
            />
          )}
          <span className="truncate">{persona?.name ?? "You"}</span>
        </span>
      </SelectTrigger>
      <SelectContent label="Personas" className={sizing.popup}>
        <PersonaOptions none={NO_PERSONA} noneLabel="You (no persona)" personas={list} />
      </SelectContent>
    </Select>
  );
}

/**
 * A persona list's options: the no-persona row, then each persona with its
 * leaf (portrait or initial), every name starting at one x. Typing matches
 * the name alone.
 */
export function PersonaOptions({
  none,
  noneLabel,
  personas,
}: {
  none: string;
  noneLabel: string;
  personas: readonly PersonaSummary[];
}) {
  return (
    <>
      <SelectItem value={none}>
        <span className="flex items-center gap-3">
          <span aria-hidden="true" className="w-6 shrink-0" />
          <span className="truncate">{noneLabel}</span>
        </span>
      </SelectItem>
      {personas.map((option) => (
        <SelectItem
          key={option.id}
          value={option.id}
          label={option.name}
          className="h-12 touch:h-14"
        >
          <span className="flex items-center gap-3">
            <PortraitLeaf
              owner="personas"
              id={option.id}
              name={option.name}
              version={option.portrait}
              className="w-6"
            />
            <span className="truncate">{option.name}</span>
          </span>
        </SelectItem>
      ))}
    </>
  );
}
