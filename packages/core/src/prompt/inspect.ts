import { z } from "zod";
import { CARD_LIMITS } from "../card/limits.ts";
import { generationModeSchema } from "../chat.ts";
import { eventsStateSchema } from "../events/state.ts";
import {
  KEY_PROBLEMS,
  LOREBOOK_LINKS,
  LOREBOOK_RULES,
  LOREBOOK_STATUSES,
} from "../lorebook/rules.ts";
import { ENTRY_LOGICS, ENTRY_PLACEMENTS } from "../lorebook/settings.ts";
import { lorebookStateSchema } from "../lorebook/timed.ts";
import { effectiveWindowSchema } from "../models.ts";
import { promptRoleSchema, REASONING_EFFORTS } from "../preset/index.ts";
import { generationTypeSchema, SOURCE_BLOCKS } from "../preset/prompt.ts";
import { callUsageSchema } from "../usage.ts";
import { TRIMMINGS } from "./budget.ts";
import { macroStateSchema } from "./macro-state.ts";
import { PROMPT_PROCESSING } from "./postprocess.ts";

/*
 * The inspector's view of one request: exactly the messages and call
 * settings sent upstream, with where each message came from and the budget
 * it was fitted to. Chat content: it travels in the reply stream or the
 * preview response and lives only in the tab's memory.
 */

/** Where a sent message came from, for the inspector. */
export const promptSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("block"),
    id: z.enum(["main", "postHistory", ...SOURCE_BLOCKS]),
  }),
  z.strictObject({
    kind: z.literal("custom"),
    id: z.string(),
    name: z.string(),
    depth: z.number().int().min(0).nullable(),
  }),
  // `index` is the example block, `line` the message within it (0 is its wrapper when there is one).
  z.strictObject({
    kind: z.literal("example"),
    index: z.number().int().min(0),
    line: z.number().int().min(0),
  }),
  // `index` is the turn's position in the history the request carried.
  z.strictObject({ kind: z.literal("history"), index: z.number().int().min(0) }),
  // `depth` in the chat, or null right after the main prompt.
  z.strictObject({
    kind: z.literal("authorsNote"),
    depth: z.number().int().min(0).nullable(),
  }),
  z.strictObject({ kind: z.literal("characterNote"), depth: z.number().int().min(0) }),
  // The cast register's current state, its own message in the chat.
  z.strictObject({ kind: z.literal("castState"), depth: z.number().int().min(0) }),
  z.discriminatedUnion("position", [
    z.strictObject({
      kind: z.literal("lorebook"),
      position: z.enum(["before", "after"]),
      entries: z.number().int().min(0),
    }),
    z.strictObject({
      kind: z.literal("lorebook"),
      position: z.literal("depth"),
      depth: z.number().int().min(0),
      role: promptRoleSchema,
      entries: z.number().int().min(0),
    }),
    z.strictObject({
      kind: z.literal("lorebook"),
      position: z.literal("authorsNote"),
      depth: z.number().int().min(0).nullable(),
      entries: z.number().int().min(0),
    }),
    z.strictObject({
      kind: z.literal("lorebook"),
      position: z.literal("examples"),
      side: z.enum(["before", "after"]),
      index: z.number().int().min(0),
      line: z.number().int().min(0),
      entries: z.number().int().min(0),
    }),
  ]),
  z.strictObject({ kind: z.literal("instruction"), id: z.enum(["continue", "impersonate"]) }),
  // The user message strict post-processing puts before an opening reply.
  z.strictObject({ kind: z.literal("placeholder") }),
  // The event rolled for this reply, always its own message.
  z.strictObject({ kind: z.literal("event") }),
  // The memory before the history (the notebook and the episodes that fit), and recalled episodes in the chat.
  z.discriminatedUnion("part", [
    z.strictObject({
      kind: z.literal("memory"),
      part: z.literal("story"),
      notebook: z.boolean(),
      episodes: z.number().int().min(0),
    }),
    z.strictObject({
      kind: z.literal("memory"),
      part: z.literal("recalled"),
      episodes: z.number().int().min(0),
      depth: z.number().int().min(0),
    }),
  ]),
]);

