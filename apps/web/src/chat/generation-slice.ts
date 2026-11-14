import {
  type CallAccounting,
  type CallPurpose,
  type ChatMemoryState,
  type ChatTurn,
  type Clock,
  clipText,
  cloneMacroState,
  eventsAfterFold,
  fillChatText,
  type GenerateRequest,
  type GenerationMode,
  type GenerationType,
  humanizeIdleDuration,
  type InspectedPrompt,
  joinContinuation,
  lorebookStateAfterFold,
  MAX_SWIPE_ID,
  type MacroInput,
  MacroLimitError,
  type MacroRuntime,
  type MacroState,
  PRESET_LIMITS,
  type PreviewRequest,
  type RefusalCode,
  randomUniform,
  type UpstreamFailure,
} from "@ephemera/core";
import type { StoreApi } from "zustand/vanilla";
import { type CastTaken, registerAt } from "./cast-slice.ts";
import {
  canGenerateAlternate,
  history,
  isUser,
  lastReply,
  literalReply,
  newReply,
  sentMessages,
} from "./messages.ts";
import {
  failureOf,
  isSignedOut,
  PREVIEW_DEBOUNCE_MS,
  sameSubject,
  selected,
  sentWith,
} from "./request.ts";
import { shownReply } from "./shown-reply.ts";
import type {
  AssistantMessage,
  ChatDeps,
  ChatMessage,
  ChatState,
  GenerationEnd,
  MacroSubject,
  Pending,
  RememberRun,
  Reply,
  ReplyType,
  Selection,
  Speaker,
  StreamReply,
  SubjectResult,
  Target,
  UserMessage,
} from "./store.ts";
import type { PartialReplyFinishReason, PreviewResult } from "./transport.ts";
import type { UsageHandle } from "./usage.ts";

/*
 * The chat's generations (PRINCIPLES.md 1): the one run every reply,
 * continuation and Write for me goes through, the actions that start, resume
 * and stop one, and the preview of the next prompt, which a run ends when it
 * starts and asks for again when it settles. A run writes only while the
 * session epoch it started in is current, so nothing late lands in a chat
 * that was cleared.
 */

/** What a generation reads besides the chat. */
export type GenerationDeps = Pick<
  ChatDeps,
  | "clock"
  | "now"
  | "fetchPreview"
  | "signedIn"
  | "resumable"
  | "subject"
  | "isMobile"
  | "random"
  | "cast"
>;

/** What the chat store lends the slice. */
interface GenerationHost {
  /** What the saved settings choose now. */
  selection: () => Selection;
  streamReply: StreamReply;
  trackUsage: (
    purpose: CallPurpose,
    model: string,
    generation: string | null,
    id?: string,
  ) => UsageHandle;
  /** The generation each alternate came from, by reply id; a run records its own. */
  generations: Map<string, string>;
  /** The store's in-flight set: Stop and Clear abort every controller in it. */
  inFlight: Set<AbortController>;
  /** The cast slice: its sheet before a run, its keeper after a reply, its snapshots. */
  cast: {
    follow: () => boolean;
    ready: () => Promise<void>;
    take: (replyIds: readonly string[], invalidate?: boolean) => CastTaken;
    replied: (messageId: string) => void;
  };
  /** The memory slice: what a request carries and folds, and the call a settled reply asks for. */
  memory: {
    recapFor: (chosen: Selection) => ChatMemoryState | null;
    withinLimits: <T extends { messages: ChatTurn[] }>(build: () => T) => T;
    applyFold: (count: number) => void;
    crossed: (from: number, to: number) => { count: number; roles: ChatMessage["role"][] };
    rememberSpan: (
      force: boolean,
      keep?: number,
      least?: number,
      generation?: string | null,
    ) => Promise<RememberRun>;
    releaseHeld: () => void;
    heldForEdit: () => boolean;
  };
  /** The messages after the folded ones, which requests send. */
  live: (messages: ChatMessage[]) => ChatMessage[];
  /** The message at `index` is read-only (folded, or being remembered). */
  locked: (index: number) => boolean;
  patchMessage: (id: string, change: (message: ChatMessage) => ChatMessage) => void;
  endEditOf: (messageId: string) => void;
  showAlternate: (message: AssistantMessage, index: number) => void;
  commitMacros: (state: MacroState) => void;
}

type GenerationActions = Pick<
  ChatState,
  | "send"
  | "swipe"
  | "appendAlternate"
  | "regenerate"
  | "continueReply"
  | "impersonate"
  | "requestPreview"
  | "schedulePreview"
  | "stop"
  | "resume"
>;

