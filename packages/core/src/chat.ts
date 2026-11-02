import { z } from "zod";
import { castRegisterSchema } from "./cast/register.ts";
import { MAX_CHAT_BODY_BYTES, MAX_CHAT_TURNS } from "./chat-limits.ts";
import { eventsStateSchema } from "./events/state.ts";
import { lorebookStateSchema } from "./lorebook/timed.ts";
import { chatMemoryStateSchema } from "./memory/state.ts";
import { withoutHighlights } from "./preset/highlight.ts";
import { generationTypeSchema, PRESET_LIMITS } from "./preset/prompt.ts";
import { macroStateSchema } from "./prompt/macro-state.ts";
import { isTimeZone } from "./prompt/macros.ts";

export { MAX_CHAT_BODY_BYTES, MAX_CHAT_TURNS };
/** A model id, as every request, setting and record carries it. */
export const modelIdSchema = z.string().min(1).max(200);

const chatRoleSchema = z.enum(["user", "assistant"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

/**
 * The story's two speakers, as `{{user}}` and `{{char}}` name them: the
 * user's persona (`NO_PERSONA_NAME` without one) and the character.
 */
export interface SpeakerNames {
  user: string;
  char: string;
}

/**
 * The name a turn speaks under, in generation and memory canon alike: its
 * own, else the persona's for a user turn and the character's for any other.
 */
export const speakerOf = (
  turn: { role: string; name?: string | undefined },
  names: SpeakerNames,
): string => turn.name ?? (turn.role === "user" ? names.user : names.char);

/** One turn of the conversation as sent to the server. Chat content: never persist. */
export const chatTurnSchema = z
  .strictObject({
    role: chatRoleSchema,
    content: z.string(),
    /** Speaker at the time of this turn, retained in tab/request memory only. */
    name: z.string().max(PRESET_LIMITS.nameLength).exactOptional(),
    /** True only for raw generated replies; filled greetings, user turns and edits stay literal. */
    macroEligible: z.boolean().exactOptional(),
    /** Filled text shown in the tab, used only for scanning; never evaluated again. */
    scanText: z.string().exactOptional(),
    /** Literal edited prefix before the raw generated suffix, in string code units. */
    macroPrefixLength: z.number().int().min(0).exactOptional(),
    /** A reply's reasoning; sent to the model only when the prompt preset adds it. */
    reasoning: z.string().exactOptional(),
  })
  .refine((turn) => turn.macroEligible !== true || turn.role === "assistant", {
    message: "Only generated assistant text can be expanded again.",
    path: ["macroEligible"],
  })
  .refine(
    (turn) =>
      turn.scanText === undefined || (turn.role === "assistant" && turn.macroEligible === true),
    { message: "Only generated assistant text can supply scan text.", path: ["scanText"] },
  )
  .refine(
    (turn) =>
      turn.macroPrefixLength === undefined ||
      (turn.role === "assistant" &&
        turn.macroEligible === true &&
        turn.macroPrefixLength <= turn.content.length),
    {
      message: "A literal prefix requires generated assistant text and must fit its content.",
      path: ["macroPrefixLength"],
    },
  );
export type ChatTurn = z.infer<typeof chatTurnSchema>;

/** Story text for key matching, with no macro evaluation or effects. */
export const scanTextOf = (turn: Pick<ChatTurn, "content" | "scanText">): string =>
  withoutHighlights(turn.scanText ?? turn.content);

/** The browser's clock and time zone, for `{{time}}` and `{{date}}`. */
export const clockSchema = z.strictObject({
  now: z.number().int().min(0).max(8.64e15),
  timeZone: z.string().max(64).refine(isTimeZone, "unknown time zone"),
});
export type Clock = z.infer<typeof clockSchema>;

/**
 * A chat's pick seed for `{{pick}}`: a uint32 the tab makes when the chat
 * starts and again on Clear. Chat metadata: carried by each request, never kept.
 */
const pickSeedSchema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 32 - 1);

/**
 * What a generation writes: the next reply, more of the last reply, or the
 * user's next message for the composer.
 */
const GENERATION_MODES = ["reply", "continue", "impersonate"] as const;
export const generationModeSchema = z.enum(GENERATION_MODES);
export type GenerationMode = z.infer<typeof generationModeSchema>;

/** The widest alternate index a request carries. */
export const MAX_SWIPE_ID = 1_000;

/** Browser-owned macro inputs; no process or persistence state. */
const macroRuntimeSchema = z.strictObject({
  firstIncludedMessageId: z.number().int().min(0).max(MAX_CHAT_TURNS).exactOptional(),
  firstDisplayedMessageId: z.number().int().min(0).max(MAX_CHAT_TURNS).exactOptional(),
  currentSwipeId: z.number().int().min(0).max(MAX_SWIPE_ID).exactOptional(),
  lastSwipeId: z.number().int().min(0).max(MAX_SWIPE_ID).exactOptional(),
  isMobile: z.boolean().exactOptional(),
  idleDuration: z.string().max(256).exactOptional(),
  input: z.string().max(PRESET_LIMITS.blockText).exactOptional(),
});
export type MacroRuntime = z.infer<typeof macroRuntimeSchema>;

/** What the saved settings choose for a reply; absent ids mean none (or the model's defaults). */
const selection = {
  model: modelIdSchema,
  macroState: macroStateSchema.optional(),
  macroRuntime: macroRuntimeSchema.optional(),
  generationType: generationTypeSchema.optional(),
  /** The sampler preset whose set values apply to this reply. */
  samplerPresetId: z.uuid().optional(),
  /** The prompt preset that builds the prompt; without it, the built-in default. */
  promptPresetId: z.uuid().optional(),
  characterId: z.uuid().optional(),
  personaId: z.uuid().optional(),
  clock: clockSchema,
  pickSeed: pickSeedSchema,
  /** The lorebook's timed effects the last reply left; chat content, never kept. */
  lorebookState: lorebookStateSchema.optional(),
  /** Which events fired where, as the last reply left it; chat content, never kept. */
  eventsState: eventsStateSchema.optional(),
  /** This chat's episodes, in order, for a character with memory on; chat content, never kept. */
  memoryState: chatMemoryStateSchema.optional(),
  /** The chat's cast register as it stands, removed entries left out; chat content, never kept. */
  cast: castRegisterSchema.optional(),
};

/**
 * Held memories lead the history: their turns are the request's first
 * messages, so together they never outnumber them.
 */
function heldWithinMessages(
  ctx: z.core.ParsePayload<{
    messages: unknown[];
    memoryState?: { held: { turns: number }[] } | undefined;
  }>,
) {
  const held = ctx.value.memoryState?.held ?? [];
  const turns = held.reduce((total, span) => total + span.turns, 0);
  if (turns > ctx.value.messages.length) {
    ctx.issues.push({
      code: "custom",
      message: "Held memories cover more turns than the request sends.",
      input: ctx.value,
      path: ["memoryState", "held"],
    });
  }
}

/**
 * One generation. A reply answers the user's last turn; Continue extends the
 * last reply, so it must end with a non-empty one; Impersonate writes the
 * user's next message after whatever came last, even in an empty chat.
 */
export const generateRequestSchema = z
  .strictObject({
    ...selection,
    /** The chat's cache affinity id; chat metadata, tab memory only. */
    cacheKey: z.uuid().optional(),
    mode: generationModeSchema.default("reply"),
    messages: z.array(chatTurnSchema).max(MAX_CHAT_TURNS),
  })
  .check((ctx) => {
    const { mode, messages, generationType } = ctx.value;
    if (
      generationType !== undefined &&
      (mode === "reply"
        ? generationType === "continue" || generationType === "impersonate"
        : generationType !== mode)
    ) {
      ctx.issues.push({
        code: "custom",
        message: "Generation type does not fit the mode.",
        input: ctx.value,
        path: ["generationType"],
      });
    }
    const last = messages.at(-1);
    const fits =
      mode === "impersonate" ||
      (mode === "reply"
        ? last?.role === "user"
        : last?.role === "assistant" && last.content !== "");
    if (!fits) {
      ctx.issues.push({
        code: "custom",
        message: "The last turn does not fit the mode.",
        input: ctx.value,
        path: ["messages"],
      });
    }
    heldWithinMessages(ctx);
  });
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

/** A dry run: the chat so far, with the draft as its last turn when there is one. */
export const previewRequestSchema = z
  .strictObject({
    ...selection,
    messages: z.array(chatTurnSchema).max(MAX_CHAT_TURNS),
  })
  .refine(
    (value) => value.generationType !== "continue" && value.generationType !== "impersonate",
    { message: "Preview requires a reply generation type.", path: ["generationType"] },
  )
  .check(heldWithinMessages);
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

/** Why the server would not build a prompt; the web app explains each one. */
const PROMPT_REFUSALS = ["context_window_unknown", "prompt_too_long"] as const;
export const refusalCodeSchema = z.enum(PROMPT_REFUSALS);
export type RefusalCode = z.infer<typeof refusalCodeSchema>;

/**
 * The model's provider stayed busy (429 or 503) through the server's
 * retries: a code of every model call's failure, content-free.
 */
export const UPSTREAM_BUSY = "upstream_busy" as const;
/** The longest wait, in seconds, a provider's request to wait is taken as. */
export const MAX_RETRY_AFTER_S = 86_400;
/** Seconds the provider asked to wait before another try, when it said. */
export const retryAfterSchema = z.number().int().nonnegative().max(MAX_RETRY_AFTER_S);

/** The refusals every bounded model-call route shares: the prompt's two and a busy provider. */
export const COMMON_REFUSALS = [...PROMPT_REFUSALS, UPSTREAM_BUSY] as const;

/** A model-call route's refusal body: one of its `codes`, or the request outliving its deadline. */
export const refusalBodySchema = <const T extends readonly [string, ...string[]]>(codes: T) =>
  z.object({
    error: z.enum([...codes, "request_timeout"]),
    /** With `upstream_busy`, when the provider said how long to wait. */
    retryAfterS: retryAfterSchema.exactOptional(),
  });

/**
 * The chat stream's data parts, both transient: the exact prompt sent, for
 * the inspector (`inspectedPromptSchema`), and the reply's call accounting
 * (`callAccountingSchema`).
 */
export const CHAT_DATA_PARTS = { prompt: "data-prompt", usage: "data-usage" } as const;

/** Why a chat stream ended in an error: its error part's text. */
export const streamFailureSchema = z.enum(["generation_failed", UPSTREAM_BUSY]);
export type StreamFailure = z.infer<typeof streamFailureSchema>;

/**
 * Joins a native continuation, discarding a full echo. While streaming, a
 * possible echo stays buffered; on completion, a shorter prefix is real text.
 * Already extracted or filled suffixes pass echo: false to join only once.
 * Whitespace and opening punctuation join directly; other text gains a space.
 */
export function joinContinuation(
  text: string,
  continuation: string,
  { echo = true, streaming = false }: { echo?: boolean; streaming?: boolean } = {},
): string {
  if (echo) {
    const original = text.trimEnd();
    if (streaming && text.startsWith(continuation)) return text;
    if (text !== "" && continuation.startsWith(text))
      continuation = continuation.slice(text.length);
    else if (original !== "" && continuation.startsWith(original)) {
      continuation = continuation.slice(original.length);
      if (/\s$/.test(text)) continuation = continuation.replace(/^[ \t]+/, "");
    }
  }
  if (continuation === "") return text;
  const spaced = text === "" || /\s$/.test(text) || /^[\s,.;:!?)\]}…]/.test(continuation);
  return spaced ? text + continuation : `${text} ${continuation}`;
}