export type PromptSource = z.infer<typeof promptSourceSchema>;

/** The sampler values sent as AI SDK call settings; absent ones were left to the model. */
const callSettingsSchema = z.strictObject({
  maxOutputTokens: z.number().exactOptional(),
  temperature: z.number().exactOptional(),
  topP: z.number().exactOptional(),
  frequencyPenalty: z.number().exactOptional(),
  presencePenalty: z.number().exactOptional(),
  seed: z.number().exactOptional(),
  reasoning: z.enum(REASONING_EFFORTS).exactOptional(),
});
export type CallSettings = z.infer<typeof callSettingsSchema>;

const count = z.number().int().min(0);

const reportText = z.string().max(LOREBOOK_RULES.reportText);
const lorebookStatusSchema = z.enum(LOREBOOK_STATUSES);
/**
 * The secondary keys that decided an activation, with their logic: the
 * matched ones for AND logics, the absent ones (`matched` empty) for NOT
 * logics. Both are present whenever secondary keys applied.
 */
const secondaryReason = {
  logic: z.enum(ENTRY_LOGICS).exactOptional(),
  secondary: z
    .array(z.strictObject({ key: reportText, matched: reportText }))
    .max(CARD_LIMITS.tags)
    .exactOptional(),
};
/** An entry's trigger chance, in percent, when one was rolled. */
const chanceReason = { chance: count.max(99).exactOptional() };

/**
 * Which lorebook entries one request sent and why the others were left out.
 * Chat content, like the rest of the inspected prompt. A character's books
 * are activated as one combined list: the sources' entries concatenated in
 * order. Every entry index here (an entry's `index`, a recursed reason's
 * `from`, a key problem's `index`) is an index into that list; with the card's
 * book alone it is the index in that book. `entryOrigin` (lorebook/combine.ts)
 * turns it into a source and the index inside that source's book.
 */
export const lorebookReportSchema = z.strictObject({
  /** The first source's scan depth; an entry reading another depth says so. */
  scanDepth: count,
  /** Turns actually scanned (fewer than the depth in a short chat). */
  scannedTurns: count,
  /** Scan passes run: 1 without recursion, then one per recursive pass. */
  passes: count,
  budget: count,
  /** Tokens of the sent entries' texts. */
  used: count,
  /**
   * The books, in combined order: the card's own first (id null), then the
   * linked library books in link order, each with its number of entries.
   */
  sources: z
    .array(
      z.strictObject({
        id: z.uuid().nullable(),
        name: reportText,
        count: count.max(CARD_LIMITS.lorebookEntries),
      }),
    )
    .max(LOREBOOK_LINKS + 1),
  /** At most `LOREBOOK_RULES.reportEntries` per status, in combined order. */
  entries: z
    .array(
      z.strictObject({
        index: count,
        title: reportText,
        /** The entry's native placement. */
        placement: z.enum(ENTRY_PLACEMENTS),
        /** Where in the chat, for placement `depth`. */
        depth: count.exactOptional(),
        role: promptRoleSchema.exactOptional(),
        /** The scan depth the entry reads (its own, else its book's), when it differs from `scanDepth`. */
        scanDepth: count.exactOptional(),
        status: lorebookStatusSchema,
        /** The pass that activated the entry: 0 for the chat, then each recursive pass. */
        pass: count.exactOptional(),
        /**
         * Why an activated entry went in: always on, or the key and the text it
         * matched, with the secondary keys' logic and the keys that decided it;
         * `recursed` when it needed the text of the entry `from`. `chance` is
         * the trigger chance it was rolled against, in percent: passed when
         * sent, lost for `chanceMissed`; for a `sticky` entry, the chance it
         * was kept in without rolling.
         */
        reason: z
          .discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("constant"), ...chanceReason }),
            z.strictObject({ kind: z.literal("sticky"), left: count, ...chanceReason }),
            z.strictObject({
              kind: z.literal("key"),
              key: reportText,
              matched: reportText,
              ...secondaryReason,
              ...chanceReason,
            }),
            z.strictObject({
              kind: z.literal("recursed"),
              key: reportText,
              matched: reportText,
              from: count,
              ...secondaryReason,
              ...chanceReason,
            }),
          ])
          .exactOptional(),
        /** Messages left on cooldown. */
        left: count.exactOptional(),
        /** The chat length a delayed entry waits for. */
        until: count.exactOptional(),
        /**
         * For `poolLost`: the event pool that dropped it and, when there is
         * one, the entry holding that pool for the request.
         */
        pool: z.strictObject({ name: reportText, holder: count.exactOptional() }).exactOptional(),
        /** For entries in the budget fit: sent, doesNotFit and afterCutoff. */
        tokens: count.exactOptional(),
      }),
    )
    .max(LOREBOOK_RULES.reportEntries * LOREBOOK_STATUSES.length),
  /** Every status's full count, including entries beyond those listed. */
  counts: z.record(lorebookStatusSchema, count),
  /** Keys that can never match, at most `LOREBOOK_RULES.reportKeyProblems`. */
  keyProblems: z
    .array(
      z.strictObject({
        index: count,
        key: reportText,
        problem: z.enum([...KEY_PROBLEMS, "tooLong"]),
      }),
    )
    .max(LOREBOOK_RULES.reportKeyProblems),
});
export type LorebookReport = z.infer<typeof lorebookReportSchema>;

