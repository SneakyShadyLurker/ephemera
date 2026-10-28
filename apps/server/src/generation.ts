import {
  type AssemblyInput,
  assemblePrompt,
  type CallSettings,
  calibrationRatio,
  chaptersHolding,
  defaultPromptPreset,
  type EventsState,
  effortFor,
  eventsAfterFold,
  fitProcessed,
  foldToFit,
  type GenerationMode,
  type InspectedPrompt,
  type LorebookEntry,
  lorebookStateAfterFold,
  MacroLimitError,
  memoizedCount,
  memoryIsOn,
  memoryStateOf,
  NO_CHARACTER_NAME,
  NO_PERSONA_NAME,
  nextEventsState,
  type PreviewRequest,
  type PromptReasoning,
  promptBudget,
  type RefusalCode,
  randomUniform,
  reconcileRecap,
  replayableRandom,
  replyReserve,
  rollEvents,
  type SamplerValues,
  storyBefore,
} from "@ephemera/core";
import type { Catalog } from "./catalog.ts";
import type { UserInstance } from "./persistence/store.ts";
import { chosenPersona } from "./personas.ts";
import { countMessage, countText, PRIMING } from "./tokens.ts";
import { resolveModel } from "./upstream.ts";

/*
 * One request's prompt: the saved entities it names, assembled and fitted to
 * the model's window by packages/core. Everything here is chat content and
 * lives only for the request; the per-model calibration ratio is a number
 * learned from usage, kept in the user's instance in memory and never persisted.
 */

/**
 * A sampler preset's set values as AI SDK call settings; values left at the
 * model default are omitted, so nothing the user never set is sent.
 */
export function callSettings(values: SamplerValues | undefined): CallSettings {
  if (values === undefined) return {};
  const { maxOutputTokens, temperature, topP, frequencyPenalty, presencePenalty, seed, reasoning } =
    values;
  return {
    ...(maxOutputTokens === null ? {} : { maxOutputTokens }),
    ...(temperature === null ? {} : { temperature }),
    ...(topP === null ? {} : { topP }),
    ...(frequencyPenalty === null ? {} : { frequencyPenalty }),
    ...(presencePenalty === null ? {} : { presencePenalty }),
    ...(seed === null ? {} : { seed }),
    ...(reasoning === "provider-default" ? {} : { reasoning }),
  };
}

/**
 * A prompt this small says more about fixed overhead upstream (instructions a
 * proxy adds) than about the tokenizer, so it does not calibrate.
 */
const MIN_CALIBRATION_SAMPLE = 1_024;
/** Calibrations kept at most per user; a bound, since the model id comes from the request. */
const MAX_CALIBRATED_MODELS = 1_000;

/**
 * Learns from the model's own count of a sent prompt, into the user's calibration map
 * every call to the model writes: the chat's and each object call's.
 */
export function calibrate(
  calibration: UserInstance["calibration"],
  model: string,
  uncalibrated: number,
  inputTokens: number | undefined,
) {
  if (inputTokens === undefined || uncalibrated < MIN_CALIBRATION_SAMPLE) return;
  if (!calibration.has(model) && calibration.size >= MAX_CALIBRATED_MODELS) return;
  calibration.set(model, calibrationRatio(inputTokens, uncalibrated));
}

export type Prepared =
  | {
      ok: true;
      prompt: InspectedPrompt;
      /** The estimate before calibration, to compare with the model's count. */
      uncalibrated: number;
      /** How the reply's reasoning is read (Auto-Parse). */
      reasoning: PromptReasoning;
    }
  | { ok: false; error: RefusalCode | "aborted" };

/**
 * A lorebook entry's digest for its timed state (packages/core lorebook/timed.ts),
 * as hex; the runtime supplies it (app.ts), since this module is also typed for
 * the web app's RPC client.
 */
export type EntryDigest = (entry: LorebookEntry) => string;

/**
 * What a prepared prompt is for: sent upstream, or only shown (the
 * inspector's preview of a draft). A preview rolls no event: it could not
 * predict a random outcome, so it returns the carried events state as it came.
 */
type Purpose = "send" | "preview";

