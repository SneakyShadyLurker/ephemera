import {
  DEFAULT_SETTINGS,
  MEMORY_LIMITS,
  type ReasoningEffort,
  type Settings,
  type SettingsPatch,
  settingsResponseSchema,
} from "@ephemera/core";
import {
  hashKey,
  type Mutation,
  MutationObserver,
  mutationOptions,
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { api } from "../api.ts";
import { queryClient } from "../app/query.ts";
import { SAVE_TIMEOUT_MS } from "../sheet/saving.ts";
import { retryable, signedOutNow, signIn } from "../signin/signin.ts";
import {
  failedSettingsPatch,
  refusedAddress,
  refusedSettingsSave,
  retainSettingsSaveHistory,
  SETTINGS_MUTATION_KEY,
  SETTINGS_SAVE_GC_TIME,
  settingsResendParts,
} from "./save-history.ts";

/*
 * UI settings (PRINCIPLES.md 1): kept on the server only, read once per tab
 * and never refetched in the background, so another tab cannot switch the
 * model under an open chat. Changes apply here at once and are saved in
 * order; a save that fails keeps the choice for this tab.
 */

/**
 * Changes made before the server's settings ever reached this tab: they are
 * the tab's choices, laid over the server's settings once those arrive.
 */
const unloadedChanges = createStore<Partial<Settings>>(() => ({}));

/** The settings as saved on the server, without touching this tab's copy. */
export async function fetchSavedSettings(signal?: AbortSignal): Promise<Settings> {
  const result = await api.settings.$get(undefined, signal ? { init: { signal } } : undefined);
  if (!result.ok) throw new Error("unreachable");
  return settingsResponseSchema.parse(await result.json()).settings;
}

export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: ({ signal }) => fetchSavedSettings(signal),
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: (count, error) => retryable(error) && count < 1,
});

let unloadedSettings: { changes: Partial<Settings>; settings: Settings } | undefined;

/** Before the server's settings arrive: the defaults under this tab's changes, one object per change. */
function beforeLoad(changes: Partial<Settings>): Settings {
  if (unloadedSettings?.changes !== changes) {
    unloadedSettings = { changes, settings: { ...DEFAULT_SETTINGS, ...changes } };
  }
  return unloadedSettings.settings;
}

/** The settings now, for code outside React (sending a message). */
export function currentSettings(): Settings {
  return queryClient.getQueryData(settingsQuery.queryKey) ?? beforeLoad(unloadedChanges.getState());
}

export function useSettings(): Settings {
  const saved = useQuery(settingsQuery).data;
  const unloaded = useStore(unloadedChanges);
  return saved ?? beforeLoad(unloaded);
}

/**
 * One value from the settings; the component re-renders only when that
 * value changes, not on every settings change.
 */
export function useSetting<T extends NonNullable<unknown> | null>(
  select: (settings: Settings) => T,
): T {
  const saved = useQuery({ ...settingsQuery, select }).data;
  const unloaded = useStore(unloadedChanges);
  return saved !== undefined ? saved : select(beforeLoad(unloaded));
}

// Once the server's settings arrive, the changes made before them are laid over them.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.query.queryHash !== hashKey(settingsQuery.queryKey)) return;
  const unloaded = unloadedChanges.getState();
  if (event.query.state.status !== "success" || Object.keys(unloaded).length === 0) return;
  unloadedChanges.setState({}, true);
  queryClient.setQueryData(settingsQuery.queryKey, (saved) => saved && { ...saved, ...unloaded });
});

// The tab owns this subscription, including while every settings control is unmounted.
retainSettingsSaveHistory(queryClient.getMutationCache());

/**
 * Why a save failed: only an unreachable server is worth retrying; signed out
 * waits for the session. A ComfyUI address whose origin the server does not
 * allow is final, and the address field says so.
 */
export type SaveError = "unreachable" | "signed_out" | SettingsRefusal | "refused";

/** Every refusal the settings route answers with 422, so a new one fails the typecheck here. */
type SettingsRefusal = InferResponseType<typeof api.settings.$patch, 422>["error"];

const SETTINGS_REFUSALS: Record<SettingsRefusal, true> = {
  unknown_reference: true,
  comfyui_origin_not_allowed: true,
};
const refusalBody = z.object({
  error: z.enum(Object.keys(SETTINGS_REFUSALS) as [SettingsRefusal, ...SettingsRefusal[]]),
});

async function saveSettings(patch: SettingsPatch): Promise<void> {
  let result: Response;
  try {
    result = await api.settings.$patch(
      { json: patch },
      { init: { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) } },
    );
  } catch (error) {
    if (signedOutNow(error)) throw new Error("signed_out" satisfies SaveError);
    // Offline, a dropped connection or the timeout: the server never answered.
    throw new Error("unreachable" satisfies SaveError);
  }
  if (result.ok) return;
  if (result.status === 422) {
    const refusal = refusalBody.safeParse(await result.json().catch(() => undefined));
    throw new Error((refusal.success ? refusal.data.error : "refused") satisfies SaveError);
  }
  throw new Error((result.status >= 500 ? "unreachable" : "refused") satisfies SaveError);
}

/** The Memory section's model choice that leaves memory calls on the reply's model; never a model id. */
export const REPLY_MODEL = "";

