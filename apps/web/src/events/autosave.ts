import { type EventFields, eventFieldsSchema, type StoredEvent } from "@ephemera/core";
import { z } from "zod";
import type { AutosaveOptions } from "../sheet/autosave-controller.ts";
import type { CreateResult } from "../sheet/saving.ts";
import { postEvent, saveEvent } from "./queries.ts";

/*
 * Events on the sheets' one autosave. The autosave knows a missing name as
 * "nothing to save yet"; an event's instruction plays that part, so the
 * adapter carries it as `name` and gives it back as `text` on the way out.
 */

/** An event's fields as the autosave holds them: the instruction under `name`. */
export type EventSaveFields = Omit<EventFields, "text"> & { name: string };

export const toSaveFields = ({ text, ...rest }: EventFields): EventSaveFields => ({
  name: text,
  ...rest,
});

export const fromSaveFields = ({ name, ...rest }: EventSaveFields): EventFields => ({
  text: name,
  ...rest,
});

const toEventPatch = ({ name, ...rest }: Partial<EventSaveFields>): Partial<EventFields> =>
  name === undefined ? rest : { ...rest, text: name };

const { text, ...others } = eventFieldsSchema.shape;
const saveSchema: z.ZodType<EventSaveFields> = z.strictObject({ name: text, ...others });

const LABELS: Record<keyof EventSaveFields, string> = {
  name: "The instruction",
  chance: "Chance per reply",
  cooldown: "Quiet afterwards",
  enabled: "On",
  scope: "Applies to",
};

/**
 * What a row passes to `useAutosave`, but its fields, id and callbacks. A
 * create refused at the event limit is final: `onLimit` says so, and the
 * autosave treats it as refused.
 */
export function eventSaving(
  onLimit: () => void,
): Pick<
  AutosaveOptions<EventSaveFields, StoredEvent>,
  "schema" | "labels" | "wholeLabel" | "create" | "save"
> {
  return {
    schema: saveSchema,
    labels: LABELS,
    wholeLabel: "The event",
    create: async (id, fields): Promise<CreateResult> => {
      const outcome = await postEvent(id, fromSaveFields(fields));
      if (outcome.ok) return outcome;
      if (outcome.reason !== "limit") return { ok: false, reason: outcome.reason };
      onLimit();
      return { ok: false, reason: "invalid" };
    },
    save: (id, patch, revision) => saveEvent(id, toEventPatch(patch), revision),
  };
}
