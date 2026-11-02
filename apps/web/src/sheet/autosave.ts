import { useEffect, useLayoutEffect, useState } from "react";
import { type AutosaveOptions, createAutosave } from "./autosave-controller.ts";

/** What a sheet says about saving. Only not-saved states are announced. */
export type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "needs-name" }
  /** `limit`, when the sheet gives one: the field's limit in plain words. */
  | { kind: "invalid"; field: string; limit?: string }
  | { kind: "unreachable" }
  | { kind: "signed-out" }
  | { kind: "gone" }
  /** Another tab saved first; nothing is sent until Reload or Keep mine. */
  | { kind: "conflict" };

/** `noun` names what the sheet edits ("character", "persona", "preset"). */
export function saveStatusText(status: SaveStatus, creating: boolean, noun: string): string {
  switch (status.kind) {
    case "saved":
      return "Saved";
    case "saving":
      return "Saving";
    case "needs-name":
      return creating ? "Add a name to save" : "Not saved: add a name";
    case "invalid":
      return status.limit === undefined
        ? `Not saved: ${status.field} is over the limit`
        : `Not saved: ${status.limit}`;
    case "unreachable":
      return "Not saved: can't reach Ephemera. Retrying";
    case "signed-out":
      return "Not saved: signed out";
    case "gone":
      return `Not saved: this ${noun} was deleted`;
    case "conflict":
      return "Not saved: changed in another tab";
  }
}

/** Expected states in Reed; failures in Ember. Signed out is expected: nothing failed yet. */
export const isFailure = (status: SaveStatus, creating: boolean) =>
  !(
    status.kind === "saved" ||
    status.kind === "saving" ||
    status.kind === "signed-out" ||
    (status.kind === "needs-name" && creating)
  );

/**
 * Debounced, serialized saves owned by this sheet, in tab memory only. After
 * a conflict (`status.kind === "conflict"`), Keep mine is `keepMine`; Reload
 * is the sheet's: refetch the entity and remount its editor, whose new owner
 * starts from the saved entity and its revision.
 */
export function useAutosave<Fields extends { name: string }, Saved extends { revision: number }>(
  options: AutosaveOptions<Fields, Saved>,
) {
  const [status, setStatus] = useState<SaveStatus>(
    options.id === null ? { kind: "needs-name" } : { kind: "saved" },
  );
  const [owner] = useState(() => createAutosave(options, setStatus));
  useLayoutEffect(() => {
    owner.update(options);
  }, [owner, options]);
  useEffect(() => {
    // StrictMode replays setup after cleanup using the same owner.
    owner.mount();
    return owner.unmount;
  }, [owner]);
  return {
    status,
    touch: owner.touch,
    flush: owner.flush,
    discard: owner.discard,
    pause: owner.pause,
    resume: owner.resume,
    settle: owner.settle,
    keepMine: owner.keepMine,
    hasUnsaved: owner.hasUnsaved,
    isUnsaved: owner.isUnsaved,
    adopt: owner.adopt,
  };
}
