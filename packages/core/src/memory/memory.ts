import { z } from "zod";
import { isRecord } from "../card/json.ts";
import { memoryCastContextSchema } from "../cast/effective.ts";
import {
  COMMON_REFUSALS,
  chatTurnSchema,
  MAX_CHAT_TURNS,
  modelIdSchema,
  refusalBodySchema,
} from "../chat.ts";
import { formatLocationLine } from "../creator/location.ts";
import { REASONING_EFFORTS } from "../preset/index.ts";
import { revisionSchema, storedFields, withRevision } from "../revision.ts";
import { callAccountingSchema } from "../usage.ts";
import { readMemoryCastLine } from "./cast.ts";
import { clampKeys, clampLines, clampText } from "./clamp.ts";
import { MEMORY_LIMITS } from "./limits.ts";
import { chatMemoryStateSchema, RECAP_IDS } from "./state.ts";

/*
 * A character's memory: one notebook (where things stand) and a book of
 * episodes (what happened, scene by scene). Both are character data,
 * persisted per user and encrypted, written by the memory call and editable
 * by the owner. The span a memory came from, the turns it covered and the
 * chat it belongs to are chat content and never part of it (PRINCIPLES.md 1).
 */

const line = z.string().trim().min(1).max(MEMORY_LIMITS.line);
const castLine = z.string().min(1).max(MEMORY_LIMITS.castLine);
const modelCastLine = castLine.refine((text) => readMemoryCastLine(text) !== null);

/** Where things stand, rewritten whole by every memory call. */
export const memoryNotebookSchema = z.strictObject({
  situation: z.string().trim().max(MEMORY_LIMITS.situation),
  /** Where each pair of people stands, one line per pair. */
  relationships: z.array(line).max(MEMORY_LIMITS.relationships),
  facts: z.array(line).max(MEMORY_LIMITS.facts),
  threads: z.array(line).max(MEMORY_LIMITS.threads),
  cast: z.array(castLine).max(MEMORY_LIMITS.cast).default([]),
});
export type MemoryNotebook = z.infer<typeof memoryNotebookSchema>;
export type NotebookList = Exclude<keyof MemoryNotebook, "situation">;

/** The notebook's lists in the order prompts show them: label, lines and characters per line. */
export const NOTEBOOK_LISTS = {
  relationships: {
    label: "Relationships",
    max: MEMORY_LIMITS.relationships,
    line: MEMORY_LIMITS.line,
  },
  facts: { label: "Facts", max: MEMORY_LIMITS.facts, line: MEMORY_LIMITS.line },
  threads: { label: "Threads", max: MEMORY_LIMITS.threads, line: MEMORY_LIMITS.line },
  cast: { label: "Cast", max: MEMORY_LIMITS.cast, line: MEMORY_LIMITS.castLine },
} as const satisfies Record<NotebookList, { label: string; max: number; line: number }>;
export const NOTEBOOK_LIST_KEYS = Object.keys(NOTEBOOK_LISTS) as NotebookList[];

/**
 * The first message of the next chat: a Location line and one sentence that
 * places the people present where the last span ended. Empty when the call
 * gave none; the card's own greeting then opens the chat.
 */
const opening = z.string().trim().max(MEMORY_LIMITS.opening);

/** A notebook with nothing in it. */
export const emptyNotebook = (): MemoryNotebook => ({
  situation: "",
  relationships: [],
  facts: [],
  threads: [],
  cast: [],
});

const title = z.string().trim().min(1).max(MEMORY_LIMITS.title);
const summary = z.string().trim().min(1).max(MEMORY_LIMITS.summary);
/** A stored summary: a chapter's may be longer than an episode's. */
const storedSummary = z.string().trim().min(1).max(MEMORY_LIMITS.chapterSummary);
const cues = z.array(z.string().trim().min(1).max(MEMORY_LIMITS.cue)).max(MEMORY_LIMITS.cues);

/**
 * One memory written: the episode, the notebook after it and the next chat's
 * opening, as the store keeps them.
 */
export const memoryOutputSchema = z.strictObject({
  title,
  summary,
  cues,
  notebook: memoryNotebookSchema,
  opening,
});
export type MemoryOutput = z.infer<typeof memoryOutputSchema>;

/** A line of a notebook list by its number, as the memory call's message shows it: 1 first. */
const lineNumber = z.number().int().min(1);

/**
 * How one span changes a notebook list: lines rewritten, lines removed and
 * new lines, each empty when nothing changes. Lines it does not name stay
 * word for word.
 */
