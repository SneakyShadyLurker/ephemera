import { z } from "zod";
import { hasTag, tagsSchema, uniqueTags } from "../card/tags.ts";
import { closeSentence } from "../prompt/sentence.ts";
import { storedFields, withRevision } from "../revision.ts";

/*
 * Events: one-line instructions the owner keeps per user, each with a
 * trigger chance and a cooldown. On a new reply every applicable event off
 * cooldown rolls its chance; at most one hit goes into that request as a
 * system instruction. Definitions are ordinary per-user data, persisted and
 * encrypted with the rest; which event fired where is chat content
 * (state.ts). Event text is the owner's and runs through the macro engine.
 */

export const EVENT_LIMITS = {
  /** Events per user. */
  events: 200,
  /** Characters of an event's text, after trimming. */
  text: 500,
  /** Replies an event stays off after it fired. */
  cooldown: 1_000,
  /** Characters one event names. */
  characters: 100,
} as const;

/** The constant words around the injected event's macro-filled text. */
export const EVENT_DIRECTION = {
  lead: "[Direction for your next reply: ",
  close: " Work it into the scene naturally and do not mention this note.]",
} as const;

/**
 * The injected event: its trimmed text, closed with a full stop unless it
 * already ends a sentence, inside the constant direction.
 */
export function eventMessage(text: string): string {
  return `${EVENT_DIRECTION.lead}${closeSentence(text.trim())}${EVENT_DIRECTION.close}`;
}

const unique = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * Where an event applies: every card, or the chosen characters and the
 * cards carrying any chosen tag. Tags are bounded as card tags are, match
 * regardless of case and are kept once each in their first spelling; an
 * unknown character id matches nothing.
 */
const eventScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("selected"),
    characters: z
      .array(z.uuid())
      .max(EVENT_LIMITS.characters)
      .refine(unique, "one entry per character"),
    tags: tagsSchema.overwrite(uniqueTags),
  }),
]);
export type EventScope = z.infer<typeof eventScopeSchema>;

/** What an event's editor sets. */
export const eventFieldsSchema = z.strictObject({
  /** One line: trimmed, never a line break. */
  text: z
    .string()
    .trim()
    .min(1)
    .max(EVENT_LIMITS.text)
    .refine((text) => !/[\n\r\u0085\u2028\u2029]/.test(text), "one line"),
  /** Percent, with at most one decimal. */
  chance: z
    .number()
    .min(0)
    .max(100)
    .refine((chance) => Math.round(chance * 10) / 10 === chance, "at most one decimal"),
  /** Replies the event stays off after the one it fired on; 0 never. */
  cooldown: z.number().int().min(0).max(EVENT_LIMITS.cooldown),
  enabled: z.boolean(),
  scope: eventScopeSchema,
});
export type EventFields = z.infer<typeof eventFieldsSchema>;

/** A create body: the event under a client-chosen id, so a retried create makes no second one. */
export const eventCreateRequestSchema = eventFieldsSchema.extend({ id: z.uuid() });

/** A PATCH body: any of the fields, and the revision they were made against. */
export const eventPatchRequestSchema = withRevision(eventFieldsSchema.partial());

/** One event as the API returns it. */
export const storedEventSchema = eventFieldsSchema
  .extend({
    /** Converted saved text keeps its exact length; only disabled events may be blank. */
    text: z.string().refine((text) => !/[\n\r\u0085\u2028\u2029]/.test(text), "one line"),
    id: z.uuid(),
    ...storedFields,
  })
  .refine((event) => !event.enabled || event.text.trim().length > 0, "enabled event needs text");
export type StoredEvent = z.infer<typeof storedEventSchema>;

/** The answer to a create past `EVENT_LIMITS.events` (409): final, never retried. */
export const eventLimitSchema = z.strictObject({ error: z.literal("too_many_events") });

/** The character a reply is for: its id and its card's tags. */
export interface EventCharacter {
  id: string;
  tags: readonly string[];
}

/** Whether the event's scope takes in the character. */
export function eventApplies(scope: EventScope, character: EventCharacter): boolean {
  if (scope.kind === "all") return true;
  return (
    scope.characters.includes(character.id) || scope.tags.some((tag) => hasTag(character.tags, tag))
  );
}
