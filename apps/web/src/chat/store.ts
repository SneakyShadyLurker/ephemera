import {
  type CallAccounting,
  type CallPurpose,
  type CharacterCard,
  type ChatMemoryState,
  type ChatTurn,
  type Clock,
  castPeopleNotes,
  clipText,
  cloneMacroState,
  type EventsState,
  emptyMacroState,
  estimateTokens,
  eventsAfterDeletion,
  eventsAfterFold,
  eventsAfterInsertion,
  eventsAfterTruncation,
  fillChatText,
  type GenerateRequest,
  type GenerationMode,
  type GenerationType,
  type GreetingKey,
  humanizeIdleDuration,
  type InspectedPrompt,
  joinContinuation,
  type LorebookState,
  lorebookStateAfterFold,
  MAX_CHAT_BODY_BYTES,
  MAX_CHAT_TURNS,
  MAX_SWIPE_ID,
  type MacroInput,
  MacroLimitError,
  type MacroRuntime,
  type MacroState,
  MEMORY_GREETING,
  MEMORY_LIMITS,
  type MemoryState,
  memoryModelOf,
  PRESET_LIMITS,
  type PreviewRequest,
  type PromptPreset,
  type PromptReasoning,
  type ReasoningEffort,
  type RefusalCode,
  type RememberRequest,
  randomSeed,
  randomUniform,
  reasoningSentBack,
  type Settings,
} from "@ephemera/core";
import { createStore } from "zustand/vanilla";
import type { RememberFailure, RememberOutcome } from "../memory/queries.ts";
import {
  type CastDeps,
  type CastSliceState,
  type CastTaken,
  createCastSlice,
  currentRegister,
  EMPTY_CAST,
  memoryContextAt,
  registerAt,
} from "./cast-slice.ts";
import { createSceneSlice, type SceneDeps, type SceneSliceState } from "./scene-slice.ts";
import type { PartialReplyFinishReason, PreviewResult, ReplyUpdate } from "./transport.ts";
import {
  emptyUsage,
  finishUsage,
  receiveUsage,
  startUsage,
  type UsageHandle,
  type UsageLedger,
} from "./usage.ts";

export type MessageStatus = "complete" | "streaming" | "stopped" | "failed" | "waiting";

/** One alternate reply (a swipe). Chat content: lives only in this in-memory store (PRINCIPLES.md 1). */
export interface Reply {
  id: string;
  /** What the thread shows: the model's text with its macros filled once, when it ended. */
  text: string;
  /**
   * The text as the model (or the card) wrote it, when filling its macros
   * changed it. A generated reply's request sends this one; a greeting's stays
   * in the tab and goes as shown. An edit makes the edited text both.
   */
  rawText?: string;
  /**
   * The model wrote it, or wrote what a Continue added after it was edited:
   * each later generation fills its macros again from the
   * history. An edit takes it away.
   */
  generated?: true;
  /**
   * How much of the text the request sends is the edited text a Continue
   * followed, with the join after it: sent as written, never filled. Only
   * what the model added is filled again.
   */
  macroPrefixLength?: number;
  /** A greeting's macro state, filled from the state before any greeting; committed when it is shown. */
  macroState?: MacroState;
  /**
   * Which greeting this is (core's `GreetingKey`): the memory's opening or
   * one of the card's. A refill keeps the shown one by it; an edit keeps it.
   */
  greetingKey?: string;
  /** The model's reasoning; sent back only when the prompt preset says so. */
  reasoning: string;
  /** How long the model reasoned before it wrote, on the browser's clock; null without reasoning. */
  thoughtMs: number | null;
  status: MessageStatus;
  /** A partial ending reported by the provider, independent for each alternate. */
  finishReason?: PartialReplyFinishReason;
  /** Why the server would not build the prompt, when it refused. */
  refusal?: RefusalCode;
  /** It failed because the model's provider stayed busy through the server's retries. */
  busy?: true;
  /** The last Continue or Replace failed; the reply is as it was before it. */
  failed?: "continue" | "replace";
  /**
   * How long the model took to write when it reasoned without showing its
   * reasoning (a reasoning effort was sent, none came back); for Show Hidden.
   */
  hiddenMs?: number;
  /**
   * One more each time its text changes in place (an edit, a Continue, a
   * greeting refill), so a cast keeper answer for an older text is dropped;
   * 0 when absent.
   */
  castVersion?: number;
}

