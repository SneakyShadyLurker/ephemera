import {
  type CallAccounting,
  type CallPurpose,
  type CharacterCard,
  type ChatTurn,
  type Clock,
  castPeopleNotes,
  cloneMacroState,
  type EventsState,
  emptyMacroState,
  eventsAfterDeletion,
  eventsAfterInsertion,
  eventsAfterTruncation,
  type GenerateRequest,
  type GenerationMode,
  type GenerationType,
  type GreetingKey,
  type InspectedPrompt,
  type LorebookState,
  type MacroInput,
  type MacroState,
  type MemoryState,
  type PreviewRequest,
  type PromptPreset,
  type PromptReasoning,
  type ReasoningEffort,
  type RefusalCode,
  type RememberRequest,
  randomSeed,
  type UpstreamFailure,
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
} from "./cast-slice.ts";
import { createGenerationSlice } from "./generation-slice.ts";
import { createMemorySlice } from "./memory-slice.ts";
import {
  editHolds,
  latestMemory,
  NO_MEMORY,
  rememberedEnd,
  spanToRemember,
} from "./memory-span.ts";
import {
  canGenerateAlternate,
  isSent,
  lastReply,
  literalReply,
  sentMessages,
  shownText,
  shownTurns,
} from "./messages.ts";
import { PREVIEW_DEBOUNCE_MS } from "./request.ts";
import { createSceneSlice, type SceneDeps, type SceneSliceState } from "./scene-slice.ts";
import { shownReply } from "./shown-reply.ts";
import type { PartialReplyFinishReason, PreviewResult, ReplyUpdate } from "./transport.ts";
import {
  emptyUsage,
  finishUsage,
  receiveUsage,
  startUsage,
  type UsageHandle,
  type UsageLedger,
} from "./usage.ts";

export {
  canGenerateAlternate,
  editHolds,
  lastReply,
  latestMemory,
  NO_MEMORY,
  PREVIEW_DEBOUNCE_MS,
  rememberedEnd,
  shownReply,
  spanToRemember,
};

export type MessageStatus = "complete" | "streaming" | "stopped" | "failed" | "waiting";

export type ReplyFailure = "unreachable" | "server" | "provider" | "stream" | "unreadable";

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
  /** It failed because the model's provider stayed busy through the server's retries, or is signed out. */
  upstream?: UpstreamFailure;
  /**
   * Why it failed, for its note: the request never reached the server, the
   * server answered with an error, the provider's error came down the stream,
   * the stream broke off, or what came down it could not be read. A status like `provider`,
   * never content, and kept nowhere but this store.
   */
  failure?: ReplyFailure;
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

export interface UserMessage {
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
  /** The tab's reasoning effort in place of the sampler preset's; null follows the preset. */
  reasoningEffort: ReasoningEffort | null;
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
export type Pending =
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
  upstream?: UpstreamFailure;
} | null;

/** The generation types of a reply: a sent message, a Replace, or a new alternate. */
export type ReplyType = Extract<GenerationType, "normal" | "regenerate" | "swipe">;

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
 * persona and prompt preset the selection names, as loaded, and the
 * model's runtime.
 * Not chat content.
 */