const listEditsSchema = (max: number, textSchema: z.ZodString | typeof modelCastLine = line) =>
  z.strictObject({
    change: z
      .array(z.strictObject({ line: lineNumber, text: textSchema }))
      .max(max)
      .default([]),
    drop: z.array(lineNumber).max(max).default([]),
    add: z.array(textSchema).max(max).default([]),
  });
type ListEdits = z.infer<ReturnType<typeof listEditsSchema>>;

/**
 * The object the memory call returns: one episode, the situation rewritten
 * whole, the edits of each notebook list (`applyMemoryAnswer`) and the next
 * chat's opening, empty when the answer has none.
 */
export const memoryAnswerSchema = z.strictObject({
  title,
  summary,
  cues,
  notebook: z.strictObject({
    situation: memoryNotebookSchema.shape.situation,
    relationships: listEditsSchema(MEMORY_LIMITS.relationships),
    facts: listEditsSchema(MEMORY_LIMITS.facts),
    threads: listEditsSchema(MEMORY_LIMITS.threads),
    cast: listEditsSchema(MEMORY_LIMITS.cast, modelCastLine).default({
      change: [],
      drop: [],
      add: [],
    }),
  }),
  opening: opening.default(""),
});
export type MemoryAnswer = z.infer<typeof memoryAnswerSchema>;

/**
 * `lines` after `edits`: a dropped line goes, even when also changed; a
 * changed one takes its new text in place; new lines follow, a copy of a
 * kept line skipped, while the list has room. A line number past the list
 * names nothing.
 */
function applyLines(lines: readonly string[], edits: ListEdits, max: number): string[] {
  const dropped = new Set(edits.drop);
  const changed = new Map(edits.change.map(({ line, text }) => [line, text]));
  const kept = lines.flatMap((text, at) =>
    dropped.has(at + 1) ? [] : [changed.get(at + 1) ?? text],
  );
  const known = new Set(kept);
  for (const text of edits.add) {
    if (kept.length >= max) break;
    if (known.has(text)) continue;
    kept.push(text);
    known.add(text);
  }
  return kept;
}

/** The memory a call's `answer` writes over `notebook`, the one its message showed. */
export function applyMemoryAnswer(notebook: MemoryNotebook, answer: MemoryAnswer): MemoryOutput {
  const { title, summary, cues, notebook: edits, opening } = answer;
  const L = MEMORY_LIMITS;
  return {
    title,
    summary,
    cues,
    notebook: {
      situation: edits.situation,
      relationships: applyLines(notebook.relationships, edits.relationships, L.relationships),
      facts: applyLines(notebook.facts, edits.facts, L.facts),
      threads: applyLines(notebook.threads, edits.threads, L.threads),
      cast: applyLines(notebook.cast, edits.cast, L.cast),
    },
    opening,
  };
}

/** The chapter a chapter call writes: several episodes merged into one. */
export const chapterOutputSchema = z.strictObject({ title, summary: storedSummary, cues });
export type ChapterOutput = z.infer<typeof chapterOutputSchema>;

/**
 * The object the chapter call returns, its summary not yet held to a bound,
 * so one past its room is asked to compress rather than cut (`chapterRoom`).
 */
export const chapterAnswerSchema = chapterOutputSchema.extend({
  summary: z.string().trim().min(1),
});

const L = MEMORY_LIMITS;
/** An episode's or a chapter's keys, its summary cut to `summary` characters. */
const episodeShape = (summary: number) => ({
  title: (field: unknown) => clampText(field, L.title),
  summary: (field: unknown) => clampText(field, summary),
  cues: (field: unknown) => clampLines(field, L.cue, L.cues),
});

/** A list's edits within bounds: texts cut, blank ones and their changes dropped, lists sliced. */
const clampEdits =
  (count: number) =>
  (value: unknown): unknown =>
    clampKeys(value, {
      change: (changes) =>
        Array.isArray(changes)
          ? changes
              .map((change) =>
                clampKeys(change, {
                  line: (at) => at,
                  text: (text) => clampText(text, L.line),
                }),
              )
              .filter((change) => !isRecord(change) || change.text !== "")
              .slice(0, count)
          : changes,
      drop: (lines) => (Array.isArray(lines) ? lines.slice(0, count) : lines),
      add: (lines) => clampLines(lines, L.line, count),
    });

/** Optional model cast edits fail individually; JSON is validated whole, never cut. */
const clampCastEdits = (value: unknown): unknown => {
  const edits = isRecord(value) ? value : {};
  return {
    change: Array.isArray(edits.change)
      ? edits.change
          .filter(
            (change) =>
              isRecord(change) &&
              lineNumber.safeParse(change.line).success &&
              modelCastLine.safeParse(change.text).success,
          )
          .map((change) => ({ line: change.line, text: change.text }))
          .slice(0, L.cast)
      : [],
    drop: Array.isArray(edits.drop)
      ? edits.drop.filter((line) => lineNumber.safeParse(line).success).slice(0, L.cast)
      : [],
    add: Array.isArray(edits.add)
      ? edits.add.filter((line) => modelCastLine.safeParse(line).success).slice(0, L.cast)
      : [],
  };
};

