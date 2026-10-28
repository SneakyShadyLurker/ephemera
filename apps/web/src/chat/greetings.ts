import {
  type CharacterCard,
  type CharacterMemory,
  cardGreetingChoices,
  type MacroState,
  randomUniform,
} from "@ephemera/core";
import { type FetchStatus, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { queryClient } from "@/app/query.ts";
import { isNotFound } from "../api.ts";
import { characterQuery } from "../characters/queries.ts";
import { memoryOnIn, memoryQuery } from "../memory/queries.ts";
import { personaQuery } from "../personas/queries.ts";
import { presetQuery } from "../presets/queries.ts";
import { useSettings } from "../settings/settings.ts";
import { chatStore, greetingSubject, type SubjectIds, subjectQueries, useChat } from "./session.ts";
import {
  browserClock,
  type GreetingChoice,
  type MacroSubject,
  type SubjectResult,
} from "./store.ts";

/**
 * What a greeting's macros read: the card and persona, and, once loaded, the
 * prompt preset and the chosen model's runtime.
 */
type GreetingSubject = Pick<MacroSubject, "persona" | "prefer"> &
  Partial<Pick<MacroSubject, "preset" | "runtime">> & { character: CharacterCard };

/**
 * The chat's greetings, the memory's `opening` first when there is one, then
 * the card's, each filled from the same base state (core skips blank ones,
 * and ones that fill to nothing or past the macro limits), each kept with
 * its key and the text written for it.
 */
export function greetingChoices(
  subject: GreetingSubject,
  base: MacroState,
  pickSeed: number,
  opening: string | null,
): GreetingChoice[] {
  const { character: card, preset, runtime } = subject;
  return cardGreetingChoices({
    character: card,
    opening,
    persona: subject.persona,
    prefer: subject.prefer,
    ...(preset === undefined ? {} : { preset }),
    ...(runtime === undefined ? {} : { runtime }),
    clock: browserClock(),
    pickSeed,
    random: randomUniform,
    macroState: base,
  }).map(({ content, macroState, rawText, key }) => ({ content, macroState, key, rawText }));
}

const samePersona = (
  a: MacroSubject["persona"],
  b: { name: string; description: string } | null,
) => (a === null || b === null ? a === b : a.name === b.name && a.description === b.description);

/** Where a chosen entity the greeting reads stands: loaded (or gone, or not chosen), loading, or failed. */
type Load = "ready" | "loading" | "failed";

/** A failure is final once its retries ended; a refetch under way is loading again. */
function loadOf(
  query: { isPending: boolean; error: Error | null; fetchStatus: FetchStatus },
  chosen: boolean,
): Load {
  if (!chosen || isNotFound(query.error)) return "ready";
  if (query.isPending) return "loading";
  if (query.error === null) return "ready";
  return query.fetchStatus === "fetching" ? "loading" : "failed";
}

/**
 * The memory's opening a new chat opens on, trimmed: with the setting on
 * (`wanted`, a character chosen) and memory on for the character, when it
 * has any text; else null. While the memory first loads the fill waits for
 * it; a failure that ended (or a character gone) opens on the card's
 * greetings. A memory loaded before a failed refetch still counts.
 */
export function memoryOpening(
  query: {
    data: CharacterMemory | undefined;
    isPending: boolean;
    error: Error | null;
    fetchStatus: FetchStatus;
  },
  wanted: boolean,
): { load: "ready" | "loading"; opening: string | null } {
  if (loadOf(query, wanted) === "loading") return { load: "loading", opening: null };
  const opening = wanted && memoryOnIn(query) ? (query.data?.state?.opening.trim() ?? "") : "";
  return { load: "ready", opening: opening === "" ? null : opening };
}

/** The worst of several loads: any failure, else any still loading. */
const worst = (...loads: Load[]): Load =>
  loads.includes("failed") ? "failed" : loads.includes("loading") ? "loading" : "ready";

/** Each Try again of a greeting that did not load; the fill starts over once per press. */
const retries = createStore<{ count: number }>()(() => ({ count: 0 }));

/** Loads the greeting again: what it reads and failed, then the fill. */
export function retryGreeting(): void {
  chatStore.getState().setGreetingFailed(false);
  retries.setState((state) => ({ count: state.count + 1 }));
}

/**
 * Refetches what a greeting reads and failed to load, a refresh joining any
 * under way; true when one started, the fill then waiting for it.
 */
function refetchFailed(ids: SubjectIds): boolean {
  const keys = Object.values(subjectQueries(ids)).flatMap((read) =>
    read === null ? [] : [read.queryKey],
  );
  const failed = keys.filter((queryKey) => {
    const state = queryClient.getQueryState(queryKey);
    return state?.status === "error" && !isNotFound(state.error);
  });
  for (const queryKey of failed) void queryClient.refetchQueries({ queryKey, exact: true });
  return failed.length > 0;
}

/**
 * Opens an empty chat on the character's greetings (card spec V2: the first
 * message, then each alternate as a swipe), led by the memory's opening
 * while Settings and the character's memory say so (`memoryOpening`), with
 * macros filled for the persona, the prompt preset, the chosen model, the
 * browser's clock and the chat's pick seed. A persona or opening change
 * refills a greeting the user has not touched; once they reply, it is an
 * ordinary turn. Greetings are filled again only when the card, the opening
 * or the persona changes, or after a Clear: never for a refetch, a render or
 * a change of model or preset, so their macros take effect once. A fill
 * still loading starts again when those change. One whose reads failed
 * fills nothing and says so, until Try again loads them.
 */
export function useGreetings() {
  const {
    characterId,
    personaId,
    model,
    samplerPresetId,
    promptPresetId,
    memoryOpening: leads,
  } = useSettings();
  const ids: SubjectIds = { characterId, personaId, model, samplerPresetId, promptPresetId };
  const subject = subjectQueries(ids);
  const character = useQuery({
    ...(subject.character ?? characterQuery("")),
    enabled: subject.character !== null,
    // A card can be several MB: a return to the tab does not fetch it again (opening the
    // chat does, the sheets refetch on arrival, and local edits update it).
    refetchOnWindowFocus: false,
  });
  const persona = useQuery({
    ...(subject.persona ?? personaQuery("")),
    enabled: subject.persona !== null,
  });
  const prompt = useQuery({
    ...(subject.prompt ?? presetQuery("prompt", "")),
    enabled: subject.prompt !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const sampler = useQuery({
    ...(subject.sampler ?? presetQuery("sampler", "")),
    enabled: subject.sampler !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const memory = useQuery({ ...memoryQuery(characterId ?? ""), enabled: characterId !== null });
  // The memory's opening leads only once its memory loaded; a load that failed leaves the card's.
  const { load: openingLoad, opening } = memoryOpening(memory, leads && characterId !== null);
  // A deleted persona or preset is none; one still loading is waited for, so `{{user}}` is
  // right at once; one that failed once its retries ended says so, with Try again.
  const reads = worst(
    loadOf(persona, subject.persona !== null),
    loadOf(prompt, subject.prompt !== null),
    loadOf(sampler, subject.sampler !== null),
  );
  // The chat's epoch and seed: a Clear starts again on the greeting, whose `{{pick}}`
  // chooses as the chat's requests will.
  const epoch = useChat((state) => state.epoch);
  const pickSeed = useChat((state) => state.pickSeed);
  const card = characterId === null ? undefined : character.data?.card;
  const characterLoad = loadOf(character, subject.character !== null);
  const retried = useStore(retries, (state) => state.count);
  const name = personaId === null ? undefined : persona.data?.name;
  const description = personaId === null ? undefined : persona.data?.description;
  /** What the greeting shown was filled for. */
  const last = useRef<{
    card: CharacterCard | undefined;
    name: string | undefined;
    description: string | undefined;
    opening: string | null;
    epoch: number;
    pickSeed: number;
  } | null>(null);
  /** The fill loading now; an older one finishing is dropped. */
  const attempt = useRef(0);
  /** The last Try again this fill answered; each is answered once. */
  const answered = useRef(retried);

  useEffect(() => {
    // What failed before is told again below if it still fails; a change or a Clear ends it.
    chatStore.getState().setGreetingFailed(false);
    const seen = last.current;
    // A refetch keeps the same card (structural sharing); only a meaningful change fills again.
    if (
      seen !== null &&
      (card !== undefined || characterLoad === "ready") &&
      seen.card === card &&
      seen.name === name &&
      seen.description === description &&
      seen.opening === opening &&
      seen.epoch === epoch &&
      seen.pickSeed === pickSeed
    ) {
      return;
    }
    if (answered.current !== retried) {
      answered.current = retried;
      // The reads that failed load again first; the fill follows once they arrive.
      if (refetchFailed({ characterId, personaId, promptPresetId, samplerPresetId, model })) return;
    }
    const filled = { card, name, description, opening, epoch, pickSeed };
    // No character, or the next one still loading or failed: no greeting of another character stays.
    if (card === undefined) {
      chatStore.getState().setGreetings([]);
      if (characterLoad === "failed") {
        chatStore.getState().setGreetingFailed(true);
        return;
      }
      if (characterLoad === "ready") last.current = filled;
      return;
    }
    // Never filled without what it reads: a failure says so and waits for Try again.
    if (reads === "failed") {
      chatStore.getState().setGreetingFailed(true);
      return;
    }
    if (reads === "loading" || openingLoad === "loading") return;
    const filledFor = name === undefined ? null : { name, description: description ?? "" };
    attempt.current += 1;
    const current = attempt.current;
    const load = (): void => {
      void greetingSubject({
        model,
        samplerPresetId,
        promptPresetId,
        characterId,
        personaId,
        reasoning: null,
      })
        .catch((): SubjectResult => ({ ok: false }))
        .then((result) => {
          const state = chatStore.getState();
          // A newer fill (a change it reads starts one), or a Clear, owns the greeting now.
          if (attempt.current !== current || state.epoch !== epoch || state.pickSeed !== pickSeed) {
            return;
          }
          // A setting or saved entity it read changed while it loaded: it reads them again.
          if (!result.ok && result.reason === "changed") {
            load();
            return;
          }
          // Its retries ended without what it reads: said, with Try again; nothing half-filled.
          if (!result.ok) {
            state.setGreetingFailed(true);
            return;
          }
          // Loaded newer than the card or persona shown: their own update fills it.
          if (
            result.subject.character !== card ||
            !samePersona(result.subject.persona, filledFor)
          ) {
            return;
          }
          last.current = filled;
          const subject: GreetingSubject = { ...result.subject, character: card };
          state.setGreetingChoices((base) => greetingChoices(subject, base, pickSeed, opening));
        });
    };
    load();
    return () => {
      attempt.current += 1;
    };
  }, [
    card,
    name,
    description,
    opening,
    openingLoad,
    epoch,
    reads,
    characterLoad,
    retried,
    pickSeed,
    characterId,
    personaId,
    model,
    samplerPresetId,
    promptPresetId,
  ]);
}
