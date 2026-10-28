import { z } from "zod";
import { characterNoteSchema } from "../../card/character-note.ts";
import { lorebookSchema, sheetFieldsSchema } from "../../card/schema.ts";
import { modelIdSchema, retryAfterSchema, UPSTREAM_BUSY } from "../../chat.ts";
import { creatorReasoningSchema } from "../schema.ts";
import { REWORK_LIMITS as R } from "./limits.ts";

/*
 * AI Rework: the request body and the stream format. The request, the
 * answer and the changes read from it are creation drafts (PRINCIPLES.md 1):
 * memory and one request only.
 */

/**
 * What the browser sends of the sheet: the fields the model reads and may
 * change, as currently typed, and the embedded lorebook, so anchors resolve
 * against the exact text the model saw. Nickname, creator and version are
 * neither sent nor changed.
 */
export const reworkCardSchema = sheetFieldsSchema
  .pick({
    name: true,
    description: true,
    personality: true,
    scenario: true,
    firstMessage: true,
    alternateGreetings: true,
    exampleDialogue: true,
    systemPrompt: true,
    postHistoryInstructions: true,
    creatorNotes: true,
    tags: true,
  })
  .extend({
    /** The Character's Note; only its prompt is sent and changed. Null when the card has none. */
    characterNote: characterNoteSchema.nullable(),
    lorebook: lorebookSchema.nullable(),
  });
export type ReworkCard = z.infer<typeof reworkCardSchema>;

/** `POST /api/creator/rework`: propose changes to a saved character from the owner's request. */
export const reworkRequestSchema = z.strictObject({
  characterId: z.uuid(),
  model: modelIdSchema,
  /** How long the model thinks before writing; absent, its default. */
  reasoning: creatorReasoningSchema,
  request: z.string().trim().min(1).max(R.requestLength),
  /** The persona {{user}} is; absent, the card's {{user}} stays as it is. */
  personaId: z.uuid().optional(),
  /** Whether to show the model the stored portrait, when it reads images. */
  portrait: z.boolean(),
  card: reworkCardSchema,
});
export type ReworkRequest = z.infer<typeof reworkRequestSchema>;

/** Why a rework request stopped; content-free, the web app explains each one. */
const reworkErrorCodeSchema = z.enum([
  /** The model call failed. */
  "upstream",
  /** The model's provider stayed busy through the server's retries. */
  UPSTREAM_BUSY,
  /** The request ran past its deadline. */
  "timeout",
  /** The card, its lorebook and the answer do not fit the model's context window. */
  "too_large",
  /** Neither the catalog nor the owner gives the model a context window. */
  "context_window_unknown",
  /** The character is gone. */
  "not_found",
]);
export type ReworkErrorCode = z.infer<typeof reworkErrorCodeSchema>;

/** What is wrong with a finished answer as a whole; changes are placed one by one. */
const reworkProblemSchema = z.enum([
  /** A change block was opened and never closed, usually because the output was cut off. */
  "incomplete",
  /** The answer has no summary, or an empty one. */
  "no_summary",
]);
export type ReworkProblem = z.infer<typeof reworkProblemSchema>;

/** One event of the rework stream: text as written, then one result, or an error. */
export const reworkEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delta"), text: z.string() }),
  z.strictObject({
    type: z.literal("result"),
    problems: z.array(reworkProblemSchema).max(reworkProblemSchema.options.length),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: reworkErrorCodeSchema,
    /** With `upstream_busy`, when the provider said how long to wait. */
    retryAfterS: retryAfterSchema.exactOptional(),
  }),
]);
export type ReworkEvent = z.infer<typeof reworkEventSchema>;
