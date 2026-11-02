import { z } from "zod";
import { CARD_LIMITS as L } from "../card/limits.ts";
import { modelIdSchema, retryAfterSchema, UPSTREAM_BUSY } from "../chat.ts";
import { REASONING_EFFORTS } from "../preset/sampler.ts";
import { comfyuiWorkflowIdSchema, comfyuiWorkflowOptionSchema } from "../settings.ts";
import { callAccountingSchema } from "../usage.ts";
import { WORKFLOW_LIMITS as W } from "../workflow/graph.ts";
import { CREATOR_LIMITS as C } from "./limits.ts";
import { ART_LOOK_IDS } from "./looks.ts";

/*
 * AI card creation: request bodies, the generated card and both stream
 * formats. The description, the card before Keep, the image prompt and the
 * candidate images are creation drafts (PRINCIPLES.md 1): memory only.
 */

/**
 * Subject: one character. Group (Multiple Subjects): two or three
 * characters. Scenario: a world with its cast.
 */
export const creatorKindSchema = z.enum(["subject", "group", "scenario"]);
export type CreatorKind = z.infer<typeof creatorKindSchema>;

/** Subject portrait framing; other kinds keep their own composition. */
export const creatorArtCompositionSchema = z.enum(["regular", "diptych"]);
export type CreatorArtComposition = z.infer<typeof creatorArtCompositionSchema>;

/** A capture look from the catalogue (looks.ts). */
export const artLookIdSchema = z.enum(ART_LOOK_IDS);

/** How long the model thinks before writing; absent, its default. */
export const creatorReasoningSchema = z.enum(REASONING_EFFORTS).exactOptional();

/** `POST /api/creator/card`: write a card from the owner's description. */
export const creatorCardRequestSchema = z.strictObject({
  kind: creatorKindSchema,
  description: z.string().trim().min(1).max(C.descriptionLength),
  model: modelIdSchema,
  reasoning: creatorReasoningSchema,
  /** The persona {{user}} is; absent, the card leaves {{user}} to the description. */
  personaId: z.uuid().optional(),
});
export type CreatorCardRequest = z.infer<typeof creatorCardRequestSchema>;

/*
 * A brainstorm's request, the feedback on its ideas and the ideas themselves
 * are creation drafts too: the tab's memory and one server request. A pitch,
 * a brief and the feedback share the description's bound, since a brief
 * becomes a card request's description; past it a value is invalid, never cut.
 */

/** One idea: the pitch the player reads to choose, and the brief Describe is prefilled with. */
export const brainstormOptionSchema = z.strictObject({
  pitch: z.string().trim().min(1).max(C.descriptionLength),
  brief: z.string().trim().min(1).max(C.descriptionLength),
});
export type BrainstormOption = z.infer<typeof brainstormOptionSchema>;

/** One earlier list and what the player said after it; no feedback for a kind switch or a plain "new ideas". */
export const brainstormRoundSchema = z.strictObject({
  kind: creatorKindSchema,
  options: z.array(brainstormOptionSchema).min(1).max(C.brainstormOptions),
  feedback: z.string().trim().min(1).max(C.descriptionLength).optional(),
});
export type BrainstormRound = z.infer<typeof brainstormRoundSchema>;

/** `POST /api/creator/brainstorm`: ten ideas for the request; the kind is classified first when absent. */
export const creatorBrainstormRequestSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(C.descriptionLength),
    /** The kind to brainstorm; absent, the server classifies the request first. Required with rounds. */
    kind: creatorKindSchema.optional(),
    /** Earlier real lists, oldest first, each with what followed it. */
    rounds: z.array(brainstormRoundSchema).max(C.brainstormRounds),
    model: modelIdSchema,
    reasoning: creatorReasoningSchema,
  })
  .refine((request) => request.kind !== undefined || request.rounds.length === 0, {
    path: ["kind"],
  });
export type CreatorBrainstormRequest = z.infer<typeof creatorBrainstormRequestSchema>;