/** What the Memory section's controls choose, one or more at a time. */
interface MemoryChoice {
  /** A model id, or `REPLY_MODEL`. */
  model?: string;
  reasoning?: ReasoningEffort;
  spanTokens?: number;
  keepTurns?: number;
  /** The recap budget's cap; null leaves it to the window. */
  recapTokens?: number | null;
  /** New chats open on the memory's opening. */
  opening?: boolean;
}

const within = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(value)));

/**
 * The settings a Memory choice saves: the reply's model, the model's own
 * effort and an automatic recap budget as null, sizes as whole numbers
 * within their limits.
 */
export function memoryPatch(choice: MemoryChoice): SettingsPatch {
  const { model, reasoning, spanTokens, keepTurns, recapTokens, opening } = choice;
  return {
    ...(opening === undefined ? {} : { memoryOpening: opening }),
    ...(model === undefined ? {} : { memoryModel: model === REPLY_MODEL ? null : model }),
    ...(reasoning === undefined
      ? {}
      : { memoryReasoning: reasoning === "provider-default" ? null : reasoning }),
    ...(spanTokens === undefined
      ? {}
      : { memorySpanTokens: within(spanTokens, MEMORY_LIMITS.spanTokens) }),
    ...(keepTurns === undefined
      ? {}
      : { memoryKeepTurns: within(keepTurns, MEMORY_LIMITS.keepTurns) }),
    ...(recapTokens === undefined
      ? {}
      : {
          memoryRecapTokens:
            recapTokens === null ? null : within(recapTokens, MEMORY_LIMITS.recapTokens),
        }),
  };
}

/** The Cast section's model choice that leaves cast calls on memory's model; never a model id. */
export const MEMORY_MODEL = "";

/** What the Cast section's controls choose, one or both at a time. */
interface CastChoice {
  /** A model id, or `MEMORY_MODEL`. */
  model?: string;
  /** An effort, the model's own included; null follows memory's. */
  reasoning?: ReasoningEffort | null;
}

/**
 * The settings a Cast choice saves: memory's model and memory's effort as
 * null; an effort as chosen, the model's own included.
 */
export function castPatch({ model, reasoning }: CastChoice): SettingsPatch {
  return {
    ...(model === undefined ? {} : { castModel: model === MEMORY_MODEL ? null : model }),
    ...(reasoning === undefined ? {} : { castReasoning: reasoning }),
  };
}

/** Applies a change to this tab's settings without saving it (the server already made it). */
export function applySettings(change: Partial<Settings>): void {
  if (queryClient.getQueryData(settingsQuery.queryKey) === undefined) {
    // Kept apart, so the server's settings still load; asking again brings them.
    unloadedChanges.setState(change);
    void queryClient.refetchQueries({ queryKey: settingsQuery.queryKey });
    return;
  }
  queryClient.setQueryData(settingsQuery.queryKey, (saved) => saved && { ...saved, ...change });
}

/**
 * Changes settings: the tab sees the change at once and owns it; saves run one
 * after another and write nothing back, so another tab's choices never reach
 * this one.
 */
/** A settings save as the history reads it. */
const saveOf = (mutation: Mutation<unknown, Error, unknown, unknown>) => ({
  status: mutation.state.status,
  patch: mutation.state.variables as SettingsPatch | undefined,
  error: mutation.state.error?.message,
});

const settingsSave = mutationOptions({
  mutationKey: SETTINGS_MUTATION_KEY,
  gcTime: SETTINGS_SAVE_GC_TIME,
  scope: { id: "settings" },
  mutationFn: saveSettings,
  retry: (count, error) => error.message === "unreachable" && count < 3,
});

export function useUpdateSettings(): (patch: SettingsPatch) => void {
  const mutation = useMutation(settingsSave);
  return (patch) => {
    applySettings(
      Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    );
    mutation.mutate(patch);
  };
}

/**
 * Sends the saves that failed for a reason worth retrying once more, in
 * parts (save-history.ts), without touching this tab's settings, which
 * already hold them.
 */
export async function retryFailedSettings(): Promise<void> {
  const saves = queryClient
    .getMutationCache()
    .findAll({ mutationKey: SETTINGS_MUTATION_KEY })
    .map(saveOf);
  const failed = failedSettingsPatch(saves);
  if (failed === undefined) return;
  // Every part joins the queue now, so a choice made while they run is saved after them.
  await Promise.allSettled(settingsResendParts(failed).map(queueSettingsSave));
}

/** One settings save in the tab's queue, outside React (the resend); the hook uses the same options. */
export function queueSettingsSave(patch: SettingsPatch): Promise<void> {
  return new MutationObserver(queryClient, settingsSave).mutate(patch);
}

// Changes that failed while signed out are sent again once the session is back.
signIn.onRenewed(retryFailedSettings);

/**
 * The changes not saved yet: every failed save's fields, less those a later
 * save carried. Try again sends them all.
 */
export function useFailedSettingsSave(): SettingsPatch | undefined {
  return failedSettingsPatch(useSettingsSaves());
}

/** A save the server refused for good: the tab keeps a choice the server does not. */
export function useRefusedSettingsSave(): boolean {
  return refusedSettingsSave(useSettingsSaves());
}

/** The ComfyUI address whose origin the server refused in its newest save, if it did. */
export function useRefusedAddress(): string | undefined {
  return refusedAddress(useSettingsSaves());
}

function useSettingsSaves() {
  return useMutationState({ filters: { mutationKey: SETTINGS_MUTATION_KEY }, select: saveOf });
}