export function createGenerationSlice(
  set: StoreApi<ChatState>["setState"],
  get: StoreApi<ChatState>["getState"],
  deps: GenerationDeps,
  host: GenerationHost,
) {
  const {
    selection,
    streamReply,
    generations,
    inFlight,
    cast,
    live,
    locked,
    patchMessage,
    endEditOf,
    showAlternate,
    commitMacros,
  } = host;
  const { recapFor, withinLimits, applyFold, crossed, rememberSpan, releaseHeld } = host.memory;
  const now = deps.now ?? (() => performance.now());

  // Kept outside the state: controllers and timers are not chat content and never render.
  let previewing: AbortController | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const random = deps.random ?? randomUniform;
  /**
   * The action waiting for its subject to load, by a token only it holds:
   * nothing else starts meanwhile, and only it (or a Clear) ends the wait.
   */
  let preparing: object | null = null;

  /** The open edit changed while a call was held for it; asked for again once the change is whole. */
  let editChanged = false;
  /**
   * The generation resume left waiting because memory locked its reply: it
   * goes once the lock ends, if it is still the one waiting, in the same chat.
   */
  let lockedPending: { pending: Pending; messageId: string; epoch: number } | null = null;
  /** Both are looked at once, after the change under way. */
  let settling = false;

  /** The register a request before message `index` carries; nothing while it is empty. */
  const castBefore = (index: number) => {
    const register = registerAt(get(), index);
    return register.entries.length === 0 ? {} : { cast: register };
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

  /** After every change of the state: an edit a memory call waits for may have changed. */
  const stateChanged = (state: ChatState, previous: ChatState) => {
    if (host.memory.heldForEdit() && state.editing?.id !== previous.editing?.id) editChanged = true;
    settle();
  };

  /**
   * What a request tells the macros about the browser: the prompt's first
   * kept turn last time, the thread's first turn, the last reply's alternate
   * (zero-based), the device, the composer, and the time since the user's
   * last message before this one (a send's own message is not counted).
   */
  const runtimeOf = (messages: ChatMessage[], type: GenerationType, clock: Clock): MacroRuntime => {
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

  /** Replaces one alternate of one reply, through `change`. */
  const changeReply = (messageId: string, replyId: string, change: (reply: Reply) => Reply) =>
    patchMessage(messageId, (message) =>
      message.role === "assistant"
        ? {
            ...message,
            replies: message.replies.map((reply) => (reply.id === replyId ? change(reply) : reply)),
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
        set({ generating: false, generationMode: null, generationEnd: "stopped" });
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
    const accounting = host.trackUsage("narration", request.model, generation);
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
    let ended: GenerationEnd | null = null;
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
      if (current()) {
        ended = controller.signal.aborted ? "stopped" : "complete";
        target.end({
          status: ended,
          ...(controller.signal.aborted || finishReason === undefined ? {} : { finishReason }),
        });
      }
    } catch (error) {
      // Only a refusal carries a refusal code; an abort's DOMException has a numeric `code` too.
      const refused = (error as { reason?: string }).reason === "refused";
      const code = refused ? (error as { code?: RefusalCode }).code : undefined;
      if (!isSignedOut(error) && !refused)
        unknownUsage = controller.signal.aborted ? "aborted" : "failed";
      const upstream = (error as { upstream?: UpstreamFailure }).upstream;
      if (current() && !arrived && isSignedOut(error) && !controller.signal.aborted) {
        target.wait();
        set({ pending: target.pending });
        // Refused for an older request after the session came back: it goes out now.
        retryNow = signedIn() && (deps.resumable?.() ?? true);
      } else if (current()) {
        ended = controller.signal.aborted ? "stopped" : "failed";
        // A refusal and a busy or signed-out provider have notes of their own.
        const failure =
          controller.signal.aborted || code !== undefined || upstream !== undefined
            ? undefined
            : failureOf(error);
        target.end({
          status: ended,
          ...(code === undefined ? {} : { refusal: code }),
          ...(upstream === undefined || controller.signal.aborted ? {} : { upstream }),
          ...(failure === undefined ? {} : { failure }),
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
        set({ generating: false, generationMode: null, generationEnd: ended });
        get().schedulePreview();
        if (retryNow) void get().resume();
        // A reply settled: the story may have grown enough to remember.
        else if (mode === "reply" || mode === "continue")
          void rememberSpan(false, undefined, 2, generation);
      }
    }
  };

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
    const endReply = ({
      status,
      refusal,
      upstream,
      failure,
      finishReason,
    }: Parameters<Target["end"]>[0]) => {
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
        ...(upstream === undefined ? {} : { upstream }),
        ...(failure === undefined ? {} : { failure }),
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
        end: ({ status, refusal, upstream }) => {
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
                    ...(upstream === undefined ? {} : { upstream }),
                  },
          });
        },
        wait: () => set({ draft: "" }),
        pending: { mode: "impersonate" },
      },
      started,
    );
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

  const actions: GenerationActions = {
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
      await get().appendAlternate();
    },

    appendAlternate: async () => {
      const state = get();
      const reply = lastReply(state);
      if (reply === undefined || locked(state.messages.length - 1)) return;
      // Greetings stop; replies generate another, always past the final alternate.
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
  };

  return {
    actions,
    stateChanged,
    /** Clear: the preview on its way and its timer end, and nothing waits any longer. */
    reset: () => {
      previewing?.abort();
      previewing = undefined;
      clearTimeout(previewTimer);
      editChanged = false;
      lockedPending = null;
      // An action still loading its subject belongs to the old chat: the new one need not wait.
      preparing = null;
    },
  };
}