/**
 * A next chat's opening as a model wrote it: its Location line set first
 * (`formatLocationLine`), as the creator sets a card's, then cut to its
 * bound. A null opening is none, as a missing one is.
 */
const clampOpening = (field: unknown): unknown =>
  field === null
    ? ""
    : typeof field === "string"
      ? clampText(formatLocationLine(field), L.opening)
      : field;

/**
 * A memory call's answer, parsed from JSON, brought within `MEMORY_LIMITS`:
 * strings cut at a word break, lists sliced, blank lines dropped, keys the
 * schema does not name stripped, the opening as `clampOpening` sets it.
 * What it cannot mend (a missing key, a
 * value of another type, an empty title) still fails `memoryAnswerSchema`.
 */
export const clampMemoryAnswer = (value: unknown): unknown =>
  clampKeys(value, {
    ...episodeShape(L.summary),
    notebook: (field) =>
      clampKeys(field, {
        situation: (text) => clampText(text, L.situation),
        relationships: clampEdits(L.relationships),
        facts: clampEdits(L.facts),
        threads: clampEdits(L.threads),
        cast: clampCastEdits,
      } satisfies Record<keyof MemoryNotebook, (value: unknown) => unknown>),
    opening: clampOpening,
  });

/** The object the opening call returns: the next chat's opening alone, never empty. */
export const openingAnswerSchema = z.strictObject({ opening: opening.min(1) });

/**
 * An opening call's answer brought within `MEMORY_LIMITS` as a memory
 * call's opening is (`clampOpening`), keys the schema does not name
 * stripped. A missing or blank opening still fails `openingAnswerSchema`.
 */
export const clampOpeningAnswer = (value: unknown): unknown =>
  clampKeys(value, { opening: clampOpening });

/**
 * A chapter call's answer brought within `MEMORY_LIMITS`, as
 * `clampMemoryAnswer` does, its summary cut to `summary` characters (none
 * cut with `Infinity`).
 */
export const clampChapterOutput = (value: unknown, summary: number = L.chapterSummary): unknown =>
  clampKeys(value, episodeShape(summary));

/** What the owner edits of an episode. */
export const episodeFieldsSchema = z.strictObject({
  title,
  summary: storedSummary,
  cues,
  /** Always recalled, whatever the chat is about. */
  pinned: z.boolean(),
});
export type EpisodeFields = z.infer<typeof episodeFieldsSchema>;

const EPISODE_KINDS = ["episode", "chapter"] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

/** One episode as the API returns it. A chapter's summary merges older episodes. */
export const storedEpisodeSchema = episodeFieldsSchema.extend({
  id: z.uuid(),
  characterId: z.uuid(),
  /** Per character, ascending in the order episodes were written. */
  seq: z.number().int().min(0),
  kind: z.enum(EPISODE_KINDS),
  /** How many turns the span covered; a chapter, the sum of its members'. */
  turns: z.number().int().min(0),
  /** The chapter that absorbed this episode, once one did. */
  chapterId: z.uuid().nullable(),
  ...storedFields,
});
export type StoredEpisode = z.infer<typeof storedEpisodeSchema>;

/**
 * A character's notebook row: memory is on while `enabled` is true, and the
 * next chat's opening sits beside the notebook. A character gets its row
 * with the first write that needs one; until then it has none, and memory is
 * on (`memoryIsOn`).
 */
export const memoryStateSchema = z.strictObject({
  enabled: z.boolean(),
  notebook: memoryNotebookSchema,
  /** Legacy alias conversion can widen a saved opening beyond the public write bound. */
  opening: z.string(),
  revision: revisionSchema,
  updatedAt: z.number().int(),
});
export type MemoryState = z.infer<typeof memoryStateSchema>;

/**
 * Memory is on for every character until its owner turns it off: the one
 * owner of this default, for a character without a row and a row's first write.
 */
export const MEMORY_ON_BY_DEFAULT = true;

/**
 * Whether memory is on for a character, from its notebook row as loaded:
 * a character with no row (`null`) reads as `MEMORY_ON_BY_DEFAULT`.
 */
export const memoryIsOn = (state: Pick<MemoryState, "enabled"> | null): boolean =>
  state === null ? MEMORY_ON_BY_DEFAULT : state.enabled;