/** `POST /api/creator/art`: write an image prompt from the art source, then paint it. */
export const creatorArtRequestSchema = z.strictObject({
  kind: creatorKindSchema,
  composition: creatorArtCompositionSchema.optional(),
  /** An explicit look for Subject and Group covers; absent, the model chooses (Auto). Ignored for Scenario. */
  look: artLookIdSchema.optional(),
  model: modelIdSchema,
  /** The card's effort, so the image prompt is written as the card was. */
  reasoning: creatorReasoningSchema,
  /** What `artSource` made from the card in memory. */
  source: z.string().trim().min(1).max(C.artSourceLength),
  /** The owner's direction for this batch, which `artPrompt` puts first; absent, the notes alone. */
  direction: z.string().trim().min(1).max(C.artDirectionLength).optional(),
  /** The workflow the tab shows, refused without a graph on the server; absent, the saved one. */
  workflow: comfyuiWorkflowIdSchema.optional(),
  /** Attach this character's stored portrait for the prompt model to match; the server loads it by id. */
  reference: z.strictObject({ characterId: z.uuid() }).optional(),
});
export type CreatorArtRequest = z.infer<typeof creatorArtRequestSchema>;

/** The top-level sections of the model's tagged answer, in the order it writes them. */
export const cardSectionSchema = z.enum(["name", "description", "firstMessage", "creatorNotes"]);
export type CardSection = z.infer<typeof cardSectionSchema>;

const text = z.string().max(L.textLength);
const blockName = z.string().min(1).max(C.blockNameLength);
const count = z.int().min(0);

/** A finished answer that passed validation, before it becomes sheet fields. */
export const generatedCardSchema = z.strictObject({
  name: z.string().min(1).max(L.nameLength),
  description: text.min(1),
  firstMessage: text.min(1),
  creatorNotes: text,
});
export type GeneratedCard = z.infer<typeof generatedCardSchema>;

/** What is wrong with a finished answer; the owner can retry with Rewrite. */
const cardProblemSchema = z.discriminatedUnion("code", [
  /** A required section is absent or empty. */
  z.strictObject({ code: z.literal("missing"), section: cardSectionSchema }),
  /** A section was opened and never closed, usually because the output was cut off. */
  z.strictObject({ code: z.literal("incomplete"), section: cardSectionSchema }),
  /** A section is past its card limit. */
  z.strictObject({ code: z.literal("too_long"), section: cardSectionSchema }),
  /** A Subject or Group description holds more or fewer subject blocks than its kind allows. */
  z.strictObject({ code: z.literal("subject_count"), count, min: count, max: count }),
  /** A subject block name is not lowercase letters joined by underscores. */
  z.strictObject({ code: z.literal("block_name"), block: blockName }),
  /** A subject block lacks the four inner tags in order, or is not closed. */
  z.strictObject({ code: z.literal("block_tags"), block: blockName }),
  /** A Scenario description is not exactly Roleplay, Setting, People, Tone, with no character block in them. */
  z.strictObject({ code: z.literal("scenario_blocks") }),
]);
export type CardProblem = z.infer<typeof cardProblemSchema>;

const cardValidationSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    problems: z.array(cardProblemSchema).min(1).max(C.problems),
  }),
]);

/**
 * Estimated tokens of one counted block against its cap: each subject block
 * on a Subject or Group card, the whole description (block `description`) on a
 * Scenario card. Over the cap is reported, never cut.
 */
const blockTokensSchema = z.strictObject({
  block: blockName,
  tokens: count,
  cap: count,
});
export type BlockTokens = z.infer<typeof blockTokensSchema>;

/** Why an art request stopped; content-free, the web app explains each one. */
export const creatorErrorCodeSchema = z.enum([
  /** The model call failed. */
  "upstream",
  /** The model's provider stayed busy through the server's retries. */
  UPSTREAM_BUSY,
  /** The request ran past its deadline. */
  "timeout",
  /** No ComfyUI address is configured. */
  "not_configured",
  /** The saved address's origin is not one the server allows; nothing was sent. */
  "not_allowed",
  /** ComfyUI failed or returned an unusable batch. */
  "comfyui",
  /** Atelier's private worker stayed busy with other jobs through the admission wait. */
  "comfyui_busy",
  /** The referenced character is gone; nothing was sent. */
  "not_found",
  /** The stored portrait could not be prepared for the model; nothing was sent. */
  "reference",
]);
export type CreatorErrorCode = z.infer<typeof creatorErrorCodeSchema>;