interface UserMessage {
  id: string;
  role: "user";
  /** The message as sent: the draft with its macros filled once. */
  text: string;
  /** The persona it was sent as, so a later change does not rewrite its cue. */
  personaId: string | null;
  /** The speaker's name when it was sent, so a renamed or deleted persona keeps it; sent with the turn. */
  name?: string;
  /** When it was sent, on the browser's clock, for `{{idle_duration}}`. */
  sentAt: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  /** The card's greetings, when this is the chat's opening message. */
  greeting: boolean;
  /** A greeting the user edited is no longer refilled from the card. */
  edited: boolean;
  replies: Reply[];
  /** The alternate on screen, and the one sent as the turn. */
  shown: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

/** Messages deleted together, or one alternate of a reply. */
export type Deleted =
  | {
      kind: "messages";
      messages: ChatMessage[];
      index: number;
      /** The events state before the deletion moved it; Undo puts it back. */
      eventsState?: EventsState | null;
      /** What the deletion took of the cast; Undo puts it back. */
      cast?: CastTaken;
    }
  | {
      kind: "alternate";
      messageId: string;
      reply: Reply;
      index: number;
      cast?: CastTaken;
    };

export type EditTarget = "text" | "reasoning";

export const shownReply = (message: AssistantMessage): Reply =>
  message.replies[message.shown] ?? (message.replies[0] as Reply);

/** Yields the reply so far, update by update; throws when generation fails. */
export type StreamReply = (
  request: GenerateRequest,
  signal: AbortSignal,
) => AsyncIterable<ReplyUpdate>;
export type FetchPreview = (request: PreviewRequest, signal: AbortSignal) => Promise<PreviewResult>;

/** What the saved settings choose for the next reply; read when sending, never stored here. */
export interface Selection {
  model: string | null;
  samplerPresetId: string | null;
  promptPresetId: string | null;
  characterId: string | null;
  personaId: string | null;
  /**
   * The prompt preset's Add to Prompts, when known: only the reasoning it
   * sends back goes with a request. Unknown sends every reply's reasoning,
   * for the server to choose from.
   */
  reasoning: Pick<PromptReasoning, "addToPrompts" | "maxAdditions"> | null;
}

/** The exact prompt of the last request, for the inspector. Chat content. */
interface LastSent {
  generation?: string;
  prompt: InspectedPrompt;
  sentAt: number;
  /** What the model counted, once the reply finished. */
  inputTokens: number | null;
  /** Of those, how many the provider read from its prompt cache; set with `inputTokens`. */
  cachedTokens: number | null;
  /** What the model wrote; null until the reply finished or when the provider did not say. */
  outputTokens: number | null;
  /** Of `outputTokens`, how many were reasoning; null as `outputTokens`. */
  reasoningTokens: number | null;
  /** Who spoke each history turn of the prompt, by its index. */
  speakers: Speaker[];
  /**
   * The leading turns the prompt's fold left out that the tab did not fold
   * (it moved on meanwhile): the prompt's history starts after them.
   */
  foldedTurns: number;
}

export interface Preview {
  status: "idle" | "loading" | "ready" | "failed" | RefusalCode;
  prompt: InspectedPrompt | null;
  /** The history index of the draft, when the preview includes one. */
  draftIndex: number | null;
}

/**
 * A generation refused as signed out before any of it arrived, run once more
 * after the session is back: a reply into its slot, a continuation of its
 * reply, or Write for me. Chat metadata: tab memory only.
 */
type Pending =
  /**
   * Into the alternate `replyId` of `messageId`: the one a Replace was for, or
   * the new slot; `type` is the action that asked for it.
   */
  | { mode: "reply"; messageId: string; replyId: string; type: ReplyType }
  | { mode: "continue"; messageId: string; replyId: string }
  | { mode: "impersonate" };

/** A Write for me that did not finish; the draft keeps what arrived. */
export type ImpersonationNote = {
  status: "stopped" | "failed";
  refusal?: RefusalCode;
  busy?: true;
} | null;

/** The generation types of a reply: a sent message, a Replace, or a new alternate. */
type ReplyType = Extract<GenerationType, "normal" | "regenerate" | "swipe">;

/**
 * Why nothing was sent: the message's macros went past their limits or left
 * nothing, the character, persona or a preset did not load, the chat or any
 * of them changed meanwhile, or the model has no known context window. The
 * draft stays. Or (`output`) a reply's macros went past their limits when it
 * ended: it stays as the model wrote it, never filled.
 */
export type MacroNotice = "limit" | "empty" | "unavailable" | "changed" | "window" | "output";

/**
 * What the browser's macros read besides the chat: the saved character,
 * persona and prompt preset the selection names, as loaded, the settings
 * that let a card replace the preset's prompts, and the model's runtime.
 * Not chat content.
 */
export interface MacroSubject {
  character: CharacterCard | null;
  persona: { name: string; description: string } | null;
  /** The chosen prompt preset, or the built-in default without one. */
  preset: PromptPreset;
  prefer: Pick<Settings, "preferCharacterPrompt" | "preferCharacterInstructions">;
  /**
   * The model the request goes to, its window and the tokens kept for the
   * reply, as the server resolves them; absent only for a greeting before any
   * request.
   */
  runtime?: NonNullable<MacroInput["runtime"]>;
}

/**
 * Not ok when a chosen entity could not be loaded (other than being gone),
 * the model has no known window, or the settings it reads changed meanwhile.
 */
export type SubjectResult =
  | { ok: true; subject: MacroSubject }
  | { ok: false; reason?: "context_window_unknown" | "changed" };

/** One of a chat's greetings, filled from the state before any greeting. */
export interface GreetingChoice {
  content: string;
  /** The greeting as the card (or the memory) wrote it, kept in the tab only; it is sent as shown. */
  rawText?: string;
  macroState?: MacroState;
  /** Which greeting it is; a refill keeps the one shown by it. */
  key: GreetingKey;
}

const NO_PREVIEW: Preview = { status: "idle", prompt: null, draftIndex: null };

/**
 * One remembered span still in the history, as message indices [from, to)
 * in `messages`, and its memory. Chat content: tab memory only.
 */
interface HeldSpan {
  id: string;
  title: string;
  from: number;
  to: number;
}

/**
 * Where the chat's memory stands: which leading messages are folded into
 * memories, which remembered ones are still sent, and this chat's episodes.
 * Chat content: tab memory only, emptied on Clear; the server keeps only
 * what the memories say.
 */
export interface ChatMemory {
  /** Leading messages folded into memories, as an index in `messages`: requests send only those from it on. */
  horizon: number;
  /**
   * Remembered spans whose turns requests still send, oldest first, each
   * starting where the one before ends, the first at the horizon. A request
   * folds the oldest of them only once the history no longer fits.
   */
  held: HeldSpan[];
  /** Where the span being remembered (or the one that failed) ends, as an index in `messages`. */
  boundary: number | null;
  /** This chat's folded episode ids, in order, chapters replacing their members; sent with each request and preview. */
  recap: string[];
  /**
   * The newest folded memory: its title and the horizon before it, which
   * Forget restores while no memory is held.
   */
  foldedLatest: { id: string; title: string; from: number } | null;
  status: "idle" | "remembering" | "failed";
  /** Why the last call failed, while `status` is failed. */
  failure: RememberFailure | null;
  /**
   * The call running, or the one whose answer was lost: a retry sends its
   * attempt for its span while the remembered end is still `from`, where it started.
   * Its span stays read-only until an answer confirms or refuses it, so a
   * memory the server wrote is answered for the turns it was written from,
   * never written twice; turns after it stay open.
   */
  pending: { attempt: string; boundary: number; from: number } | null;
  /** The folded turns are shown in the thread, read-only. */
  shown: boolean;
}

export const NO_MEMORY: ChatMemory = {
  horizon: 0,
  held: [],
  boundary: null,
  recap: [],
  foldedLatest: null,
  status: "idle",
  failure: null,
  pending: null,
  shown: false,
};

/** Where the remembered messages end, held or folded, as an index in `messages`. */
export const rememberedEnd = (memory: ChatMemory): number =>
  memory.held.at(-1)?.to ?? memory.horizon;

/**
 * The latest memory, which the seam shows, edits and forgets: the newest
 * held one, else the newest folded one; `to` is where its span ends.
 */
export function latestMemory(
  memory: ChatMemory,
): { id: string; title: string; from: number; to: number; held: boolean } | null {
  const last = memory.held.at(-1);
  if (last !== undefined) return { ...last, held: true };
  const folded = memory.foldedLatest;
  return folded === null ? null : { ...folded, to: memory.horizon, held: false };
}

/**
 * Refusals the next settled reply may try again on its own, with a new
 * attempt: the upstream failed, the request timed out, or memory moved
 * under the call (Forget, or off and on again, in another tab). The server
 * says memory_off only when nothing of the attempt stands (a memory it wrote
 * is the answer whatever happened since), so the new attempt never writes
 * the span twice. A memory that is really off reloads as off, and then no
 * call goes out. Every other
 * one (a span the window cannot take, an unknown window) waits for Try
 * again, since another call would fail the same way.
 */
const TRANSIENT_FAILURES: ReadonlySet<RememberFailure> = new Set([
  "memory_failed",
  "upstream_busy",
  "timeout",
  "memory_off",
]);

/**
 * What one memory call came to: `written`; `none`, nothing to remember now;
 * `busy`, a call or a Forget under way, so none went out; `editing`, an open
 * edit in the span, so none went out; `moved`, the remembered turns changed
 * under the call, so nothing was held; `cancelled`, the chat was cleared or
 * memory reset meanwhile; or `failed`, and why.
 */
type RememberRun =
  | { status: "written" | "none" | "busy" | "editing" | "moved" | "cancelled" }
  | { status: "failed"; reason: RememberFailure };

/**
 * How remembering a chat's ending went: `done`, no unremembered turn left;
 * `cancelled`, the chat moved on (cleared, reset) before it was written;
 * `editing`, an open edit among its turns holds it, nothing written; or
 * `failed`, and why, the chat as it was.
 */
type EndingOutcome =
  | { status: "done" | "cancelled" | "editing" }
  | { status: "failed"; reason: RememberFailure };

/** What the chat's memory reads besides the chat: whether it is on, its sizes, and the calls. */
interface MemoryDeps {
  /** Memory is on for the character (core `memoryIsOn`) as last loaded; off while it never loaded. */
  enabled: (characterId: string) => boolean;
  /** The Settings that pace memory calls; a null model or effort is the reply's model and its default (core `memoryModelOf`). */
  settings: () => {
    spanTokens: number;
    keepTurns: number;
    memoryModel: string | null;
    reasoning: ReasoningEffort | null;
  };
  remember: (
    request: RememberRequest,
    signal: AbortSignal,
    onAccounting?: (accounting: CallAccounting) => void,
  ) => Promise<RememberOutcome>;
  /** Deletes one episode; false when the server did not. */
  forget: (episodeId: string) => Promise<boolean>;
  /**
   * The character's memory changed: a memory landed, was forgotten, or memory
   * is off. A memory that landed brings the notebook row the server left.
   */
  changed?: (characterId: string, notebook?: MemoryState) => void;
}

/** The next prompt's preview follows edits after this pause; it feeds the meter and the inspector. */
export const PREVIEW_DEBOUNCE_MS = 400;

export interface ChatState extends SceneSliceState, CastSliceState {
  usage: UsageLedger;
  trackUsage: (
    purpose: CallPurpose,
    model: string,
    generation?: string | null,
    id?: string,
  ) => UsageHandle;
  /** Advances on every Clear; writes tagged with an older epoch are dropped. */
  epoch: number;
  /**
   * The chat's `{{pick}}` seed, a new one on every Clear and sent with each
   * request and preview. Chat metadata: tab memory only.
   */
  pickSeed: number;
  /**
   * The chat's cache affinity id, a new one on every Clear and sent with each
   * generation (never a preview), so the provider can keep the chat's prompt
   * cached. Chat metadata: tab memory only.
   */
  cacheKey: string;
  /**
   * The lorebook's timed effects the last generation's prompt left, sent with
   * each request and preview; null before any, or without a book. Chat
   * content: tab memory only, emptied on Clear.
   */
  lorebookState: LorebookState | null;
  /**
   * Which events fired where, as the last reply's prompt left it, sent with
   * each request and preview; null before any, or without a character. Chat
   * content: tab memory only, emptied on Clear.
   */
  eventsState: EventsState | null;
  /**
   * The chat's macro variables, local and global, as the last committed
   * action left them: a sent message, a prompt sent, an output filled, the
   * greeting shown. Sent as a copy with each request and preview; a preview
   * never changes it. Chat content: tab memory only, emptied on Clear.
   */
  macroState: MacroState;
  /** Why the last send or generation did not go out; null once the draft changes. */
  macroNotice: MacroNotice | null;
  /**
   * The card's greeting could not be filled for a chat waiting for one: a
   * character, persona or preset it reads did not load. Not chat content.
   */
  greetingFailed: boolean;
  messages: ChatMessage[];
  draft: string;
  generating: boolean;
  /** What the running generation writes; null when none runs. */
  generationMode: GenerationMode | null;
  /** What was deleted last and where, until the next change to the messages. */
  deleted: Deleted | null;
  /** The message in its edit field, what is edited, and the text written there. Chat content. */
  /** The message being edited; `fromComposer` when a key in the composer opened it. */
  editing: { id: string; text: string; target: EditTarget; fromComposer?: true } | null;
  impersonation: ImpersonationNote;
  lastSent: LastSent | null;
  preview: Preview;
  /** The generation waiting for a sign-in; at most one. */
  pending: Pending | null;
  memory: ChatMemory;
  setDraft: (draft: string) => void;
  send: () => Promise<void>;
  /** Opens an empty chat on the card's greetings, or refills an untouched lone greeting. */
  setGreetings: (greetings: string[]) => void;
  /**
   * As setGreetings, with each greeting's macros filled by `evaluate` from one
   * base state: the chat's state for a new greeting, the same base again for a
   * refill. Only the shown greeting's state is committed. `evaluate` runs only
   * when its result is used.
   */
  setGreetingChoices: (evaluate: (base: MacroState) => GreetingChoice[]) => void;
  /** Says the greeting did not load, only while the chat waits for one; false takes it back. */
  setGreetingFailed: (failed: boolean) => void;
  pickGreeting: (index: number) => void;
  /** Steps through the last reply's alternates; past the last one, generates another. */
  swipe: (direction: -1 | 1) => Promise<void>;
  /** Replaces the shown alternate of the last reply with a new one. */
  regenerate: () => Promise<void>;
  continueReply: () => Promise<void>;
  /** The model writes the user's next message into the empty draft. */
  impersonate: () => Promise<void>;
  edit: (id: string, text: string) => void;
  startEdit: (id: string, target?: EditTarget, fromComposer?: boolean) => void;
  setEditText: (text: string) => void;
  /** Saves the open edit; refused (false) while anything is written, or for blank text. */
  saveEdit: () => boolean;
  cancelEdit: () => void;
  remove: (id: string) => void;
  undoDelete: () => void;
  /** Deletes a message and every message after it. */
  removeFrom: (id: string) => void;
  /** Deletes the last reply's shown alternate, when it has others; the one before it shows. */
  removeAlternate: () => void;
  requestPreview: () => Promise<void>;
  /** A preview after the debounce pause, unless a reply is streaming. */
  schedulePreview: () => void;
  stop: () => void;
  clear: () => void;
  /**
   * Runs the pending generation once more, in place; true once its stream
   * started, false when there was none or it failed again.
   */
  resume: () => Promise<boolean>;
  /**
   * Remembers the unfolded turns but the newest ones now, whatever their
   * size (at least two turns); after a lost answer, the same span again.
   * Nothing while an open edit is in that span.
   */
  rememberNow: () => Promise<void>;
  /**
   * Remembers the chat's ending before it closes: every unremembered turn,
   * the newest included, whatever their size (one turn is enough), once a
   * reply still streaming has settled and a memory call or a Forget under
   * way has answered. Resolves with the outcome; on failure, or while an
   * open edit is among its turns, the chat is as it was, its turns
   * unremembered.
   */
  rememberEnding: () => Promise<EndingOutcome>;
  /**
   * Deletes the latest memory: a held one's turns are no longer remembered,
   * a folded one's unfold.
   */
  forgetLatest: () => Promise<void>;
  /**
   * An episode was deleted (the Memory screen): it leaves the recap or the
   * held spans; the latest one frees or unfolds its turns.
   */
  episodeGone: (id: string) => void;
  /**
   * Unfolds everything and forgets the recap and the held spans: memory went
   * off, was forgotten, or the character changed.
   */
  memoryReset: () => void;
  showFolded: (shown: boolean) => void;
}

interface ChatDeps {
  /** The browser's clock and time zone, for `{{time}}` and `{{date}}`. */
  clock: () => Clock;
  /** Milliseconds for measuring reasoning time. */
  now?: () => number;
  /** A new chat's pick seed; a random uint32 by default. */
  pickSeed?: () => number;
  /** A new chat's cache affinity id; a random UUID by default. */
  cacheKey?: () => string;
  fetchPreview: FetchPreview;
  /** False while the Authelia session is gone: nothing is generated until it is back. */
  signedIn?: () => boolean;
  /**
   * False until the last renewal's saves have ended: a generation refused late
   * waits for them, so it is built from the entities as the owner left them.
   */
  resumable?: () => boolean;
  /**
   * Loads what the browser's macros read for a selection. Without it the
   * browser fills no macros: messages and output go as written.
   */
  subject?: (selection: Selection) => Promise<SubjectResult>;
  /** A phone-like device, for `{{isMobile}}`. */
  isMobile?: () => boolean;
  /** Uniform in [0, 1), for `{{random}}` and `{{roll}}`. */
  random?: () => number;
  /** The character's memory; without it nothing is remembered or folded. */
  memory?: MemoryDeps;
  /** Picture this scene; without it nothing is pictured. */
  scene?: SceneDeps;
  /** The cast keeper and the cast sheet; without them the chat keeps no cast. */
  cast?: CastDeps;
}

const sameSubject = (a: Selection, b: Selection) =>
  a.model === b.model &&
  a.samplerPresetId === b.samplerPresetId &&
  a.characterId === b.characterId &&
  a.personaId === b.personaId &&
  a.promptPresetId === b.promptPresetId;

const isUser = (message: ChatMessage): message is UserMessage => message.role === "user";

/** Every alternate's id among these messages' replies. */
const replyIdsOf = (messages: ChatMessage[]): string[] =>
  messages.flatMap((message) =>
    message.role === "assistant" ? message.replies.map((reply) => reply.id) : [],
  );

export const browserClock = (): Clock => ({
  now: Date.now(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

/**
 * The request fields a selection, clock and the chat's pick seed and
 * lorebook state give; absent ids and no state are left out.
 */
function selected(
  selection: Selection & { model: string },
  clock: Clock,
  chat: Pick<ChatState, "pickSeed" | "lorebookState" | "eventsState">,
  memoryState: ChatMemoryState | null,
) {
  const { model, samplerPresetId, promptPresetId, characterId, personaId } = selection;
  const { pickSeed, lorebookState, eventsState } = chat;
  return {
    model,
    ...(samplerPresetId === null ? {} : { samplerPresetId }),
    ...(promptPresetId === null ? {} : { promptPresetId }),
    ...(characterId === null ? {} : { characterId }),
    ...(personaId === null ? {} : { personaId }),
    clock,
    pickSeed,
    ...(lorebookState === null ? {} : { lorebookState }),
    ...(eventsState === null ? {} : { eventsState }),
    ...(memoryState === null ? {} : { memoryState }),
  };
}

/**
 * The messages a request carries as turns: failed and empty replies stay out.
 * A reply whose macros filled to nothing goes as the model wrote it.
 */
function sentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(isSent);
}

function isSent(message: ChatMessage): boolean {
  if (message.role === "user") return message.text !== "";
  const reply = shownReply(message);
  return reply.status !== "failed" && (reply.text !== "" || (reply.rawText ?? "") !== "");
}

/**
 * How many of the messages in [from, to) a request sends as turns, counted
 * without copying them: selectors run on every streamed token.
 */
export function sentCount(messages: ChatMessage[], from: number, to: number): number {
  let count = 0;
  for (let index = Math.max(from, 0); index < Math.min(to, messages.length); index++) {
    const message = messages[index];
    if (message !== undefined && isSent(message)) count++;
  }
  return count;
}

/** The id of the `nth` (from 0) message from `from` on that a request sends, if there is one. */
export function nthSentId(messages: ChatMessage[], from: number, nth: number): string | undefined {
  let left = nth;
  for (let index = Math.max(from, 0); index < messages.length; index++) {
    const message = messages[index];
    if (message === undefined || !isSent(message)) continue;
    if (left === 0) return message.id;
    left--;
  }
  return undefined;
}

const idsOf = new WeakMap<ChatMessage[], string[]>();

/**
 * The messages' ids, one array per list shape: a stream patch, which keeps
 * every message's place and id, keeps the array (`patchMessage`), so the
 * thread's selector returns at once on each token.
 */
export function messageIds(state: Pick<ChatState, "messages">): string[] {
  let ids = idsOf.get(state.messages);
  if (ids === undefined) {
    ids = state.messages.map((message) => message.id);
    idsOf.set(state.messages, ids);
  }
  return ids;
}

/**
 * A turn as sent, with the reply's reasoning for the preset to add or leave
 * out: the user's filled text under the name it was sent as, a greeting or
 * an edited reply as shown, a generated reply as the model wrote it, for each
 * generation to fill again; an edited one a Continue added to keeps its
 * edited start as written.
 */
function turnOf(message: ChatMessage): ChatTurn {
  if (message.role === "user") {
    return message.name === undefined
      ? { role: "user", content: message.text }
      : { role: "user", content: message.text, name: message.name };
  }
  const reply = shownReply(message);
  const { text, rawText, reasoning, generated } = reply;
  const prefix = reply.macroPrefixLength ?? 0;
  const content = rawText ?? text;
  const turn: ChatTurn =
    !message.greeting && generated === true && prefix <= content.length
      ? {
          role: "assistant",
          content,
          macroEligible: true,
          ...(text === content ? {} : { scanText: text }),
          ...(prefix === 0 ? {} : { macroPrefixLength: prefix }),
        }
      : { role: "assistant", content: text };
  return reasoning.trim() === "" ? turn : { ...turn, reasoning };
}

/** A reply sent as shown from now on: its macros are never filled again. */
const literalReply = ({
  rawText: _raw,
  generated: _generated,
  macroPrefixLength: _prefix,
  ...rest
}: Reply): Reply => rest;

/**
 * Who spoke a sent turn: the persona a user turn was sent as and the name it
 * was sent under; null for a reply or a turn sent as no persona.
 */
export type Speaker = { personaId: string; name: string | null } | null;

const speakerOf = (message: ChatMessage): Speaker =>
  message.role === "user" && message.personaId !== null
    ? { personaId: message.personaId, name: message.name ?? null }
    : null;

/**
 * The history a request carries, and who spoke each turn.
 * Reasoning the preset does not send back stays in the tab.
 */
function history(messages: ChatMessage[], reasoning: Selection["reasoning"]) {
  const sent = sentMessages(messages);
  const turns = sent.map(turnOf);
  const kept = reasoning === null ? null : reasoningSentBack(turns, reasoning);
  return {
    turns:
      kept === null
        ? turns
        : turns.map((turn, index) => {
            if (turn.reasoning === undefined || kept.has(index)) return turn;
            const { reasoning: _left, ...rest } = turn;
            return rest;
          }),
    speakers: sent.map(speakerOf),
  };
}

/**
 * The turns a memory call remembers, as the thread shows them: the user's
 * text under the name it was sent as, a reply's shown text; no reasoning,
 * nothing to fill again.
 */
function shownTurns(messages: ChatMessage[]): ChatTurn[] {
  return sentMessages(messages).flatMap((message): ChatTurn[] => {
    const content = shownText(message);
    if (content.trim() === "") return [];
    return message.role === "user" && message.name !== undefined
      ? [{ role: "user", content, name: message.name }]
      : [{ role: message.role, content }];
  });
}

/**
 * The turns Remember now would send: the unremembered messages but the
 * newest `keepTurns`, as the thread shows them. Two or more make a span.
 */
export function rememberableTurns(state: ChatState, keepTurns: number): ChatTurn[] {
  const end = rememberedEnd(state.memory);
  const boundary = state.messages.length - keepTurns;
  return boundary <= end ? [] : shownTurns(state.messages.slice(end, boundary));
}

const shownText = (message: ChatMessage): string =>
  message.role === "user" ? message.text : shownReply(message).text;

/** The fewest turns the ending's memory takes: one, so nothing of the ending is left out. */
const ENDING_LEAST = 1;

/**
 * Whether the chat's ending holds anything to remember: every unremembered
 * turn counts. Stops at the first such turn, since it runs on every token.
 */
export function endingToRemember(state: ChatState): boolean {
  const { messages } = state;
  for (let index = rememberedEnd(state.memory); index < messages.length; index++) {
    const message = messages[index];
    if (message !== undefined && isSent(message) && /\S/.test(shownText(message))) return true;
  }
  return false;
}

/**
 * The span the next memory call takes, as message indices [from, to): a
 * lost answer's own span again while it still starts where the remembered
 * messages end and all of it is there, else the unremembered messages but
 * the newest `keep`, ending at its last turn: a trailing message no turn
 * comes from (a slot waiting for a sign-in, a failed or empty reply) stays
 * outside it, open.
 */
export function spanToRemember(
  state: Pick<ChatState, "memory" | "messages">,
  keep: number,
): { from: number; to: number; again: NonNullable<ChatMemory["pending"]> | null } {
  const { memory, messages } = state;
  const from = rememberedEnd(memory);
  const { pending } = memory;
  const again =
    pending !== null &&
    pending.from === from &&
    pending.boundary > from &&
    pending.boundary <= messages.length
      ? pending
      : null;
  if (again !== null) return { from, to: again.boundary, again };
  let to = messages.length - keep;
  while (to > from && shownTurns(messages.slice(to - 1, to)).length === 0) to -= 1;
  return { from, to, again };
}

/**
 * Whether the open edit is of a message in [from, to). Remembering those
 * messages would send them as they were and lock the edit's message, so
 * every memory call, the ending and Remember now's reason wait until the
 * edit is saved or cancelled.
 */
export function editHolds(
  state: Pick<ChatState, "editing" | "messages">,
  span: { from: number; to: number },
): boolean {
  const { editing, messages } = state;
  if (editing === null) return false;
  const at = messages.findIndex((message) => message.id === editing.id);
  return at !== -1 && at >= span.from && at < span.to;
}

const newReply = (): Reply => ({
  id: crypto.randomUUID(),
  text: "",
  generated: true,
  reasoning: "",
  thoughtMs: null,
  status: "streaming",
});

/** What an output's macros read: the model, window and reply tokens its prompt was built with, once it said them. */
const sentWith = (subject: MacroSubject, prompt: InspectedPrompt | undefined): MacroSubject =>
  prompt === undefined
    ? subject
    : {
        ...subject,
        runtime: { model: prompt.model, window: prompt.window.tokens, reserve: prompt.reserve },
      };

/** The greeting nobody touched when the chat holds only that: the card's, which a fill replaces. */
function untouchedGreeting(messages: ChatMessage[]): AssistantMessage | undefined {
  const [only] = messages;
  return messages.length === 1 && only?.role === "assistant" && only.greeting && !only.edited
    ? only
    : undefined;
}

/**
 * Whether the chat holds anything of the user's: a greeting nobody touched is
 * the card's, not theirs; an open edit of it is theirs, saved or not.
 */
export function hasChatContent(state: ChatState): boolean {
  return (
    (state.messages.length > 0 && untouchedGreeting(state.messages) === undefined) ||
    state.draft !== "" ||
    state.deleted !== null ||
    state.editing !== null ||
    // A picture of an untouched greeting is the user's too.
    state.scenes.length > 0
  );
}

/**
 * Whether the owner wrote, edited or deleted since `before`, by the fields
 * `hasChatContent` counts. A pending Undo or an edit that closes on its own
 * (a background fold) is no new content.
 */
export const contentChangedSince = (before: ChatState, now: ChatState): boolean =>
  now.messages !== before.messages ||
  now.draft !== before.draft ||
  (now.deleted !== null && now.deleted !== before.deleted) ||
  (now.editing !== null && now.editing !== before.editing) ||
  now.scenes !== before.scenes;

/**
 * The prompt the meter and the thread measure: the next request's preview
 * (the one before it while a new one loads), or the last sent before any
 * preview; none once the next one is refused.
 */
export function nextPrompt(state: ChatState): InspectedPrompt | null {
  if (state.preview.status === "idle") return state.lastSent?.prompt ?? null;
  return state.preview.prompt;
}

/** How many history turns the folded messages hold. */
export const foldedTurns = (state: ChatState): number =>
  sentCount(state.messages, 0, state.memory.horizon);

/** How many history turns the held spans hold: remembered, and still sent. */
export const heldTurns = (state: ChatState): number =>
  sentCount(state.messages, state.memory.horizon, rememberedEnd(state.memory));

/**
 * How many leading turns of the live history the next prompt leaves out
 * because its fold did, which the tab has not applied: its history indices
 * start after them. A preview's fold is never applied.
 */
export function promptFoldedTurns(state: ChatState): number {
  if (state.preview.status === "idle") return state.lastSent?.foldedTurns ?? 0;
  return state.preview.prompt?.memoryFold?.turns ?? 0;
}

/**
 * Messages before this index are read-only: remembered (held or folded), or
 * in the span a memory call is remembering or whose answer was lost (the
 * answer, now or on the retry, holds exactly what was sent).
 */
export function lockedBefore(state: ChatState): number {
  const end = rememberedEnd(state.memory);
  const { pending } = state.memory;
  return pending === null ? end : Math.max(end, pending.boundary);
}

/**
 * Whether the chat waits for the card's greeting: empty (and no greeting just
 * deleted), or only a greeting nobody touched, which a fill replaces.
 */
export function awaitsGreeting(state: ChatState): boolean {
  const { messages, deleted } = state;
  return (messages.length === 0 && deleted === null) || untouchedGreeting(messages) !== undefined;
}

/** The last message when it is a reply; only it swipes, regenerates and continues. */
export function lastReply(state: ChatState): AssistantMessage | undefined {
  const last = state.messages.at(-1);
  return last?.role === "assistant" ? last : undefined;
}

/** A new alternate needs the user's turn to answer, right before the reply. */
export function canGenerateAlternate(state: ChatState): boolean {
  const reply = lastReply(state);
  if (reply === undefined || reply.greeting) return false;
  const before = sentMessages(state.messages.slice(0, -1)).at(-1);
  return before?.role === "user";
}

interface Target {
  /** Applies the latest update; `prompt` is present from the first update on. */
  update: (update: ReplyUpdate, sentPrompt: InspectedPrompt | undefined) => void;
  end: (outcome: {
    status: "complete" | "stopped" | "failed";
    refusal?: RefusalCode;
    busy?: true;
    finishReason?: PartialReplyFinishReason;
  }) => void;
  /** Refused as signed out before anything arrived: undo what the start showed, wait. */
  wait: () => void;
  pending: Pending;
}

/** The transport's error for a request the sign-in redirect answered. */
const isSignedOut = (error: unknown) => (error as { reason?: string }).reason === "signed_out";

export function createChatStore(
  streamReply: StreamReply,
  selection: () => Selection,
  deps: ChatDeps,
) {
  const generations = new Map<string, string>();
  let usageSequence = 0;
  const now = deps.now ?? (() => performance.now());
  const newPickSeed = deps.pickSeed ?? randomSeed;
  const newCacheKey = deps.cacheKey ?? (() => crypto.randomUUID());
  // Kept outside the state: controllers and timers are not chat content and never render.
  const inFlight = new Set<AbortController>();
  let previewing: AbortController | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const random = deps.random ?? randomUniform;
  /**
   * The action waiting for its subject to load, by a token only it holds:
   * nothing else starts meanwhile, and only it (or a Clear) ends the wait.
   */
  let preparing: object | null = null;
  /**
   * The macro state before the lone greeting's choices, while the shown
   * choice's is the last one committed; null once anything else committed.
   * Chat content: tab memory only.
   */
  let greetingBase: MacroState | null = null;
  /** The memory call running, apart from generations: Stop leaves it, Clear aborts it. */
  let remembering: AbortController | undefined;
  /** That call's run until the chat took its answer: remembering the ending waits for it. */
  let rememberRun: Promise<RememberRun> | undefined;
  /** The Forget running, by a token only it holds; nothing is remembered meanwhile. */
  let forgetting: object | null = null;
  /** That Forget's call until it answered: remembering the ending waits for it. */
  let forgetRun: Promise<unknown> | undefined;
  /**
   * The last automatic memory call was held by an open edit in its span: once
   * that edit closes or another opens, it is asked for again.
   */
  let heldForEdit = false;
  let heldMemoryGeneration: string | null = null;
  /** The open edit changed while a call was held for it; asked for again once the change is whole. */
  let editChanged = false;
  /**
   * The generation resume left waiting because memory locked its reply: it
   * goes once the lock ends, if it is still the one waiting, in the same chat.
   */
  let lockedPending: { pending: Pending; messageId: string; epoch: number } | null = null;
  /** Both are looked at once, after the change under way. */
  let settling = false;
  let onStateChange: ((state: ChatState, previous: ChatState) => void) | undefined;

  const store = createStore<ChatState>()((set, get, api) => {
    /** Resolves once `done` holds, checked now and on every change of the state. */
    const until = (done: () => boolean) =>
      new Promise<void>((resolve) => {
        if (done()) return resolve();
        const stop = api.subscribe(() => {
          if (!done()) return;
          stop();
          resolve();
        });
      });

    /** The messages after the folded ones, which requests send. */
    const live = (messages: ChatMessage[]) => messages.slice(get().memory.horizon);

    const scene = createSceneSlice(set, get, deps.scene, {
      chosen: () => selection(),
      moment: () => {
        const { messages } = get();
        const last = messages.at(-1);
        return {
          generation:
            last?.role === "assistant" ? (generations.get(shownReply(last).id) ?? null) : null,
          turns: shownTurns(live(messages)),
          anchorId: messages.at(-1)?.id,
          people: castPeopleNotes(currentRegister(get())),
        };
      },
      generating: () => get().generating,
      signedIn: () => deps.signedIn?.() ?? true,
      register: (controller) => {
        inFlight.add(controller);
        return () => inFlight.delete(controller);
      },
      trackUsage: (model, generation) => get().trackUsage("scene.prompt", model, generation),
    });

    const cast = createCastSlice(set, get, deps.cast, {
      chosen: () => selection(),
      turns: (from, to) => shownTurns(get().messages.slice(from, to)),
      changed: () => get().schedulePreview(),
      generation: (replyId) => generations.get(replyId) ?? null,
      trackUsage: (purpose, model, generation, id) =>
        get().trackUsage(purpose, model, generation, id),
    });

    /** The register a request before message `index` carries; nothing while it is empty. */
    const castBefore = (index: number) => {
      const register = registerAt(get(), index);
      return register.entries.length === 0 ? {} : { cast: register };
    };

    /** Memory is on for the character a request goes with. */
    const memoryOn = (characterId: string | null): characterId is string =>
      characterId !== null && deps.memory?.enabled(characterId) === true;

    /** The history turns a held span covers, as a request sends them. */
    const spanTurns = (span: HeldSpan) =>
      sentMessages(get().messages.slice(span.from, span.to)).length;

    /**
     * The memory a request carries while memory is on, nothing otherwise:
     * this chat's folded episodes, how many turns they fold, and the held
     * spans whose turns lead the request's history.
     */
    const recapFor = (chosen: Selection): ChatMemoryState | null => {
      if (!memoryOn(chosen.characterId)) return null;
      const { messages, memory } = get();
      const { recap, held } = memory;
      const folded = sentMessages(messages.slice(0, memory.horizon));
      const [first] = messages;
      return {
        recap,
        folded: folded.length,
        // Sent even at zero: it tells the server this tab carries timing inside folded turns.
        foldedUsers: folded.filter(isUser).length,
        held: held.map((span) => ({ id: span.id, turns: spanTurns(span) })),
        // The chat opens on the memory's opening, edited or not: the day after the last ended.
        continued:
          first?.role === "assistant" &&
          first.greeting &&
          shownReply(first).greetingKey === MEMORY_GREETING,
      };
    };

    /** The message at `index` is read-only (folded, or being remembered). */
    const locked = (index: number) => index !== -1 && index < lockedBefore(get());

    /**
     * The history turns between two horizons, oldest first, by role, and their
     * count: positive when `to` folds more, negative when it unfolds.
     */
    const crossed = (from: number, to: number) => {
      const { messages } = get();
      const roles = sentMessages(messages.slice(Math.min(from, to), Math.max(from, to))).map(
        (message) => message.role,
      );
      return { count: from <= to ? roles.length : -roles.length, roles };
    };

    /**
     * Moves the horizon to `to`, with the rest of `memory`: the timed lorebook
     * state and the events state move with the history, as deleting (or
     * putting back) the turns would; an Undo saved before is no longer
     * right, and an edit of a message now read-only closes.
     */
    const moveHorizon = (to: number, memory: Partial<ChatMemory>) => {
      const { count, roles } = crossed(get().memory.horizon, to);
      set((state) => {
        const next = { ...state.memory, ...memory, horizon: to };
        const editing =
          state.editing === null
            ? null
            : state.messages.findIndex((message) => message.id === state.editing?.id);
        return {
          memory: next,
          lorebookState: lorebookStateAfterFold(state.lorebookState, count),
          eventsState: eventsAfterFold(state.eventsState, count, roles),
          ...(count !== 0 && state.deleted?.kind === "messages" ? { deleted: null } : {}),
          ...(editing !== null && editing < to ? { editing: null } : {}),
        };
      });
    };

    /**
     * Folds the oldest `count` held spans: the horizon moves to where the
     * last of them ends and their memories join the recap, the newest of
     * them now the latest folded one.
     */
    const applyFold = (count: number) => {
      const { held, recap } = get().memory;
      const folding = held.slice(0, count);
      const last = folding.at(-1);
      if (last === undefined) return;
      moveHorizon(last.to, {
        held: held.slice(count),
        recap: [...recap, ...folding.map((span) => span.id)],
        foldedLatest: { id: last.id, title: last.title, from: last.from },
      });
    };

    /**
     * The request `build` makes, within the server's bounds: while it would
     * carry more turns than `MAX_CHAT_TURNS` or more bytes than
     * `MAX_CHAT_BODY_BYTES`, or the chat holds more than
     * `MEMORY_LIMITS.held` memories, the oldest held span folds here, as the
     * server would fold it, and the request is built again. Without a held
     * memory it goes as it is, for the server to refuse.
     */
    const withinLimits = <T extends { messages: ChatTurn[] }>(build: () => T): T => {
      const encoder = new TextEncoder();
      for (;;) {
        const request = build();
        const { held } = get().memory;
        if (held.length === 0) return request;
        const fits =
          held.length <= MEMORY_LIMITS.held &&
          request.messages.length <= MAX_CHAT_TURNS &&
          encoder.encode(JSON.stringify(request)).length <= MAX_CHAT_BODY_BYTES;
        if (fits) return request;
        applyFold(1);
      }
    };

    /**
     * One memory call over the unremembered turns but the newest `keep`
     * (Settings' `keepTurns` by default), at least `least` turns: `force`
     * (Remember now, the ending) whatever their size, otherwise once they
     * reach the span. A call whose answer was lost goes again with its
     * attempt and span. An open edit in the span holds the call before
     * anything locks or goes out. On success for this chat the span is held:
     * its turns are still sent until a request folds them.
     */
    const rememberSpan = async (
      force: boolean,
      keep?: number,
      least = 2,
      generation: string | null = null,
    ): Promise<RememberRun> => {
      const nothing: RememberRun = { status: "none" };
      // An automatic call is held only by the edit open when it was last asked for.
      if (!force) {
        heldForEdit = false;
        heldMemoryGeneration = null;
      }
      const memoryDeps = deps.memory;
      const chosen = selection();
      const { characterId, personaId } = chosen;
      if (memoryDeps === undefined || !memoryOn(characterId)) {
        return { status: "failed", reason: "memory_off" };
      }
      let { memory } = get();
      const { messages, epoch } = get();
      if (forgetting !== null || memory.status === "remembering") return { status: "busy" };
      // A lost answer's attempt holds only for its span: once the remembered end or the messages
      // moved, a new one is drawn.
      const stale = memory.pending;
      if (
        stale !== null &&
        (rememberedEnd(memory) !== stale.from || stale.boundary > messages.length)
      ) {
        memory = { ...memory, status: "idle", boundary: null, pending: null };
        set({ memory });
      }
      // A lost answer and a transient refusal are asked for again with the next reply; another refusal waits for Try again.
      if (
        !force &&
        memory.status === "failed" &&
        memory.pending === null &&
        (memory.failure === null || !TRANSIENT_FAILURES.has(memory.failure))
      )
        return nothing;
      const settings = memoryDeps.settings();
      const model = memoryModelOf({ memoryModel: settings.memoryModel, model: chosen.model });
      if (model === null) return { status: "failed", reason: "no_model" };
      const {
        from,
        to: boundary,
        again,
      } = spanToRemember({ memory, messages }, keep ?? settings.keepTurns);
      if (boundary <= from) return nothing;
      const turns = shownTurns(messages.slice(from, boundary));
      // A lost attempt goes again over its own span, one turn if an ending's was.
      if (turns.length < (again === null ? least : 1)) return nothing;
      const size = estimateTokens(turns.map((turn) => turn.content).join("\n\n"));
      if (!force && again === null && size < settings.spanTokens) return nothing;
      // The span would go as it was and lock the edit's message: an automatic call is asked for
      // again once that edit closes (saved, cancelled, deleted or ended) or another opens.
      if (editHolds(get(), { from, to: boundary })) {
        if (!force) {
          heldForEdit = true;
          heldMemoryGeneration = generation;
        }
        return { status: "editing" };
      }
      const run = callMemory(
        memoryDeps,
        memory,
        { characterId, personaId, model, settings },
        {
          epoch,
          from,
          boundary,
          turns,
          attempt: again?.attempt ?? crypto.randomUUID(),
          generation,
        },
      );
      rememberRun = run;
      void run.finally(() => {
        if (rememberRun === run) rememberRun = undefined;
      });
      return run;
    };

    /** The memory call `rememberSpan` decided on, its answer taken for this chat. */
    const callMemory = async (
      memoryDeps: MemoryDeps,
      memory: ChatMemory,
      chosen: {
        characterId: string;
        personaId: string | null;
        model: string;
        settings: ReturnType<MemoryDeps["settings"]>;
      },
      call: {
        epoch: number;
        from: number;
        boundary: number;
        turns: ChatTurn[];
        attempt: string;
        generation: string | null;
      },
    ): Promise<RememberRun> => {
      const { characterId, personaId, model, settings } = chosen;
      const { epoch, from, boundary, turns, attempt } = call;
      const controller = new AbortController();
      remembering = controller;
      set({
        memory: {
          ...memory,
          status: "remembering",
          boundary,
          pending: { attempt, boundary, from },
        },
      });
      const castContext = memoryContextAt(get(), boundary);
      const request: RememberRequest = {
        characterId,
        ...(personaId === null ? {} : { personaId }),
        model,
        ...(settings.reasoning === null ? {} : { reasoning: settings.reasoning }),
        turns,
        ...(castContext === undefined ? {} : { castContext }),
        episodes: memory.recap,
        held: memory.held.map((span) => span.id),
        attempt,
      };
      let outcome: RememberOutcome;
      const accounting = get().trackUsage("memory.remember", model, call.generation, attempt);
      let received = false;
      try {
        outcome = await memoryDeps.remember(request, controller.signal, (receipt) => {
          received = true;
          accounting.receive(receipt);
        });
      } catch {
        outcome = { ok: false, reason: "unreachable", lost: true };
      }
      accounting.finish(
        received
          ? undefined
          : outcome.ok
            ? "completed"
            : controller.signal.aborted
              ? "aborted"
              : ["unreachable", "timeout", "aborted", "memory_failed", "upstream_busy"].includes(
                    outcome.reason,
                  )
                ? "failed"
                : undefined,
      );
      if (remembering === controller) remembering = undefined;
      // Cleared, reset or another character meanwhile: the server's write stands, this chat moves on.
      if (controller.signal.aborted || get().epoch !== epoch) return { status: "cancelled" };
      if (rememberedEnd(get().memory) !== from) {
        // The memory before it was deleted meanwhile: this span no longer starts where the
        // remembered turns end, so nothing is held. (A request folding held spans meanwhile
        // moves the horizon, never the remembered end.)
        set((state) => ({
          memory: { ...state.memory, status: "idle", boundary: null, pending: null },
        }));
        return { status: "moved" };
      }
      if (!outcome.ok) {
        set((state) => ({
          memory: {
            ...state.memory,
            status: "failed",
            failure: outcome.reason,
            pending: outcome.lost ? { attempt, boundary, from } : null,
          },
        }));
        if (outcome.reason === "memory_off") memoryDeps.changed?.(characterId);
        return { status: "failed", reason: outcome.reason };
      }
      const { episode, recap, notebook } = outcome.response;
      // No edit is open in the span: none was when the call went out (`editHolds`), and the span
      // has been read-only since.
      set((state) => ({
        memory: {
          ...state.memory,
          held: [
            ...state.memory.held,
            { id: episode.id, title: episode.title, from, to: boundary },
          ],
          // The answer's recap is the one the call sent, as the server has it now; memories a
          // request folded meanwhile were held then, newer than all of it, so they follow it.
          recap: [
            ...recap,
            ...state.memory.recap.filter((id) => !memory.recap.includes(id) && !recap.includes(id)),
          ],
          boundary: null,
          status: "idle",
          pending: null,
        },
      }));
      get().schedulePreview();
      memoryDeps.changed?.(characterId, notebook);
      return { status: "written" };
    };

    /**
     * The automatic call an edit held is asked for again, unless a reply is
     * streaming: once it settles, it asks.
     */
    const releaseHeld = () => {
      if (!heldForEdit || get().generating) return;
      void rememberSpan(false, undefined, 2, heldMemoryGeneration);
    };

    /**
     * Whether the generation resume left waiting on memory can go now: its
     * reply is no longer locked, nothing else runs or loads, and the session is
     * back with its saves ended. Once another generation waits in its place,
     * or the chat was cleared, it is dropped.
     */
    const lockEnded = (): boolean => {
      const waiting = lockedPending;
      if (waiting === null) return false;
      const state = get();
      if (state.epoch !== waiting.epoch || state.pending !== waiting.pending) {
        lockedPending = null;
        return false;
      }
      if (state.generating || preparing !== null || selection().model === null) return false;
      if (!signedIn() || !(deps.resumable?.() ?? true)) return false;
      const at = state.messages.findIndex((message) => message.id === waiting.messageId);
      return at !== -1 && !locked(at);
    };

    /**
     * After a change, once it is whole: the generation memory held goes out
     * once its lock ended, and an automatic call held for an edit that closed
     * or changed is asked for again.
     */
    const settle = () => {
      if (settling || (lockedPending === null && !editChanged)) return;
      settling = true;
      queueMicrotask(() => {
        settling = false;
        if (lockEnded()) {
          lockedPending = null;
          void get().resume();
        }
        if (editChanged) {
          editChanged = false;
          releaseHeld();
        }
      });
    };

    onStateChange = (state, previous) => {
      if (heldForEdit && state.editing?.id !== previous.editing?.id) editChanged = true;
      settle();
    };

    /** Keeps a copy of `state` as the chat's; false (and nothing kept) when it is not a valid one. */
    const keepMacros = (state: MacroState): boolean => {
      try {
        set({ macroState: cloneMacroState(state) });
        return true;
      } catch {
        // Bounded by core; a state past its limits is never kept.
        return false;
      }
    };

    /** Commits the state a chat action produced: the greeting's choices no longer own it. */
    const commitMacros = (state: MacroState) => {
      if (keepMacros(state)) greetingBase = null;
    };

    /**
     * What a request tells the macros about the browser: the prompt's first
     * kept turn last time, the thread's first turn, the last reply's alternate
     * (zero-based), the device, the composer, and the time since the user's
     * last message before this one (a send's own message is not counted).
     */
    const runtimeOf = (
      messages: ChatMessage[],
      type: GenerationType,
      clock: Clock,
    ): MacroRuntime => {
      const sent = sentMessages(live(messages));
      const last = sent.at(-1);
      const users = messages.filter(isUser);
      const since =
        type === "normal" && messages.at(-1)?.role === "user" ? users.at(-2) : users.at(-1);
      const prior = get().lastSent?.prompt.firstIncludedMessageId;
      return {
        ...(prior !== undefined && prior < sent.length ? { firstIncludedMessageId: prior } : {}),
        ...(sent.length > 0 ? { firstDisplayedMessageId: 0 } : {}),
        ...(last?.role === "assistant"
          ? {
              currentSwipeId: Math.min(last.shown, MAX_SWIPE_ID),
              lastSwipeId: Math.min(last.replies.length - 1, MAX_SWIPE_ID),
            }
          : {}),
        isMobile: deps.isMobile?.() ?? false,
        idleDuration: humanizeIdleDuration(since === undefined ? null : clock.now - since.sentAt),
        input: clipText(get().draft, PRESET_LIMITS.blockText),
      };
    };

    /** What the macros of text written after `messages` read; core copies the state. */
    const macroInput = (
      subject: MacroSubject,
      messages: ChatMessage[],
      type: GenerationType,
    ): MacroInput => {
      const clock = deps.clock();
      return {
        character: subject.character,
        persona: subject.persona,
        preset: subject.preset,
        prefer: subject.prefer,
        history: history(live(messages), null).turns,
        clock,
        pickSeed: get().pickSeed,
        random,
        macroState: get().macroState,
        generationType: type,
        macroRuntime: runtimeOf(messages, type, clock),
        ...(subject.runtime === undefined ? {} : { runtime: subject.runtime }),
      };
    };

    /**
     * Fills `text`'s macros once against the chat's state; the caller commits
     * the state it returns. Null when the macros went past their limits.
     */
    const fill = (
      text: string,
      subject: MacroSubject,
      messages: ChatMessage[],
      type: GenerationType,
    ): { content: string; macroState: MacroState } | null => {
      try {
        return fillChatText(text, macroInput(subject, messages, type));
      } catch {
        return null;
      }
    };

    /** The user's name as the macros say it, for the turn they send now; core's default without a persona. */
    const speakerOf = (subject: MacroSubject): string | undefined => {
      try {
        const { content } = fillChatText("{{user}}", {
          character: null,
          persona: subject.persona,
          clock: deps.clock(),
          pickSeed: get().pickSeed,
          random,
        });
        return clipText(content, PRESET_LIMITS.nameLength);
      } catch {
        return undefined;
      }
    };

    /**
     * The subject an action's macros read: null without the dependency
     * (nothing filled in the browser), undefined when it did not load, or the
     * chat or the selection moved on while it loaded (said by the notice).
     */
    const prepare = async (): Promise<MacroSubject | null | undefined> => {
      if (deps.subject === undefined) return null;
      const { epoch } = get();
      const chosen = selection();
      const token = {};
      preparing = token;
      let result: SubjectResult;
      try {
        result = await deps.subject(chosen);
      } catch {
        result = { ok: false };
      } finally {
        // A Clear ended this wait already; a newer action's is not this one's to end.
        if (preparing === token) preparing = null;
        // A generation memory held may go now that nothing loads, once the action that loaded
        // went on (or did not): looked at after its own continuation, never before it.
        queueMicrotask(settle);
      }
      if (get().epoch !== epoch || get().generating) return undefined;
      if (!sameSubject(chosen, selection()) || (!result.ok && result.reason === "changed")) {
        set({ macroNotice: "changed" });
        return undefined;
      }
      if (!result.ok) {
        set({
          macroNotice: result.reason === "context_window_unknown" ? "window" : "unavailable",
        });
        return undefined;
      }
      return result.subject;
    };

    /** Replaces one message by id, through `change`. */
    const patchMessage = (id: string, change: (message: ChatMessage) => ChatMessage) =>
      set((state) => {
        const messages = state.messages.map((message) =>
          message.id === id ? change(message) : message,
        );
        const ids = idsOf.get(state.messages);
        if (ids !== undefined) idsOf.set(messages, ids);
        return { messages };
      });

    /** Replaces one alternate of one reply, through `change`. */
    const changeReply = (messageId: string, replyId: string, change: (reply: Reply) => Reply) =>
      patchMessage(messageId, (message) =>
        message.role === "assistant"
          ? {
              ...message,
              replies: message.replies.map((reply) =>
                reply.id === replyId ? change(reply) : reply,
              ),
            }
          : message,
      );

    /** Changes one alternate of one reply. */
    const patchReply = (messageId: string, replyId: string, patch: Partial<Reply>) =>
      changeReply(messageId, replyId, (reply) => ({ ...reply, ...patch }));

    /**
     * Whether the reply an action was for is still the last one, as it was
     * when the action started: not edited, switched to another alternate,
     * deleted or replaced while its subject loaded. Otherwise the notice says
     * the chat changed, and nothing is written over either alternate.
     */
    const stillTarget = (target: AssistantMessage): boolean => {
      if (lastReply(get()) === target) return true;
      set({ macroNotice: "changed" });
      return false;
    };

    /**
     * A generation that waited for a sign-in and gives way to another: its
     * empty slot shows as not sent, with the actions of a failed reply.
     */
    const settlePending = () => {
      const { pending } = get();
      if (pending === null || pending.mode !== "reply") return;
      patchMessage(pending.messageId, (message) =>
        message.role === "assistant"
          ? {
              ...message,
              replies: message.replies.map((reply) =>
                reply.id === pending.replyId && reply.status === "waiting"
                  ? { ...reply, status: "failed" }
                  : reply,
              ),
            }
          : message,
      );
    };

    /**
     * One generation: sends the request, feeds each update to the target while
     * the epoch is current, and keeps the prompt sent for the inspector.
     */
    const run = async (
      mode: GenerationMode,
      type: GenerationType,
      messages: ChatMessage[],
      target: Target,
      started?: () => void,
    ): Promise<void> => {
      const { epoch } = get();
      const chosen = selection();
      const { model } = chosen;
      if (model === null) return;
      // The register goes with the sheet of the chat's character now.
      if (deps.cast?.memory !== undefined) {
        cast.follow();
        const waiting = new AbortController();
        inFlight.add(waiting);
        set({ generating: true, generationMode: mode });
        await new Promise<void>((resolve) => {
          const done = () => {
            waiting.signal.removeEventListener("abort", done);
            resolve();
          };
          waiting.signal.addEventListener("abort", done, { once: true });
          void cast.ready().then(done, done);
          if (waiting.signal.aborted) done();
        });
        inFlight.delete(waiting);
        if (get().epoch !== epoch) return;
        if (waiting.signal.aborted || !sameSubject(chosen, selection())) {
          target.end({ status: "stopped" });
          set({ generating: false, generationMode: null });
          get().schedulePreview();
          return;
        }
      } else cast.follow();
      const clock = deps.clock();
      let speakers: Speaker[] = [];
      const request: GenerateRequest = withinLimits(() => {
        const sent = history(live(messages), chosen.reasoning);
        speakers = sent.speakers;
        return {
          ...selected({ ...chosen, model }, clock, get(), recapFor(chosen)),
          macroState: cloneMacroState(get().macroState),
          generationType: type,
          macroRuntime: runtimeOf(messages, type, clock),
          cacheKey: get().cacheKey,
          mode,
          messages: sent.turns,
          ...castBefore(messages.length),
        };
      });
      // The horizon and held spans the request was built at: a fold the prompt reports applies
      // only to them, and a memory landing or forgotten meanwhile moves the states it returns.
      const sentHorizon = get().memory.horizon;
      const sentHeld = get().memory.held;
      const current = () => get().epoch === epoch;
      const controller = new AbortController();
      inFlight.add(controller);
      const generation = crypto.randomUUID();
      if ("replyId" in target.pending) {
        const { replyId, messageId } = target.pending;
        generations.set(replyId, generation);
        const message = get().messages.find((item) => item.id === messageId);
        if (message?.role === "assistant") generations.set(shownReply(message).id, generation);
        if (generations.size > 512) generations.delete(generations.keys().next().value ?? "");
      }
      const accounting = get().trackUsage("narration", request.model, generation);
      let receivedUsage = false;
      let unknownUsage: "failed" | "aborted" | undefined;
      let lastAccounting: CallAccounting | undefined;
      clearTimeout(previewTimer);
      // A preview of the chat before this generation would outlive it in the meter.
      previewing?.abort();
      previewing = undefined;
      settlePending();
      set({
        generating: true,
        generationMode: mode,
        deleted: null,
        pending: null,
        macroNotice: null,
      });
      let sentPrompt: InspectedPrompt | undefined;
      let finishReason: PartialReplyFinishReason | undefined;
      let arrived = false;
      let retryNow = false;
      try {
        for await (const update of streamReply(request, controller.signal)) {
          if (!arrived) {
            arrived = true;
            started?.();
          }
          if (!current()) continue;
          if (update.accounting !== undefined && update.accounting !== lastAccounting) {
            lastAccounting = update.accounting;
            receivedUsage = true;
            accounting.receive(update.accounting);
          }
          if (update.prompt !== undefined && update.prompt !== sentPrompt) {
            sentPrompt = update.prompt;
            const fold = update.prompt.memoryFold;
            const folding = sentHeld.slice(0, fold?.spans ?? 0);
            const { horizon, held } = get().memory;
            // The server folded the oldest held spans to fit: the tab folds them too, unless a
            // Forget, a reset or a deletion moved them meanwhile; then the next request sends
            // their turns again and the server folds again.
            const applied =
              fold !== undefined &&
              folding.length === fold.spans &&
              horizon === sentHorizon &&
              folding.every((span, i) => held[i]?.id === span.id && held[i]?.to === span.to);
            if (applied) applyFold(fold.spans);
            // The prompt's states are relative to the history it kept: they go back over what the
            // prompt folded, then move by what the tab's horizon crossed since the request (the
            // same turns once applied). Events count the replies crossed; the lorebook only turns.
            const folded = fold?.turns ?? 0;
            const moved = crossed(sentHorizon, get().memory.horizon);
            const shift = moved.count - folded;
            const unfolded = eventsAfterFold(
              update.prompt.eventsState ?? null,
              -folded,
              request.messages.slice(0, folded).map((turn) => turn.role),
            );
            // The next timed state commits with the prompt, whatever becomes of the
            // reply: the next request drops effects of a chat that did not advance.
            set({
              lastSent: {
                generation,
                prompt: update.prompt,
                sentAt: Date.now(),
                inputTokens: null,
                cachedTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                speakers: speakers.slice(folded),
                foldedTurns: applied ? 0 : folded,
              },
              lorebookState: lorebookStateAfterFold(update.prompt.lorebookState, shift),
              // A prompt without one carries nothing (the server leaves out an empty state).
              eventsState: eventsAfterFold(unfolded, moved.count, moved.roles),
            });
            // So do the prompt's macro effects, once per prompt, when it has any.
            if (update.prompt.macroState !== undefined) commitMacros(update.prompt.macroState);
          }
          const { inputTokens } = update;
          if (inputTokens !== undefined) {
            const usage = {
              inputTokens,
              cachedTokens: update.cachedTokens ?? null,
              outputTokens: update.outputTokens ?? null,
              reasoningTokens: update.reasoningTokens ?? null,
            };
            set((state) => (state.lastSent ? { lastSent: { ...state.lastSent, ...usage } } : {}));
          }
          target.update(update, sentPrompt);
          finishReason = update.finishReason;
        }
        // A stream can end without an error after an abort; Stop still wins.
        if (current())
          target.end({
            status: controller.signal.aborted ? "stopped" : "complete",
            ...(controller.signal.aborted || finishReason === undefined ? {} : { finishReason }),
          });
      } catch (error) {
        if (
          !isSignedOut(error) &&
          (error as { code?: string }).code === undefined &&
          (error as { reason?: string }).reason !== "refused"
        )
          unknownUsage = controller.signal.aborted ? "aborted" : "failed";
        const code = (error as { code?: RefusalCode }).code;
        const busy = (error as { busy?: boolean }).busy === true;
        if (current() && !arrived && isSignedOut(error) && !controller.signal.aborted) {
          target.wait();
          set({ pending: target.pending });
          // Refused for an older request after the session came back: it goes out now.
          retryNow = signedIn() && (deps.resumable?.() ?? true);
        } else if (current()) {
          target.end({
            status: controller.signal.aborted ? "stopped" : "failed",
            ...(code === undefined ? {} : { refusal: code }),
            ...(busy && !controller.signal.aborted ? { busy: true as const } : {}),
          });
        }
      } finally {
        accounting.finish(
          receivedUsage
            ? undefined
            : controller.signal.aborted
              ? "aborted"
              : (unknownUsage ?? (arrived ? "completed" : undefined)),
        );
        inFlight.delete(controller);
        if (current()) {
          set({ generating: false, generationMode: null });
          get().schedulePreview();
          if (retryNow) void get().resume();
          // A reply settled: the story may have grown enough to remember.
          else if (mode === "reply" || mode === "continue")
            void rememberSpan(false, undefined, 2, generation);
        }
      }
    };

    /**
     * An open edit of a message whose shown alternate is about to change is
     * closed: saving it would write onto another alternate.
     */
    const endEditOf = (messageId: string) =>
      set((state) => (state.editing?.id === messageId ? { editing: null } : {}));

    /**
     * Streams a new alternate into `messageId`'s slot `index` (appended when
     * past the end). A Replace that fails puts the alternate it replaced back.
     * A reply locked meanwhile (while its subject loaded) stays as it was sent.
     */
    const generateReply = (
      messageId: string,
      before: ChatMessage[],
      index: number,
      type: ReplyType,
      subject: MacroSubject | null,
      onStart?: () => void,
    ) => {
      if (locked(get().messages.findIndex((message) => message.id === messageId))) {
        return Promise.resolve();
      }
      endEditOf(messageId);
      const reply = newReply();
      let replaced: Reply | undefined;
      patchMessage(messageId, (message) => {
        if (message.role !== "assistant") return message;
        const replies = [...message.replies];
        // A slot waiting for a sign-in held nothing to put back.
        replaced = replies[index]?.status === "waiting" ? undefined : replies[index];
        replies[index] = reply;
        return { ...message, replies, shown: index };
      });
      let thinkingFrom: number | null = null;
      let thought = false;
      const started = now();
      let wrote = false;
      // The text as the model writes it; its macros are filled once, when it ends.
      let raw = "";
      let sent: InspectedPrompt | undefined;
      /** The reply's end: status and macros filled once; a failed Replace puts the old one back. */
      const endReply = ({ status, refusal, busy, finishReason }: Parameters<Target["end"]>[0]) => {
        if (status === "failed" && replaced !== undefined) {
          const previous = replaced;
          patchMessage(messageId, (message) =>
            message.role === "assistant"
              ? {
                  ...message,
                  replies: message.replies.map((other) =>
                    other.id === reply.id ? { ...previous, failed: "replace" } : other,
                  ),
                }
              : message,
          );
          return;
        }
        const patch: Partial<Reply> = {
          status,
          ...(refusal === undefined ? {} : { refusal }),
          ...(busy === undefined ? {} : { busy }),
          ...(finishReason === undefined ? {} : { finishReason }),
        };
        if (thinkingFrom !== null && !thought) patch.thoughtMs = now() - thinkingFrom;
        if (status !== "failed" && subject !== null && raw !== "") {
          const filled = fill(raw, sentWith(subject, sent), before, type);
          if (filled === null) {
            // Past the macro limits: kept as the model wrote it and sent as shown from now
            // on, so it is never filled again; nothing it set is kept.
            changeReply(messageId, reply.id, (current) => ({
              ...literalReply(current),
              ...patch,
              text: raw,
            }));
            set({ macroNotice: "output" });
            return;
          }
          patch.text = filled.content;
          if (filled.content !== raw) patch.rawText = raw;
          commitMacros(filled.macroState);
        }
        patchReply(messageId, reply.id, patch);
      };
      return run(
        "reply",
        type,
        before,
        {
          update: ({ text, reasoning = "" }, prompt) => {
            raw = text;
            sent = prompt;
            if (reasoning !== "" && thinkingFrom === null) thinkingFrom = now();
            const patch: Partial<Reply> = { text, reasoning };
            if (text !== "" && thinkingFrom !== null && !thought) {
              thought = true;
              patch.thoughtMs = now() - thinkingFrom;
            }
            if (text !== "" && !wrote) {
              wrote = true;
              // An effort was sent and no reasoning came back: the model kept it hidden.
              const effort = prompt?.settings.reasoning;
              if (reasoning === "" && effort !== undefined && effort !== "none") {
                patch.hiddenMs = now() - started;
              }
            }
            patchReply(messageId, reply.id, patch);
          },
          end: (outcome) => {
            endReply(outcome);
            // The alternate replaced goes with its snapshot; a failed Replace put both back.
            if (outcome.status !== "failed" && replaced !== undefined) cast.take([replaced.id]);
            if (outcome.status === "complete" && outcome.finishReason === undefined)
              cast.replied(messageId);
          },
          wait: () => {
            if (replaced === undefined) {
              patchReply(messageId, reply.id, { status: "waiting" });
              return;
            }
            // A Replace shows the alternate it would have replaced until it runs again.
            const previous = replaced;
            patchMessage(messageId, (message) =>
              message.role === "assistant"
                ? {
                    ...message,
                    replies: message.replies.map((other) =>
                      other.id === reply.id ? previous : other,
                    ),
                  }
                : message,
            );
          },
          // The alternate a Replace put back, or the new slot, found again by its id on resume.
          pending: { mode: "reply", messageId, replyId: replaced?.id ?? reply.id, type },
        },
        onStart,
      );
    };

    const signedIn = deps.signedIn ?? (() => true);
    const idle = () => !get().generating && !preparing && selection().model !== null && signedIn();

    /** Continue and Write for me, shared by their actions and by resume. */
    const continueLast = async (subject: MacroSubject | null, started?: () => void) => {
      const state = get();
      const message = lastReply(state);
      // A greeting is the card's; it is not continued. A reply locked meanwhile stays as sent.
      if (message === undefined || message.greeting || state.generating) return;
      if (locked(state.messages.length - 1)) return;
      if (selection().model === null) return;
      const before = shownReply(message);
      if (before.text === "" || before.status === "failed") return;
      const replyId = before.id;
      endEditOf(message.id);
      const { failed: _failed, ...rest } = before;
      const { finishReason: _finishReason, ...continuing } = rest;
      // The model continues the reply as it is sent: a generated one as the model wrote it,
      // an edited one as shown. Only what it adds is filled, once.
      const generated = before.generated === true;
      const beforeRaw = generated ? (before.rawText ?? before.text) : before.text;
      let output = "";
      let added = "";
      let sent: InspectedPrompt | undefined;
      // A keeper answer for the text before it is dropped once it lands.
      changeReply(message.id, replyId, () => ({
        ...continuing,
        status: "streaming",
        castVersion: (before.castVersion ?? 0) + 1,
      }));
      /** The continued reply's end; a failed Continue puts the reply back as it was. */
      const endContinue = ({ status, finishReason }: Parameters<Target["end"]>[0]) => {
        // The reply as it was before, with its raw text and what of it is filled again.
        if (status === "failed") {
          changeReply(message.id, replyId, () => ({ ...rest, failed: "continue" }));
          return;
        }
        if (status === "complete")
          added = joinContinuation(before.text, output).slice(before.text.length);
        const ending = { status, ...(finishReason === undefined ? {} : { finishReason }) };
        if (added === "") {
          // The text is as it was: so is its cast version.
          changeReply(message.id, replyId, ({ castVersion: _version, ...current }) => ({
            ...current,
            ...ending,
            ...(before.castVersion === undefined ? {} : { castVersion: before.castVersion }),
          }));
          return;
        }
        const shown = joinContinuation(before.text, added, { echo: false });
        const filled =
          subject === null
            ? { content: added, macroState: null }
            : fill(added, sentWith(subject, sent), state.messages, "continue");
        if (filled === null) {
          // Past the macro limits: the reply stays as shown and is sent so from now on,
          // never filled again; nothing the continuation set is kept.
          changeReply(message.id, replyId, (current) => ({
            ...literalReply(current),
            text: shown,
            ...ending,
          }));
          set({ macroNotice: "output" });
          return;
        }
        const raw = joinContinuation(beforeRaw, added, { echo: false });
        const text = joinContinuation(before.text, filled.content, { echo: false });
        // An edited reply's text, and the join after it, stay as written; a generated
        // one keeps the literal start it had.
        const prefix = generated
          ? (before.macroPrefixLength ?? 0)
          : beforeRaw.length + (added.match(/^\s*/u)?.[0].length ?? 0);
        changeReply(message.id, replyId, (current) => ({
          ...literalReply(current),
          text,
          ...(raw === text ? {} : { rawText: raw }),
          generated: true,
          ...(prefix === 0 ? {} : { macroPrefixLength: prefix }),
          ...ending,
        }));
        if (filled.macroState !== null) commitMacros(filled.macroState);
      };
      await run(
        "continue",
        "continue",
        state.messages,
        {
          update: ({ text, reasoning = "" }, prompt) => {
            // Core owns echo removal and spacing. Only the new suffix is ever filled,
            // so an echoed edited prefix cannot execute literal macros again.
            output = text;
            const joined = joinContinuation(before.text, output, { streaming: true });
            added = joined.slice(before.text.length);
            sent = prompt;
            patchReply(message.id, replyId, {
              text: joined,
              ...(generated && before.rawText !== undefined
                ? { rawText: joinContinuation(beforeRaw, added, { echo: false }) }
                : {}),
              reasoning: [before.reasoning, reasoning].filter(Boolean).join("\n\n"),
            });
          },
          end: (outcome) => {
            endContinue(outcome);
            if (outcome.status === "complete" && outcome.finishReason === undefined)
              cast.replied(message.id);
            // Stopped after it added text: the reply's snapshot no longer reads it, so it goes
            // stale and the next keeper call catches up.
            else if (
              (outcome.status === "stopped" || outcome.finishReason !== undefined) &&
              added !== ""
            )
              cast.take([replyId], true);
          },
          wait: () => changeReply(message.id, replyId, () => rest),
          pending: { mode: "continue", messageId: message.id, replyId },
        },
        started,
      );
    };

    const writeForMe = async (subject: MacroSubject | null, started?: () => void) => {
      const state = get();
      if (state.generating || selection().model === null || state.draft !== "") return;
      set({ impersonation: null });
      // The draft shows what the model writes; its macros are filled once, when it ends.
      let raw = "";
      let sent: InspectedPrompt | undefined;
      await run(
        "impersonate",
        "impersonate",
        state.messages,
        {
          update: ({ text }, prompt) => {
            raw = text;
            sent = prompt;
            set({ draft: text });
          },
          end: ({ status, refusal, busy }) => {
            if (status !== "failed" && subject !== null && raw !== "") {
              const filled = fill(raw, sentWith(subject, sent), state.messages, "impersonate");
              if (filled !== null) {
                set({ draft: filled.content });
                commitMacros(filled.macroState);
              }
            }
            set({
              impersonation:
                status === "complete"
                  ? null
                  : {
                      status,
                      ...(refusal === undefined ? {} : { refusal }),
                      ...(busy === undefined ? {} : { busy }),
                    },
            });
          },
          wait: () => set({ draft: "" }),
          pending: { mode: "impersonate" },
        },
        started,
      );
    };

    /**
     * Shows one alternate of a reply. A lone greeting's choice brings its own
     * macro effects, from the state before any choice, never another's.
     */
    const showAlternate = (message: AssistantMessage, index: number) => {
      endEditOf(message.id);
      patchMessage(message.id, () => ({ ...message, shown: index }));
      set({ deleted: null });
      syncGreeting();
      // A greeting shown without a snapshot is read by the keeper.
      cast.seedGreeting();
      get().schedulePreview();
    };

    /** While nothing else has committed since, the lone greeting's shown choice owns the state. */
    const syncGreeting = () => {
      const base = greetingBase;
      const { messages } = get();
      const [only] = messages;
      if (base === null || messages.length !== 1 || only?.role !== "assistant" || !only.greeting) {
        return;
      }
      keepMacros(shownReply(only).macroState ?? base);
    };

    /** A new user turn from the draft, with its macros filled once; null when it cannot go. */
    const userTurn = (
      draft: string,
      chosen: Selection,
      subject: MacroSubject | null,
      messages: ChatMessage[],
    ): UserMessage | null => {
      const base = {
        id: crypto.randomUUID(),
        role: "user" as const,
        personaId: chosen.personaId,
        sentAt: deps.clock().now,
      };
      if (subject === null) return draft.trim() === "" ? null : { ...base, text: draft };
      // An empty draft sends the preset's Send If Empty, when it has one.
      const source = draft;
      if (source.trim() === "") return null;
      let filled: { content: string; macroState: MacroState };
      try {
        filled = fillChatText(source, macroInput(subject, messages, "normal"));
      } catch (error) {
        set({ macroNotice: error instanceof MacroLimitError ? "limit" : "unavailable" });
        return null;
      }
      if (filled.content.trim() === "") {
        set({ macroNotice: "empty" });
        return null;
      }
      const name = speakerOf(subject);
      commitMacros(filled.macroState);
      return { ...base, text: filled.content, ...(name === undefined ? {} : { name }) };
    };

    return {
      usage: emptyUsage(),
      trackUsage: (purpose, model, generation = null, id = crypto.randomUUID()) => {
        const epoch = get().epoch;
        const prior = get().usage.calls.find((call) => call.id === id);
        const request = {
          id,
          purpose,
          model,
          generation: prior === undefined ? generation : prior.generation,
          order: prior?.order ?? usageSequence++,
        };
        let received = false;
        set((state) => ({ usage: startUsage(state.usage, request) }));
        return {
          receive: (receipt) => {
            if (get().epoch !== epoch) return;
            received = true;
            set((state) => ({ usage: receiveUsage(state.usage, request, receipt) }));
          },
          finish: (unknown) => {
            if (get().epoch !== epoch) return;
            set((state) => ({
              usage: finishUsage(state.usage, request, received ? undefined : unknown),
            }));
          },
        };
      },
      epoch: 0,
      pickSeed: newPickSeed(),
      cacheKey: newCacheKey(),
      lorebookState: null,
      eventsState: null,
      macroState: emptyMacroState(),
      macroNotice: null,
      greetingFailed: false,
      messages: [],
      draft: "",
      generating: false,
      generationMode: null,
      deleted: null,
      editing: null,
      impersonation: null,
      lastSent: null,
      preview: NO_PREVIEW,
      pending: null,
      memory: NO_MEMORY,
      ...scene.actions,
      ...cast.actions,

      setDraft: (draft) => {
        set({ draft, impersonation: null, macroNotice: null });
        get().schedulePreview();
      },

      send: async () => {
        if (!idle()) return;
        const { draft, epoch } = get();
        const chosen = selection();
        // Without a subject nothing is filled and nothing is awaited: a blank draft never goes.
        if (deps.subject === undefined && draft.trim() === "") return;
        const subject = deps.subject === undefined ? null : await prepare();
        // Typed on, cleared or sent meanwhile: this send is over, the draft as it is.
        if (subject === undefined || get().epoch !== epoch || get().draft !== draft || !idle()) {
          return;
        }
        const { messages } = get();
        const user = userTurn(draft, chosen, subject, messages);
        if (user === null) return;
        const reply: AssistantMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          greeting: false,
          edited: false,
          replies: [],
          shown: 0,
        };
        set({
          messages: [...messages, user, reply],
          draft: "",
          impersonation: null,
          macroNotice: null,
        });
        await generateReply(reply.id, [...messages, user], 0, "normal", subject);
      },

      setGreetings: (greetings) =>
        get().setGreetingChoices(() =>
          greetings.map((content, at): GreetingChoice => ({ content, key: `card:${at}` })),
        ),

      setGreetingChoices: (evaluate) => {
        const { messages, generating } = get();
        if (generating) return;
        const only = untouchedGreeting(messages);
        const untouched = only !== undefined;
        // A greeting just deleted stays deleted: its Undo would bring it back twice.
        const opening = messages.length === 0 && get().deleted === null;
        // A greeting being remembered, or whose memory's answer was lost, stays as it was sent.
        if ((!opening && !untouched) || (untouched && locked(0))) return;
        set({ greetingFailed: false });
        // A refill starts again from the state before the greeting, so its effects never add up.
        const base = untouched && greetingBase !== null ? greetingBase : get().macroState;
        const committing = opening || greetingBase !== null;
        let choices: GreetingChoice[];
        try {
          choices = evaluate(cloneMacroState(base));
        } catch {
          choices = [];
        }
        if (choices.length === 0) {
          // Another character, or one without greetings: the old greeting goes, with its effects.
          if (untouched) {
            scene.drop(() => true);
            cast.take(only.replies.map((reply) => reply.id));
            set({ messages: [] });
            if (committing) keepMacros(base);
            greetingBase = null;
          }
          // A chat starts without a greeting: the character's cast sheet is asked for all the same.
          cast.started();
          return;
        }
        // Each greeting keeps its reply's id by its key, as the shown one stays shown while it is
        // still among the choices (the memory's opening coming or going moves the card's).
        const replies = (current: Reply[]) =>
          choices.map((choice): Reply => {
            const kept = current.find((reply) => reply.greetingKey === choice.key);
            return {
              id: kept?.id ?? crypto.randomUUID(),
              // A refill to new text drops a keeper answer for the old one; the same text keeps it.
              ...(kept === undefined
                ? {}
                : {
                    castVersion: (kept.castVersion ?? 0) + (kept.text === choice.content ? 0 : 1),
                  }),
              text: choice.content,
              ...(choice.rawText === undefined || choice.rawText === choice.content
                ? {}
                : { rawText: choice.rawText }),
              ...(choice.macroState === undefined ? {} : { macroState: choice.macroState }),
              greetingKey: choice.key,
              reasoning: "",
              thoughtMs: null,
              status: "complete",
            };
          });
        const shownKey = untouched ? shownReply(only).greetingKey : undefined;
        const message: AssistantMessage = untouched
          ? {
              ...only,
              replies: replies(only.replies),
              shown: Math.max(
                0,
                choices.findIndex((choice) => choice.key === shownKey),
              ),
            }
          : {
              id: crypto.randomUUID(),
              role: "assistant",
              greeting: true,
              edited: false,
              replies: replies([]),
              shown: 0,
            };
        // A greeting refilled to new text loses its snapshot: the keeper reads it again.
        if (untouched) {
          cast.take(
            only.replies
              .filter(
                (reply) =>
                  message.replies.find((next) => next.id === reply.id)?.text !== reply.text,
              )
              .map((reply) => reply.id),
          );
        }
        set({ messages: [message] });
        if (committing && keepMacros(choices[message.shown]?.macroState ?? base)) {
          greetingBase = cloneMacroState(base);
        }
        cast.started();
        get().schedulePreview();
      },

      setGreetingFailed: (failed) => {
        if (failed === get().greetingFailed) return;
        if (failed && (get().generating || !awaitsGreeting(get()))) return;
        set({ greetingFailed: failed });
      },

      pickGreeting: (index) => {
        const reply = lastReply(get());
        if (!reply?.greeting || get().generating || reply.replies[index] === undefined) return;
        if (locked(get().messages.length - 1)) return;
        showAlternate(reply, index);
      },

      swipe: async (direction) => {
        const state = get();
        const reply = lastReply(state);
        if (reply === undefined || state.generating || locked(state.messages.length - 1)) return;
        const next = reply.shown + direction;
        if (next < 0) return;
        if (next < reply.replies.length) {
          showAlternate(reply, next);
          return;
        }
        // Past the last alternate: greetings stop; replies generate another.
        if (!canGenerateAlternate(state) || !idle()) return;
        const subject = deps.subject === undefined ? null : await prepare();
        if (subject === undefined || !idle() || !stillTarget(reply)) return;
        const latest = get();
        if (!canGenerateAlternate(latest)) {
          set({ macroNotice: "changed" });
          return;
        }
        await generateReply(
          reply.id,
          latest.messages.slice(0, -1),
          reply.replies.length,
          "swipe",
          subject,
        );
      },

      regenerate: async () => {
        const state = get();
        const reply = lastReply(state);
        if (reply === undefined || !canGenerateAlternate(state) || !idle()) return;
        if (locked(state.messages.length - 1)) return;
        const subject = deps.subject === undefined ? null : await prepare();
        // Only the alternate shown when Replace was chosen is replaced, as it was then.
        if (subject === undefined || !idle() || !stillTarget(reply)) return;
        const latest = get();
        if (!canGenerateAlternate(latest)) {
          set({ macroNotice: "changed" });
          return;
        }
        await generateReply(
          reply.id,
          latest.messages.slice(0, -1),
          reply.shown,
          "regenerate",
          subject,
        );
      },

      continueReply: async () => {
        if (!idle()) return;
        const reply = lastReply(get());
        if (reply === undefined || reply.greeting || locked(get().messages.length - 1)) return;
        const subject = deps.subject === undefined ? null : await prepare();
        // Only the alternate shown when Continue was chosen is continued, as it was then.
        if (subject === undefined || !idle() || !stillTarget(reply)) return;
        await continueLast(subject);
      },

      impersonate: async () => {
        if (!idle()) return;
        const subject = deps.subject === undefined ? null : await prepare();
        if (subject === undefined || !idle()) return;
        await writeForMe(subject);
      },

      edit: (id, text) => {
        const index = get().messages.findIndex((message) => message.id === id);
        if (get().generating || index === -1 || locked(index)) {
          return;
        }
        const unsent = !sentMessages(get().messages).some((message) => message.id === id);
        cast.invalidateFrom(index);
        patchMessage(id, (message) => {
          if (message.role === "user") return { ...message, text };
          const reply = shownReply(message);
          return {
            ...message,
            edited: true,
            replies: message.replies.map((other): Reply => {
              if (other.id !== reply.id) return other;
              // An edited reply is the user's text now, sent as written: no longer failed or refused,
              // and never filled again.
              const {
                refusal: _refusal,
                busy: _busy,
                failed: _failed,
                finishReason: _finishReason,
                ...rest
              } = literalReply(other);
              return {
                ...rest,
                text,
                status: "complete",
                castVersion: (other.castVersion ?? 0) + 1,
              };
            }),
          };
        });
        // A failed or empty reply edited into a sent one joins the history: later events move up.
        const { messages, eventsState } = get();
        const turn = sentMessages(live(messages)).findIndex((message) => message.id === id);
        set({
          deleted: null,
          ...(eventsState === null || !unsent || turn === -1
            ? {}
            : { eventsState: eventsAfterInsertion(eventsState, turn) }),
        });
        get().schedulePreview();
      },

      remove: (id) => {
        const { messages, generating } = get();
        const index = messages.findIndex((message) => message.id === id);
        const message = messages[index];
        if (generating || message === undefined || locked(index)) return;
        // The greeting's effects stay, as everything committed does; its choices no longer change them.
        if (message.role === "assistant" && message.greeting) greetingBase = null;
        // The events that fired on it are forgotten, and the later ones move down with the turns.
        const { eventsState } = get();
        const turn = sentMessages(live(messages)).indexOf(message);
        // The pictures that followed it go for good: Undo brings back the message alone.
        scene.drop((anchorId) => anchorId === id);
        const taken = cast.invalidateFrom(index, true);
        set((state) => ({
          messages: messages.toSpliced(index, 1),
          deleted: { kind: "messages", messages: [message], index, eventsState, cast: taken },
          editing: state.editing?.id === id ? null : state.editing,
          ...(eventsState === null || turn === -1
            ? {}
            : { eventsState: eventsAfterDeletion(eventsState, turn) }),
        }));
        get().schedulePreview();
      },

      removeFrom: (id) => {
        const { messages, generating } = get();
        const index = messages.findIndex((message) => message.id === id);
        if (generating || index === -1 || locked(index)) return;
        const removed = messages.slice(index);
        if (removed.some((message) => message.role === "assistant" && message.greeting)) {
          greetingBase = null;
        }
        // Events that fired on a removed turn are forgotten; the turns kept are all before the cut.
        const { eventsState } = get();
        const cut = sentMessages(messages.slice(get().memory.horizon, index)).length;
        const gone = new Set(removed.map((message) => message.id));
        scene.drop((anchorId) => gone.has(anchorId));
        const taken = cast.take(replyIdsOf(removed));
        set((state) => ({
          messages: messages.slice(0, index),
          deleted: { kind: "messages", messages: removed, index, eventsState, cast: taken },
          ...(eventsState === null ? {} : { eventsState: eventsAfterTruncation(eventsState, cut) }),
          editing: removed.some((message) => message.id === state.editing?.id)
            ? null
            : state.editing,
        }));
        get().schedulePreview();
      },

      removeAlternate: () => {
        const state = get();
        const message = lastReply(state);
        if (message === undefined || state.generating || message.replies.length < 2) return;
        if (locked(state.messages.length - 1)) return;
        const index = message.shown;
        const reply = shownReply(message);
        patchMessage(message.id, () => ({
          ...message,
          replies: message.replies.toSpliced(index, 1),
          // The one before it shows, or the new first when the first went.
          shown: Math.max(0, index - 1),
        }));
        const taken = cast.take([reply.id]);
        set((current) => ({
          deleted: { kind: "alternate", messageId: message.id, reply, index, cast: taken },
          editing: current.editing?.id === message.id ? null : current.editing,
        }));
        syncGreeting();
        get().schedulePreview();
      },

      startEdit: (id, target = "text", fromComposer = false) => {
        const index = get().messages.findIndex((other) => other.id === id);
        const message = get().messages[index];
        if (message === undefined || (target === "reasoning" && message.role === "user")) return;
        if (locked(index)) return;
        // A reply waiting for sign-in has nothing to edit yet.
        if (message.role === "assistant" && shownReply(message).status === "waiting") return;
        const text =
          message.role === "user"
            ? message.text
            : target === "reasoning"
              ? shownReply(message).reasoning
              : shownReply(message).text;
        set({ editing: { id, text, target, ...(fromComposer ? { fromComposer: true } : {}) } });
      },

      setEditText: (text) =>
        set((state) => (state.editing ? { editing: { ...state.editing, text } } : {})),

      saveEdit: () => {
        const { editing, generating, messages } = get();
        if (editing === null || generating) return false;
        if (locked(messages.findIndex((message) => message.id === editing.id))) return false;
        if (editing.target === "reasoning") {
          // Blank reasoning removes it.
          const reasoning = editing.text.trim() === "" ? "" : editing.text;
          patchMessage(editing.id, (message) =>
            message.role === "assistant"
              ? {
                  ...message,
                  replies: message.replies.map((reply) =>
                    reply.id === shownReply(message).id ? { ...reply, reasoning } : reply,
                  ),
                }
              : message,
          );
          set({ editing: null, deleted: null });
          get().schedulePreview();
          return true;
        }
        if (editing.text.trim() === "") return false;
        get().edit(editing.id, editing.text);
        set({ editing: null });
        return true;
      },

      cancelEdit: () => set({ editing: null }),

      undoDelete: () => {
        const { deleted, messages, generating } = get();
        if (deleted === null || generating) return;
        // Nothing comes back into the folded turns, or into a span being remembered.
        const at =
          deleted.kind === "messages"
            ? deleted.index
            : messages.findIndex((message) => message.id === deleted.messageId);
        if (at !== -1 && at < lockedBefore(get())) return;
        cast.restore(deleted.cast);
        if (deleted.kind === "messages") {
          set({
            messages: messages.toSpliced(
              Math.min(deleted.index, messages.length),
              0,
              ...deleted.messages,
            ),
            deleted: null,
            ...(deleted.eventsState === undefined ? {} : { eventsState: deleted.eventsState }),
          });
        } else {
          endEditOf(deleted.messageId);
          patchMessage(deleted.messageId, (message) => {
            if (message.role !== "assistant") return message;
            const index = Math.min(deleted.index, message.replies.length);
            return {
              ...message,
              replies: message.replies.toSpliced(index, 0, deleted.reply),
              shown: index,
            };
          });
          set({ deleted: null });
          syncGreeting();
        }
        get().schedulePreview();
      },

      requestPreview: async () => {
        const { messages, draft, epoch, generating } = get();
        const chosen = selection();
        // Signed out, the chat would only reach the sign-in redirect; the renewal previews again.
        // While a reply streams, the preview after it says what comes next.
        if (chosen.model === null || !signedIn() || generating) return;
        clearTimeout(previewTimer);
        previewing?.abort();
        const controller = new AbortController();
        previewing = controller;
        const { turns } = history(live(messages), chosen.reasoning);
        let draftTurn: ChatTurn | null =
          draft.trim() === "" ? null : { role: "user", content: draft };
        set((state) => ({
          preview: {
            status: "loading",
            prompt: state.preview.prompt,
            draftIndex: draftTurn === null ? null : turns.length,
          },
        }));
        // The draft as Send would fill it, on a copy of the state: a preview never commits.
        let macroState = get().macroState;
        if (deps.subject !== undefined) {
          const loaded = await deps.subject(chosen).catch((): SubjectResult => ({ ok: false }));
          if (controller.signal.aborted || get().epoch !== epoch) return;
          // Refused as the server would refuse it: nothing can be sized without a window.
          if (!loaded.ok && loaded.reason === "context_window_unknown") {
            previewing = undefined;
            set({ preview: { status: "context_window_unknown", prompt: null, draftIndex: null } });
            return;
          }
          if (loaded.ok) {
            const { subject } = loaded;
            const source = draft;
            const filled = source.trim() === "" ? null : fill(source, subject, messages, "normal");
            if (filled !== null && filled.content.trim() !== "") {
              const name = speakerOf(subject);
              draftTurn = {
                role: "user",
                content: filled.content,
                ...(name === undefined ? {} : { name }),
              };
              macroState = filled.macroState;
            }
          }
        }
        const clock = deps.clock();
        const { model } = chosen;
        const withDraft = (sent: ChatTurn[]) => (draftTurn === null ? sent : [...sent, draftTurn]);
        // Past the server's bounds the tab folds held spans for a preview as a send would.
        const request: PreviewRequest = withinLimits(() => ({
          ...selected({ ...chosen, model }, clock, get(), recapFor(chosen)),
          macroState: cloneMacroState(macroState),
          generationType: "normal",
          macroRuntime: runtimeOf(messages, "normal", clock),
          messages: withDraft(history(live(messages), chosen.reasoning).turns),
          ...castBefore(messages.length),
        }));
        const sentTurns = request.messages.length - (draftTurn === null ? 0 : 1);
        let result: PreviewResult;
        try {
          result = await deps.fetchPreview(request, controller.signal);
        } catch {
          result = { ok: false, error: "unavailable" };
        }
        // A newer preview, a Clear or a closed tab owns the state now.
        if (controller.signal.aborted || get().epoch !== epoch) return;
        previewing = undefined;
        // A preview's fold is only shown, never applied: its history starts after the turns it
        // folded, the draft among what is left.
        const draftIndex =
          draftTurn === null || !result.ok
            ? null
            : sentTurns - (result.prompt.memoryFold?.turns ?? 0);
        set({
          preview: result.ok
            ? { status: "ready", prompt: result.prompt, draftIndex }
            : {
                status: result.error === "unavailable" ? "failed" : result.error,
                prompt: null,
                draftIndex: null,
              },
        });
      },

      schedulePreview: () => {
        clearTimeout(previewTimer);
        if (get().generating || selection().model === null || !signedIn()) return;
        previewTimer = setTimeout(() => void get().requestPreview(), PREVIEW_DEBOUNCE_MS);
      },

      stop: () => {
        get().stopScene();
        for (const controller of inFlight) controller.abort();
      },

      /** One operation: advance the epoch, abort everything in flight, empty the chat and the inspector. */
      clear: () => {
        generations.clear();
        usageSequence = 0;
        scene.drop(() => true);
        cast.reset();
        for (const controller of inFlight) controller.abort();
        inFlight.clear();
        previewing?.abort();
        previewing = undefined;
        clearTimeout(previewTimer);
        // A memory call of the old chat is aborted; the server's write, if any, stands.
        remembering?.abort();
        remembering = undefined;
        forgetting = null;
        heldForEdit = false;
        heldMemoryGeneration = null;
        editChanged = false;
        lockedPending = null;
        // Local and global variables go with the chat; a late write of the old epoch is dropped.
        greetingBase = null;
        // An action still loading its subject belongs to the old chat: the new one need not wait.
        preparing = null;
        set((state) => ({
          epoch: state.epoch + 1,
          usage: emptyUsage(),
          pickSeed: newPickSeed(),
          cacheKey: newCacheKey(),
          lorebookState: null,
          eventsState: null,
          macroState: emptyMacroState(),
          macroNotice: null,
          greetingFailed: false,
          messages: [],
          draft: "",
          generating: false,
          generationMode: null,
          deleted: null,
          editing: null,
          impersonation: null,
          lastSent: null,
          preview: NO_PREVIEW,
          pending: null,
          memory: NO_MEMORY,
          scenes: [],
          cast: EMPTY_CAST,
        }));
      },

      resume: async () => {
        const { pending, generating } = get();
        if (pending === null || generating || preparing) return false;
        // Without a model nothing can go out: it keeps waiting, as it is shown.
        if (selection().model === null) return false;
        // The message it answers was filled when it was sent: only the generation runs again,
        // as the type it was asked for. Without its subject it keeps waiting.
        const forMessage = (messages: ChatMessage[]) =>
          pending.mode === "impersonate"
            ? undefined
            : messages.find((message) => message.id === pending.messageId);
        const target = forMessage(get().messages);
        const subject = deps.subject === undefined ? null : await prepare();
        if (subject === undefined || get().pending !== pending) return false;
        // Its reply was edited, switched or deleted while the subject loaded: it keeps waiting.
        if (forMessage(get().messages) !== target) {
          set({ macroNotice: "changed" });
          return false;
        }
        const { messages } = get();
        // Its reply is remembered, being remembered, or its memory's answer was lost: it keeps
        // waiting, and goes on its own once the lock ends.
        if (target !== undefined && locked(messages.indexOf(target))) {
          lockedPending = { pending, messageId: target.id, epoch: get().epoch };
          return false;
        }
        set({ pending: null });
        return new Promise<boolean>((resolve) => {
          const started = () => resolve(true);
          let running: Promise<void> | undefined;
          if (pending.mode === "impersonate") {
            running = writeForMe(subject, started);
          } else {
            const at = messages.findIndex((message) => message.id === pending.messageId);
            const message = messages[at];
            const index =
              message?.role === "assistant"
                ? message.replies.findIndex((reply) => reply.id === pending.replyId)
                : -1;
            // What it was for is gone (deleted, or another alternate is the last reply's now).
            if (message?.role === "assistant" && index !== -1) {
              if (pending.mode === "continue") {
                if (at === messages.length - 1 && shownReply(message).id === pending.replyId) {
                  running = continueLast(subject, started);
                }
              } else {
                running = generateReply(
                  pending.messageId,
                  messages.slice(0, at),
                  index,
                  pending.type,
                  subject,
                  started,
                );
              }
            }
          }
          void (running ?? Promise.resolve()).finally(() => resolve(false));
        });
      },

      rememberNow: async () => {
        await rememberSpan(true);
      },

      rememberEnding: async () => {
        const { epoch } = get();
        const moved = () => get().epoch !== epoch;
        for (;;) {
          // An open edit among the ending's turns holds it whole, before anything is written or
          // waited for: the chat stays as it is until the edit is saved or cancelled.
          const state = get();
          if (editHolds(state, { from: rememberedEnd(state.memory), to: state.messages.length })) {
            return { status: "editing" };
          }
          // A reply still streaming settles first, whole; then a memory call or a Forget under
          // way answers. Each may start the next (a settled reply starts a call), so all of
          // them are checked again after any wait.
          if (get().generating) {
            await until(() => !get().generating || moved());
          } else if (rememberRun !== undefined) {
            await rememberRun;
          } else if (forgetRun !== undefined) {
            await forgetRun;
          }
          if (moved()) return { status: "cancelled" };
          if (get().generating || rememberRun !== undefined || forgetRun !== undefined) continue;
          // Newest turns included, and a single one is enough: nothing of the ending is left out.
          const run = await rememberSpan(true, 0, ENDING_LEAST);
          switch (run.status) {
            case "written":
            case "busy":
            case "moved":
              // Written: a lost answer's span may have been all it took, so the rest goes next.
              continue;
            case "none":
              return { status: "done" };
            case "editing":
              return { status: "editing" };
            case "cancelled":
              return { status: "cancelled" };
            case "failed":
              // A lost answer keeps its span read-only, with its attempt, for the next call.
              return { status: "failed", reason: run.reason };
          }
        }
      },

      forgetLatest: async () => {
        const memoryDeps = deps.memory;
        const { epoch, memory } = get();
        const latest = latestMemory(memory);
        const end = rememberedEnd(memory);
        // A memory being written, or one whose answer was lost, starts where the latest ends.
        if (memoryDeps === undefined || latest === null || memory.pending !== null) return;
        if (forgetting !== null) return;
        const token = {};
        forgetting = token;
        let forgot: boolean;
        const call = memoryDeps.forget(latest.id);
        forgetRun = call;
        try {
          forgot = await call;
        } catch {
          forgot = false;
        } finally {
          if (forgetting === token) forgetting = null;
          if (forgetRun === call) forgetRun = undefined;
        }
        // Only for the chat, the memory and the remembered turns it was asked for. A request
        // folding it meanwhile leaves both as they were: it unfolds instead of being freed.
        const now = get();
        if (!forgot || now.epoch !== epoch) return;
        if (latestMemory(now.memory)?.id !== latest.id || rememberedEnd(now.memory) !== end) return;
        get().episodeGone(latest.id);
        const { characterId } = selection();
        if (characterId !== null) memoryDeps.changed?.(characterId);
      },

      episodeGone: (id) => {
        const { memory } = get();
        const { held, foldedLatest } = memory;
        const at = held.findIndex((span) => span.id === id);
        const recap = memory.recap.filter((other) => other !== id);
        // The remembered end moves back: a lost answer's attempt was for the chat as it was, so
        // it is dropped; the call running keeps its span until it answers.
        const dropped: Partial<ChatMemory> =
          memory.pending === null || memory.status === "remembering"
            ? {}
            : { status: "idle", boundary: null, pending: null };
        if (at !== -1 && at === held.length - 1) {
          // The latest memory, held: its turns are no longer remembered, and the next memory
          // call takes them again.
          set({ memory: { ...memory, held: held.slice(0, -1), ...dropped } });
        } else if (at !== -1) {
          // An older held one: its turns join the next held span, so nothing is remembered
          // twice, and the story goes without that memory, as without a deleted folded one.
          const next = held[at + 1];
          if (next === undefined) return;
          set({
            memory: {
              ...memory,
              held: held.toSpliced(at, 2, { ...next, from: held[at]?.from ?? next.from }),
            },
          });
        } else if (foldedLatest?.id === id && held.length === 0) {
          // The latest memory, folded: the horizon moves back and its turns unfold.
          moveHorizon(foldedLatest.from, { recap, foldedLatest: null, ...dropped });
        } else if (memory.recap.includes(id) || foldedLatest?.id === id) {
          // An older folded episode leaves the recap; the horizon stays, and so does a pending
          // attempt. Behind held memories, the newest folded one is no longer Forget's to unfold.
          set({
            memory: {
              ...memory,
              recap,
              ...(foldedLatest?.id === id ? { foldedLatest: null } : {}),
            },
          });
        } else {
          return;
        }
        get().schedulePreview();
      },

      memoryReset: () => {
        remembering?.abort();
        remembering = undefined;
        forgetting = null;
        const { horizon, held, boundary, recap, foldedLatest, status, pending } = get().memory;
        const empty =
          horizon === 0 &&
          held.length === 0 &&
          boundary === null &&
          recap.length === 0 &&
          foldedLatest === null &&
          pending === null;
        if (empty && status === "idle") return;
        moveHorizon(0, NO_MEMORY);
        get().schedulePreview();
      },

      showFolded: (shown) => set((state) => ({ memory: { ...state.memory, shown } })),
    };
  });
  if (onStateChange !== undefined) store.subscribe(onStateChange);
  return store;
}