export const inspectedPromptSchema = z.strictObject({
  model: z.string(),
  mode: generationModeSchema,
  generationType: generationTypeSchema.exactOptional(),
  macroState: macroStateSchema.exactOptional(),
  firstIncludedMessageId: z.number().int().min(0).exactOptional(),
  messages: z.array(
    z.strictObject({
      role: promptRoleSchema,
      content: z.string(),
      /** Estimated, calibrated by the model's last count. */
      tokens: count,
      source: promptSourceSchema,
      /** Other sources merged into this message by post-processing. */
      merged: z.array(promptSourceSchema).exactOptional(),
    }),
  ),
  /** The model's prompt post-processing, applied to `messages`. */
  processing: z.enum(PROMPT_PROCESSING),
  settings: callSettingsSchema,
  /** The preset's effort when the model does not offer it, so none was sent. */
  reasoningNotOffered: z.enum(REASONING_EFFORTS).nullable(),
  /** The window the prompt is fitted to (`effectiveWindow`). */
  window: effectiveWindowSchema,
  /** Tokens kept for the reply. */
  reserve: count,
  estimate: count,
  history: z.strictObject({ sent: count, total: count }),
  /**
   * The held memories this prompt folded, oldest first, and the turns they
   * covered: those turns left the history (`history` counts what is left)
   * and the memories joined the story block. Absent when none folded. Chat
   * content, like the prompt.
   */
  memoryFold: z.strictObject({ spans: count, turns: count }).exactOptional(),
  examples: z.strictObject({ sent: count, total: count }),
  /** How history was trimmed: per message, in blocks, or per message within one oversized block. */
  trimming: z.enum(TRIMMINGS),
  /** Which lorebook entries went in and why; null without a lorebook. */
  lorebook: lorebookReportSchema.nullable(),
  /**
   * The lorebooks' timed state for the next request; null without a book.
   * Chat content, like the report.
   */
  lorebookState: lorebookStateSchema.nullable(),
  /**
   * Which events fired where, for the next request; left out when there is
   * nothing to carry (no character, or no event fired), which the next
   * request reads as none. Chat content, like the lorebook's state.
   */
  eventsState: eventsStateSchema.optional(),
});
export type InspectedPrompt = z.infer<typeof inspectedPromptSchema>;

/**
 * What the model counted for a request, from streamed usage: its input tokens
 * and how many of them the provider read from its prompt cache, then the
 * tokens it wrote and how many of those were reasoning. A provider that
 * reports no cache figure leaves it unknown; output figures it does not report are
 * left out. Tab memory only, like the prompt.
 */
export const promptUsageSchema = callUsageSchema.required({ inputTokens: true });
export type PromptUsage = z.infer<typeof promptUsageSchema>;