/**
 * The character's memory for assembly while it is on (core `memoryIsOn`:
 * a character without a notebook row is on, its notebook empty) and the request
 * carries a `memoryState`, as a function of the held spans a prompt folds:
 * the notebook, this chat's folded episodes the request names, then the
 * `folded` held ones, as the book has them now (`reconcileRecap`), and the
 * rest of the book as recall candidates, chapter members included. A held
 * memory is never a candidate, folded or not: its turns are in the history,
 * or its memory is in the story block. Every request also gets the story
 * before this chat (`storyBefore`) outside the chat's own memories, which
 * are then no candidates; computed per request,
 * never stored. A request that names no memory of its chat (no folded
 * episode, no held span, no folded turn) is `fresh`, a new scene, or
 * `continued`, the last scene going on, when the tab says its greeting in
 * play is the memory's opening (chat state, read for this request only). A
 * request without a `memoryState` (its memory reads as off) gets none, so
 * memory goes only into the prompts of the tab that folds.
 */
function memoryInput(
  stores: UserInstance["stores"],
  request: Pick<PreviewRequest, "characterId" | "memoryState">,
  count: (text: string) => number,
  window: number,
): ((folded: readonly string[]) => NonNullable<AssemblyInput["memory"]>) | null {
  if (request.characterId === undefined || request.memoryState === undefined) return null;
  const state = memoryStateOf(stores.memory.state(request.characterId) ?? null);
  if (!memoryIsOn(state)) return null;
  const book = stores.memory.list(request.characterId);
  const { recap: sent, held, folded: foldedTurns } = request.memoryState;
  const heldIds = new Set(held.map(({ id }) => id));
  // Nothing of this chat is remembered yet: a new scene.
  const fresh = sent.length === 0 && held.length === 0 && foldedTurns === 0;
  // A fresh chat opened on the memory's opening is the day after the last scene ended.
  const continued = fresh && request.memoryState.continued;
  // The chat's own memories, as the book has them now, are never the story before it.
  const own = new Set([
    ...heldIds,
    ...reconcileRecap([...sent, ...heldIds], book).map((episode) => episode.id),
  ]);
  const before = storyBefore(book, window, own);
  // A held memory's turns are in the history: neither it nor any chapter that took it since
  // (another chat's roll-up of the book), at any depth, is recalled.
  const heldChapters = chaptersHolding(heldIds, book);
  return (folded) => {
    const recap = reconcileRecap([...sent, ...folded], book);
    const told = new Set([...[...recap, ...before].map((episode) => episode.id), ...heldChapters]);
    return {
      notebook: state.notebook,
      recap,
      before,
      fresh,
      continued,
      candidates: book.filter((episode) => !told.has(episode.id) && !heldIds.has(episode.id)),
      count,
      window,
    };
  };
}

/**
 * `random` feeds `{{random}}` and `{{roll}}`, lorebook chances and the event
 * roll: the CSPRNG unless a test pins it.
 * Every request names its user, whose stores it reads and whose calibration
 * (model id to the ratio of its last count to our estimate) it uses and updates.
 */