/** Why the configured ComfyUI cannot paint; content-free. */
const creatorArtUnavailableSchema = z.enum([
  /** The saved address's origin is not one the server allows, so nothing is sent. */
  "not_allowed",
  /** No answer, a refused redirect, or an error status. */
  "unreachable",
  /** A token is configured and the address is plain http, so nothing is sent. */
  "insecure",
  /** The bearer token is missing or wrong. */
  "unauthorized",
  /** Atelier's private worker answered but is not ready. */
  "not_ready",
  /** An answer ComfyUI should not give, or one past its size cap. */
  "invalid_response",
]);
export type CreatorArtUnavailable = z.infer<typeof creatorArtUnavailableSchema>;

/** A node class or model file name: workflow configuration, never content. */
const configName = z.string().min(1).max(W.missingNameLength);
const configNames = z.array(configName).max(W.missingNames);

/** `GET /api/creator/art/status?workflow=`: the workflow to check; absent, the saved one. */
export const creatorArtStatusQuerySchema = z.strictObject({
  workflow: comfyuiWorkflowIdSchema.optional(),
});

/** `GET /api/creator/art/status`: whether portraits can be painted with the saved address and that workflow. */
export const creatorArtStatusSchema = z.discriminatedUnion("state", [
  /** No ComfyUI address is saved. */
  z.strictObject({ state: z.literal("off") }),
  z.strictObject({ state: z.literal("ready") }),
  z.strictObject({ state: z.literal("unavailable"), reason: creatorArtUnavailableSchema }),
  /** Reachable, but the workflow's node classes or model files are not all installed. */
  z.strictObject({ state: z.literal("missing"), nodes: configNames, models: configNames }),
]);
export type CreatorArtStatus = z.infer<typeof creatorArtStatusSchema>;

/** `GET /api/creator/art/workflows`: the user's workflows, then the server's. */
export const creatorArtWorkflowsSchema = z.strictObject({
  workflows: z
    .array(comfyuiWorkflowOptionSchema)
    .min(1)
    .max(W.workflows + W.serverWorkflows),
});

/** Why a card request stopped; content-free, the web app explains each one. */
const creatorCardErrorCodeSchema = z.enum([
  /** The model call failed. */
  "upstream",
  /** The model's provider stayed busy through the server's retries. */
  UPSTREAM_BUSY,
  /** The request ran past its deadline. */
  "timeout",
  /** The model reached its output ceiling before the card was finished. */
  "cut",
  /** The provider's content filter ended the answer. */
  "filtered",
  /** The system prompt and the description do not fit the model's context window. */
  "too_large",
]);
export type CreatorCardErrorCode = z.infer<typeof creatorCardErrorCodeSchema>;

/**
 * One event of the card stream: text as written, then one result, or an
 * error. `thinking` says the model is reasoning and carries nothing of it.
 * `retry` says the first answer failed validation and is being written once
 * more: the text so far is dropped, and the second answer's text follows.
 */
export const creatorCardEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delta"), text: z.string() }),
  z.strictObject({ type: z.literal("thinking") }),
  z.strictObject({
    type: z.literal("retry"),
    problems: z.array(cardProblemSchema).min(1).max(C.problems),
  }),
  z.strictObject({
    type: z.literal("result"),
    validation: cardValidationSchema,
    /** Counted for a valid card only; empty otherwise. */
    tokens: z.array(blockTokensSchema).max(C.subjects),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: creatorCardErrorCodeSchema,
    /** With `upstream_busy`, when the provider said how long to wait. */
    retryAfterS: retryAfterSchema.exactOptional(),
  }),
]);
export type CreatorCardEvent = z.infer<typeof creatorCardEventSchema>;

/** Why a brainstorm stopped; content-free, the web app explains each one. */
const creatorBrainstormErrorCodeSchema = z.enum([
  ...creatorCardErrorCodeSchema.options,
  /** The classifier named none of the three kinds. */
  "kind_unclear",
  /** No usable idea after the one retry. */
  "unusable",
]);
export type CreatorBrainstormErrorCode = z.infer<typeof creatorBrainstormErrorCodeSchema>;

