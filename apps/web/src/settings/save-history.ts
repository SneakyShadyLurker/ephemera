import type { SettingsPatch } from "@ephemera/core";
import type { MutationCache } from "@tanstack/react-query";

export const SETTINGS_MUTATION_KEY = ["settings", "update"];
export const SETTINGS_SAVE_GC_TIME = Number.POSITIVE_INFINITY;

/** Why a settings save failed; the message of the error it threw. */
type Save = { status: string; patch: SettingsPatch | undefined; error?: string | undefined };

/** Failures that say nothing about the values: they are sent again. */
const RETRYABLE = new Set(["unreachable", "signed_out"]);
/** Final refusals the field itself shows; the tab never took the value. */
const SHOWN_IN_FIELD = new Set(["comfyui_origin_not_allowed"]);

/**
 * The fields to send again: every save that failed for a reason worth
 * retrying, less the fields a later save carried. A save the server refused
 * (an unknown reference) is final, and it masks older values of its fields.
 */
export function failedSettingsPatch(saves: Save[]): SettingsPatch | undefined {
  const unsaved: SettingsPatch = {};
  for (const { status, patch, error } of saves) {
    if (patch === undefined) continue;
    if (status === "error" && RETRYABLE.has(error ?? "")) Object.assign(unsaved, patch);
    else for (const key of Object.keys(patch)) delete unsaved[key as keyof SettingsPatch];
  }
  return Object.keys(unsaved).length > 0 ? unsaved : undefined;
}

/**
 * Whether the newest save of some field was refused as final (a reference
 * to something deleted): the tab then holds a value the server does not.
 */
export function refusedSettingsSave(saves: Save[]): boolean {
  const refused = new Set<string>();
  for (const { status, patch, error } of saves) {
    if (patch === undefined) continue;
    for (const key of Object.keys(patch)) {
      if (status === "error" && !RETRYABLE.has(error ?? "") && !SHOWN_IN_FIELD.has(error ?? "")) {
        refused.add(key);
      } else refused.delete(key);
    }
  }
  return refused.size > 0;
}

/**
 * The ComfyUI address the newest save of it carried, when the server refused
 * that address's origin: the address field explains it, whether the save came
 * from the field or from a resend.
 */
export function refusedAddress(saves: Save[]): string | undefined {
  let refused: string | undefined;
  for (const { status, patch, error } of saves) {
    if (patch?.comfyuiBaseUrl === undefined) continue;
    refused =
      status === "error" && SHOWN_IN_FIELD.has(error ?? "") ? patch.comfyuiBaseUrl : undefined;
  }
  return refused;
}

/**
 * The fields the server can refuse a whole patch for: the references (an
 * entity deleted since, a workflow without a graph) and the ComfyUI address
 * (an origin it does not allow).
 */
const SENT_ALONE = [
  "characterId",
  "personaId",
  "defaultPersonaId",
  "promptPresetId",
  "samplerPresetId",
  "comfyuiBaseUrl",
  "comfyuiWorkflow",
] as const satisfies readonly (keyof SettingsPatch)[];

/**
 * A resend in parts: the plain fields together, each field the server can
 * refuse alone, so a stale id or a disallowed address never takes the theme
 * or the model down with it.
 */
export function settingsResendParts(patch: SettingsPatch): SettingsPatch[] {
  const plain: SettingsPatch = { ...patch };
  const parts: SettingsPatch[] = [];
  for (const key of SENT_ALONE) {
    if (!(key in patch)) continue;
    delete plain[key];
    parts.push({ [key]: patch[key] });
  }
  return Object.keys(plain).length > 0 ? [plain, ...parts] : parts;
}

/**
 * Failed saves survive observer unmount/GC in the existing tab-memory cache.
 * Each retained settled record owns at least one field's newest outcome.
 * Successful records remain only when they mask part of an older failure.
 */
export function retainSettingsSaveHistory(cache: MutationCache): () => void {
  return cache.subscribe((event) => {
    if (event.type !== "updated" || !["success", "error"].includes(event.action.type)) return;
    const key = event.mutation.options.mutationKey;
    if (key?.length !== 2 || key[0] !== "settings" || key[1] !== "update") return;
    const settled = cache
      .findAll({ mutationKey: SETTINGS_MUTATION_KEY })
      .filter(
        (mutation) => mutation.state.status === "success" || mutation.state.status === "error",
      );
    const covered = new Set<string>();
    const kept = new Set<(typeof settled)[number]>();
    for (const mutation of [...settled].reverse()) {
      const keys = Object.keys((mutation.state.variables as SettingsPatch | undefined) ?? {});
      if (keys.some((field) => !covered.has(field))) {
        kept.add(mutation);
        for (const field of keys) covered.add(field);
      }
    }
    const earlierFailures = new Set<string>();
    for (const mutation of settled) {
      const keys = Object.keys((mutation.state.variables as SettingsPatch | undefined) ?? {});
      if (!kept.has(mutation)) cache.remove(mutation);
      else if (mutation.state.status === "error") {
        for (const field of keys) earlierFailures.add(field);
      } else if (!keys.some((field) => earlierFailures.has(field))) cache.remove(mutation);
    }
  });
}