export function createGeneration(
  catalog: Catalog,
  digest: EntryDigest,
  random: () => number = randomUniform,
) {
  return {
    /** A preview is always a reply: what sending the draft would send. */
    async prepare(
      request: PreviewRequest & { mode?: GenerationMode },
      signal: AbortSignal,
      { stores, calibration }: Pick<UserInstance, "stores" | "calibration">,
      purpose: Purpose,
    ): Promise<Prepared> {
      const mode = request.mode ?? "reply";
      // Read once: nothing in this synchronous request changes them between attempts.
      const userSettings = stores.settings.get();
      const resolved = await resolveModel(catalog, request.model, userSettings, signal);
      // The client left or the deadline passed while the catalog loaded: assemble nothing.
      if (resolved === null) return { ok: false, error: "aborted" };
      const { window } = resolved;
      if (window === null) return { ok: false, error: "context_window_unknown" };

      const sampler =
        request.samplerPresetId === undefined
          ? undefined
          : stores.presets.sampler.get(request.samplerPresetId)?.values;
      const stored =
        request.promptPresetId === undefined
          ? undefined
          : stores.presets.prompt.get(request.promptPresetId);
      const preset = stored ?? defaultPromptPreset();
      const character =
        request.characterId === undefined
          ? undefined
          : stores.characters.get(request.characterId)?.card;
      const persona = chosenPersona(stores.personas, request.personaId);

      // Only a reply that is sent rolls, and only for a character. Continue, Impersonate and
      // a preview return the carried state as it came; a reply without a character, none.
      const carried = request.eventsState ?? null;
      const rolls = mode === "reply" && purpose === "send";
      const subject =
        rolls && character !== undefined && request.characterId !== undefined
          ? { id: request.characterId, tags: character.tags }
          : null;
      const roll =
        subject === null
          ? null
          : rollEvents({
              events: stores.events.list(),
              character: subject,
              state: carried,
              roles: request.messages.map((turn) => turn.role),
              random,
            });

      // Every attempt at this prompt below reads the same draws: the macros and lorebook
      // chances of a fold or a fallback are the first attempt's.
      const draws = replayableRandom(random);
      const ratio = calibration.get(request.model) ?? 1;
      // Fold and fallback attempts rebuild the same messages, entries and memories: each
      // distinct text is counted once. The counts are chat content and go with this call.
      const messageCount = memoizedCount(countMessage);
      const textCounts = new Map<string, number>();
      const textCount = (text: string) => {
        let tokens = textCounts.get(text);
        if (tokens === undefined) {
          tokens = countText(text);
          textCounts.set(text, tokens);
        }
        return tokens * ratio;
      };
      const memoryFor = memoryInput(stores, request, textCount, window.tokens);
      // Held spans fold only while memory is on for this request.
      const held = memoryFor === null ? [] : (request.memoryState?.held ?? []);
      // Timed starts inside folded turns exist only for a request that carries memory.
      const folds = request.memoryState;
      const reserve = replyReserve(sampler?.maxOutputTokens ?? null, window.tokens);
      const input = {
        preset,
        ...(request.macroState === undefined ? {} : { macroState: request.macroState }),
        ...(request.macroRuntime === undefined ? {} : { macroRuntime: request.macroRuntime }),
        ...(request.generationType === undefined ? {} : { generationType: request.generationType }),
        runtime: { model: request.model, window: window.tokens, reserve },
        character: character ?? null,
        persona,
        clock: request.clock,
        pickSeed: request.pickSeed,
        random: draws.random,
        prefer: userSettings,
        mode,
        event: roll?.fired == null ? null : { text: roll.fired.text },
        ...(request.cast === undefined ? {} : { cast: request.cast }),
      };
      const linked =
        request.characterId === undefined ? [] : stores.lorebooks.booksOf(request.characterId);
      /**
       * The history and the lorebook with the leading `turns` folded: their
       * turns leave the history, the timed state moves down with them, and
       * delay still counts them, as it counts the turns the tab folded.
       */
      const folding = (turns: number) => {
        let state = lorebookStateAfterFold(request.lorebookState ?? null, turns);
        if (folds === undefined && state !== null) {
          state = { ...state, effects: state.effects.filter((effect) => effect.start >= 0) };
        }
        return {
          history: request.messages.slice(turns),
          foldedUsers:
            folds === undefined
              ? 0
              : folds.foldedUsers +
                request.messages.slice(0, turns).filter((turn) => turn.role === "user").length,
          // Only a character has lorebooks: the one in its card and the library books linked
          // to it, in link order. Their budget is a share of the window, measured like the
          // fit; their timed state comes with the request and goes back only on the prompt
          // (chat content).
          ...(request.characterId === undefined
            ? {}
            : {
                lorebook: {
                  window: window.tokens,
                  count: textCount,
                  linked,
                  state,
                  characterId: request.characterId,
                  digest,
                  // Turns folded into memories still count toward delay.
                  folded: (request.memoryState?.folded ?? 0) + turns,
                },
              }),
        };
      };
      const names = {
        char: character?.name ?? NO_CHARACTER_NAME,
        user: persona?.name ?? NO_PERSONA_NAME,
      };
      // The model's post-processing, set in Settings: fitted as sent, shown in the inspector.
      const { promptProcessing } = userSettings;
      const processing = promptProcessing[request.model] ?? "none";
      type Attempt = {
        assembly: ReturnType<typeof assemblePrompt>;
        fitted: ReturnType<typeof fitProcessed>;
      };
      const attempt = (
        turns: number,
        memory: NonNullable<AssemblyInput["memory"]> | null,
      ): Attempt => {
        draws.rewind();
        const assembly = assemblePrompt({ ...input, ...folding(turns), memory });
        const fitted = fitProcessed({
          assembly,
          budget: promptBudget(window.tokens, reserve),
          count: messageCount,
          priming: PRIMING,
          calibration: ratio,
          mode: processing,
          names,
        });
        return { assembly, fitted };
      };
      let folded: { result: Attempt; spans: number; turns: number };
      try {
        // Held memories keep their turns in the history while it fits whole; only a fit
        // that trims folds the oldest of them, before anything of memory is left out.
        folded = foldToFit(
          held,
          (spans, turns) =>
            attempt(turns, memoryFor?.(held.slice(0, spans).map(({ id }) => id)) ?? null),
          ({ fitted }) =>
            fitted.ok
              ? { ok: true, trimmed: fitted.history.total - fitted.history.sent }
              : { ok: false },
        );
      } catch (error) {
        // Card or preset macros expanding past their bound (untrusted text).
        if (error instanceof MacroLimitError) return { ok: false, error: "prompt_too_long" };
        throw error;
      }
      const { spans, turns } = folded;
      let chosen = folded.result;
      // Memories never make a prompt unsendable that fits without them: past the window,
      // with every held memory folded, the recalled episodes go first, then this chat's
      // recap with the story before it, the notebook last to stay.
      const memory = memoryFor?.(held.slice(0, spans).map(({ id }) => id)) ?? null;
      if (!chosen.fitted.ok && memory !== null) {
        const withoutRecall = { ...memory, recall: false };
        const withoutRecap = { ...memory, recall: false, recap: [], before: [] };
        const told = memory.recap.length + (memory.before?.length ?? 0);
        let previous = chosen.assembly;
        for (const tried of [withoutRecall, ...(told === 0 ? [] : [withoutRecap])]) {
          // Without recall, an attempt that recalled nothing would only be repeated; without the
          // recap, one that carried neither recap, story before it nor recall.
          if (tried === withoutRecall && previous.memory?.recalled.length === 0) continue;
          if (
            tried === withoutRecap &&
            previous.memory?.recalled.length === 0 &&
            previous.memory.recap.length === 0 &&
            previous.memory.before.length === 0
          ) {
            continue;
          }
          try {
            chosen = attempt(turns, tried);
          } catch (error) {
            if (error instanceof MacroLimitError) return { ok: false, error: "prompt_too_long" };
            throw error;
          }
          previous = chosen.assembly;
          if (chosen.fitted.ok) break;
        }
      }
      const { assembly, fitted } = chosen;
      if (!fitted.ok) return { ok: false, error: "prompt_too_long" };
      // A record only for an event that is in the request; like the lorebook's, its places
      // move down with the folded turns.
      let eventsState: EventsState | null = eventsAfterFold(
        subject === null || roll === null
          ? rolls
            ? null
            : carried
          : nextEventsState(
              subject.id,
              roll.kept,
              assembly.eventSent === true && roll.fired !== null ? roll.fired.id : null,
              request.messages.length,
            ),
        turns,
        request.messages.slice(0, turns).map((turn) => turn.role),
      );
      if (folds === undefined && eventsState !== null) {
        eventsState = {
          ...eventsState,
          fired: eventsState.fired
            .filter((record) => record.start >= 0)
            .map(({ foldedReplies: _foldedReplies, ...record }) => record),
        };
      }

      // An effort the model does not offer is not sent; the inspector says so.
      const settings = callSettings(sampler);
      let reasoningNotOffered: InspectedPrompt["reasoningNotOffered"] = null;
      if (
        settings.reasoning !== undefined &&
        effortFor(resolved.info, settings.reasoning) !== settings.reasoning
      ) {
        reasoningNotOffered = settings.reasoning;
        delete settings.reasoning;
      }

      return {
        ok: true,
        uncalibrated: fitted.estimate / ratio,
        reasoning: preset.reasoning,
        prompt: {
          model: request.model,
          mode,
          ...(assembly.generationType === undefined
            ? {}
            : { generationType: assembly.generationType }),
          ...(assembly.macroState === undefined ? {} : { macroState: assembly.macroState }),
          ...(fitted.history.sent === 0
            ? {}
            : { firstIncludedMessageId: fitted.history.total - fitted.history.sent }),
          processing,
          messages: fitted.messages.map(({ role, content, tokens, source, merged }) => ({
            role,
            content,
            tokens: Math.round(tokens),
            source,
            ...(merged === undefined ? {} : { merged }),
          })),
          settings,
          reasoningNotOffered,
          window,
          reserve,
          estimate: fitted.estimate,
          history: fitted.history,
          ...(spans === 0 ? {} : { memoryFold: { spans, turns } }),
          examples: fitted.examples,
          trimming: fitted.trimming,
          lorebook: fitted.lorebook,
          lorebookState: fitted.lorebookState,
          // Nothing to carry stays out of the prompt.
          ...(eventsState === null || eventsState.fired.length === 0 ? {} : { eventsState }),
        },
      };
    },
  };
}

export type Generation = ReturnType<typeof createGeneration>;