/**
 * One event of the brainstorm stream: the kind a classified request was read
 * as, ideas as their lines complete, then one result, or an error.
 * `thinking` carries nothing of the reasoning. `retry` says the first answer
 * held fewer than ten usable ideas: the list is written again from the start.
 */
export const creatorBrainstormEventSchema = z.discriminatedUnion("type", [
  /** The kind the request was read as (classified rounds only). */
  z.strictObject({ type: z.literal("kind"), kind: creatorKindSchema }),
  z.strictObject({ type: z.literal("thinking") }),
  /** One idea as its line completed; `index` is its place in the list being written. */
  z.strictObject({
    type: z.literal("option"),
    index: z
      .int()
      .min(0)
      .max(C.brainstormOptions - 1),
    option: brainstormOptionSchema,
  }),
  z.strictObject({ type: z.literal("retry") }),
  /** The list as validated: ten, or the best attempt's fewer. */
  z.strictObject({
    type: z.literal("result"),
    options: z.array(brainstormOptionSchema).min(1).max(C.brainstormOptions),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: creatorBrainstormErrorCodeSchema,
    /** With `upstream_busy`, when the provider said how long to wait. */
    retryAfterS: retryAfterSchema.exactOptional(),
  }),
]);
export type CreatorBrainstormEvent = z.infer<typeof creatorBrainstormEventSchema>;

/** Why an image card request stopped; content-free, the caller maps each one. */
const creatorImageCardErrorCodeSchema = z.enum([
  /** The model call failed, or the model refused (its content filter stopped the answer). */
  "upstream",
  /** The model's provider stayed busy through the server's retries. */
  UPSTREAM_BUSY,
  /** The request ran past its deadline. */
  "timeout",
  /** No reply model is saved. */
  "no_model",
  /** The saved model's catalog entry says it cannot read images. */
  "text_only_model",
  /** No context window is known for the saved model. */
  "context_window_unknown",
  /** The prompt and the image do not fit the window. */
  "too_large",
  /**
   * The answer was unusable after the one retry (or with no room for it),
   * the output ceiling cut it, or the card did not fit the card limit.
   */
  "invalid_card",
  /** Saving the card failed; it may still have been kept when only reading it back failed. */
  "save_failed",
  /** Anything else failed unexpectedly inside Ephemera, such as a settings read; nothing was kept. */
  "internal",
]);
export type CreatorImageCardErrorCode = z.infer<typeof creatorImageCardErrorCodeSchema>;

/**
 * One event of the image card stream: phases, then the kept character, or an
 * error. No card text: it never leaves the server before it is kept.
 */
export const creatorImageCardEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("status"),
    /** The model call started, the first answer was unusable, or the card is being saved. */
    phase: z.enum(["writing", "rewriting", "saving"]),
  }),
  z.strictObject({
    type: z.literal("result"),
    id: z.uuid(),
    /** The persisted character's name. */
    name: z.string().min(1).max(L.nameLength),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: creatorImageCardErrorCodeSchema,
    /** With `upstream_busy`, when the provider said how long to wait. */
    retryAfterS: retryAfterSchema.exactOptional(),
  }),
]);
export type CreatorImageCardEvent = z.infer<typeof creatorImageCardEventSchema>;

export const artProgressSchema = z
  .strictObject({
    accounting: callAccountingSchema.exactOptional(),
    type: z.literal("progress"),
    phase: z.enum([
      "prompt",
      "starting",
      "busy",
      "queued",
      "loading",
      "running",
      "decoding",
      "sending",
    ]),
    value: count,
    max: count,
    /** While `busy`: the worker's waiting-list place, 1 being next in line. */
    position: z.int().positive().exactOptional(),
  })
  .refine((event) => event.value <= event.max, { path: ["value"] });

export const artControlEventSchema = z.discriminatedUnion("type", [
  artProgressSchema,
  z.strictObject({
    type: z.literal("error"),
    accounting: callAccountingSchema.exactOptional(),
    code: creatorErrorCodeSchema,
    retryAfterS: retryAfterSchema.exactOptional(),
  }),
  z.strictObject({ type: z.literal("done") }),
]);