/**
 * A character's notebook row as loaded, or what a character without one
 * reads as: on, an empty notebook and no opening, revision 0 (the first write creates the
 * row at revision 1, as the first edit of a row at revision 0 would).
 */
export const memoryStateOf = (state: MemoryState | null): MemoryState =>
  state ?? {
    enabled: MEMORY_ON_BY_DEFAULT,
    notebook: emptyNotebook(),
    opening: "",
    revision: 0,
    updatedAt: 0,
  };

/**
 * A PATCH body for the notebook row: any part, the notebook whole, and the
 * revision it was made against; a part left out stays as stored.
 */
export const memoryStatePatchRequestSchema = withRevision(
  z.strictObject({
    enabled: z.boolean().optional(),
    notebook: memoryNotebookSchema.optional(),
    opening: opening.exactOptional(),
  }),
);
export type MemoryStatePatchRequest = z.infer<typeof memoryStatePatchRequestSchema>;

/** A PATCH body for an episode: any of its fields, and the revision they were made against. */
export const episodePatchRequestSchema = withRevision(episodeFieldsSchema.partial());

/**
 * One memory call: the span to remember (chat content, for this request
 * only), this chat's episodes in order, and an attempt id the tab draws per
 * call so a retry after a lost answer gets the same memory back.
 */
export const rememberRequestSchema = z.strictObject({
  characterId: z.uuid(),
  personaId: z.uuid().exactOptional(),
  model: modelIdSchema,
  reasoning: z.enum(REASONING_EFFORTS).exactOptional(),
  /**
   * At least one: an ordinary call takes two or more, and a chat's ending
   * may leave a single turn after the call before it.
   */
  turns: z.array(chatTurnSchema).min(1).max(MAX_CHAT_TURNS),
  /** Effective cast at/before the span boundary; input only, never automatically persisted. */
  castContext: memoryCastContextSchema.exactOptional(),
  /** This chat's folded episodes, as a request's `memoryState.recap`. */
  episodes: chatMemoryStateSchema.shape.recap,
  /** The memories this chat holds, oldest first, before the span: ids only. */
  held: z.array(z.uuid()).max(RECAP_IDS),
  attempt: z.uuid(),
});
export type RememberRequest = z.infer<typeof rememberRequestSchema>;

/**
 * The memory written, the notebook after it, and this chat's folded
 * episodes from now on: the new one is held apart, never among them.
 */
export const rememberResponseSchema = z.strictObject({
  accounting: callAccountingSchema.exactOptional(),
  episode: storedEpisodeSchema,
  notebook: memoryStateSchema,
  recap: chatMemoryStateSchema.shape.recap,
  /** The chapter a roll-up wrote, when the recap grew past its budget. */
  chapter: storedEpisodeSchema.exactOptional(),
});
export type RememberResponse = z.infer<typeof rememberResponseSchema>;

/**
 * One opening call: the next chat's opening written from what the
 * character remembers, with the memory model and its effort, the persona
 * named for the call as a memory call names it.
 */
export const openingRequestSchema = z.strictObject({
  personaId: rememberRequestSchema.shape.personaId,
  model: rememberRequestSchema.shape.model,
  reasoning: rememberRequestSchema.shape.reasoning,
});
export type OpeningRequest = z.infer<typeof openingRequestSchema>;

/** The opening written, the persona as `{{user}}`; nothing of it is stored until the owner saves it. */
export const openingResponseSchema = z.strictObject({
  opening,
  accounting: callAccountingSchema.exactOptional(),
});
export type OpeningResponse = z.infer<typeof openingResponseSchema>;

/** Why the server wrote no memory for a remember request, as its body names it. */
export const MEMORY_REFUSALS = [
  "memory_off",
  ...COMMON_REFUSALS,
  /** The character's book is full. */
  "too_many_memories",
  /** This chat's list of episodes is full. */
  "too_many_chat_memories",
  "memory_failed",
] as const;
export type MemoryRefusal = (typeof MEMORY_REFUSALS)[number];

/** A remember refusal's body: one of the reasons, or the request outliving its deadline. */
export const rememberRefusalSchema = refusalBodySchema(MEMORY_REFUSALS);

/** Why the server wrote no opening for an opening request, as its body names it. */
export const OPENING_REFUSALS = [
  "memory_off",
  ...COMMON_REFUSALS,
  /** No notebook content and no memories: nothing to write it from. */
  "nothing_to_remember",
  "memory_failed",
] as const;
export type OpeningRefusal = (typeof OPENING_REFUSALS)[number];

/** An opening refusal's body: one of the reasons, or the request outliving its deadline. */
export const openingRefusalSchema = refusalBodySchema(OPENING_REFUSALS);