export interface MacroSubject {
  character: CharacterCard | null;
  persona: { name: string; description: string } | null;
  /** The chosen prompt preset, or the built-in default without one. */
  preset: PromptPreset;
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
export interface HeldSpan {
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

/**
 * What one memory call came to: `written`; `none`, nothing to remember now;
 * `busy`, a call or a Forget under way, so none went out; `editing`, an open
 * edit in the span, so none went out; `moved`, the remembered turns changed
 * under the call, so nothing was held; `cancelled`, the chat was cleared or
 * memory reset meanwhile; or `failed`, and why.
 */
export type RememberRun =
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
export interface MemoryDeps {
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
  /**
   * How the latest generation ended, whatever it left on show (a failed
   * Continue or Replace puts the earlier reply back, Write for me writes
   * no message); null before any, after Clear and while one waits for a
   * sign-in. Not chat content.
   */
  generationEnd: GenerationEnd | null;
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
  /** Appends a new alternate regardless of which reply is shown. */
  appendAlternate: () => Promise<void>;
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

export interface ChatDeps {
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
 * Who spoke a sent turn: the persona a user turn was sent as and the name it
 * was sent under; null for a reply or a turn sent as no persona.
 */
export type Speaker = { personaId: string; name: string | null } | null;

/**
 * The turns Remember now would send: the unremembered messages but the
 * newest `keepTurns`, as the thread shows them. Two or more make a span.
 */
export function rememberableTurns(state: ChatState, keepTurns: number): ChatTurn[] {
  const end = rememberedEnd(state.memory);
  const boundary = state.messages.length - keepTurns;
  return boundary <= end ? [] : shownTurns(state.messages.slice(end, boundary));
}

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

/** The greeting nobody touched when the chat holds only that: the card's, which a fill replaces. */
function untouchedGreeting(messages: ChatMessage[]): AssistantMessage | undefined {
  const [only] = messages;
  return messages.length === 1 && only?.role === "assistant" && only.greeting && !only.edited
    ? only
    : undefined;
}

/** Nothing in the story yet, not even a greeting or a deletion's tombstone: the empty story shows. */
export function storyEmpty(state: ChatState): boolean {
  return state.messages.length === 0 && state.deleted === null;
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

/** How a generation ended. */
export type GenerationEnd = "complete" | "stopped" | "failed";

export interface Target {
  /** Applies the latest update; `prompt` is present from the first update on. */
  update: (update: ReplyUpdate, sentPrompt: InspectedPrompt | undefined) => void;
  end: (outcome: {
    status: "complete" | "stopped" | "failed";
    refusal?: RefusalCode;
    upstream?: UpstreamFailure;
    failure?: ReplyFailure;
    finishReason?: PartialReplyFinishReason;
  }) => void;
  /** Refused as signed out before anything arrived: undo what the start showed, wait. */
  wait: () => void;
  pending: Pending;
}

export function createChatStore(
  streamReply: StreamReply,
  selection: () => Selection,
  deps: ChatDeps,
) {
  const generations = new Map<string, string>();
  let usageSequence = 0;
  const newPickSeed = deps.pickSeed ?? randomSeed;
  const newCacheKey = deps.cacheKey ?? (() => crypto.randomUUID());
  // Kept outside the state: controllers and timers are not chat content and never render.
  const inFlight = new Set<AbortController>();
  /**
   * The macro state before the lone greeting's choices, while the shown
   * choice's is the last one committed; null once anything else committed.
   * Chat content: tab memory only.
   */
  let greetingBase: MacroState | null = null;
  let onStateChange: ((state: ChatState, previous: ChatState) => void) | undefined;

  const store = createStore<ChatState>()((set, get, api) => {
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

    const memory = createMemorySlice(set, get, deps.memory, {
      selection,
      subscribe: api.subscribe,
      trackUsage: (purpose, model, generation, id) =>
        get().trackUsage(purpose, model, generation, id),
    });

    /** The message at `index` is read-only (folded, or being remembered). */
    const locked = (index: number) => index !== -1 && index < lockedBefore(get());

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

    /**
     * An open edit of a message whose shown alternate is about to change is
     * closed: saving it would write onto another alternate.
     */
    const endEditOf = (messageId: string) =>
      set((state) => (state.editing?.id === messageId ? { editing: null } : {}));

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

    const generation = createGenerationSlice(set, get, deps, {
      selection,
      streamReply,
      trackUsage: (purpose, model, generation, id) =>
        get().trackUsage(purpose, model, generation, id),
      generations,
      inFlight,
      cast,
      memory,
      live,
      locked,
      patchMessage,
      endEditOf,
      showAlternate,
      commitMacros,
    });
    onStateChange = generation.stateChanged;

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
      generationEnd: null,
      deleted: null,
      editing: null,
      impersonation: null,
      lastSent: null,
      preview: NO_PREVIEW,
      pending: null,
      memory: NO_MEMORY,
      ...scene.actions,
      ...cast.actions,
      ...memory.actions,
      ...generation.actions,

      setDraft: (draft) => {
        set({ draft, impersonation: null, macroNotice: null });
        get().schedulePreview();
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
                upstream: _upstream,
                failure: _failure,
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

      /** One operation: advance the epoch, abort everything in flight, empty the chat and the inspector. */
      clear: () => {
        generations.clear();
        usageSequence = 0;
        scene.drop(() => true);
        cast.reset();
        for (const controller of inFlight) controller.abort();
        inFlight.clear();
        generation.reset();
        memory.reset();
        // Local and global variables go with the chat; a late write of the old epoch is dropped.
        greetingBase = null;
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
          generationEnd: null,
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
    };
  });
  if (onStateChange !== undefined) store.subscribe(onStateChange);
  return store;
}
