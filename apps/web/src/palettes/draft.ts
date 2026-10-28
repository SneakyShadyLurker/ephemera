import type {
  CustomPalette,
  CustomPaletteInput,
  CustomSlot,
  PaletteChoice,
  PaletteRole,
  PaletteScheme,
} from "@ephemera/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { deriveScheme } from "./derive.ts";
import { isFollowing } from "./roles.ts";

/*
 * The palette being edited: presentation state in this tab's memory only,
 * never saved until the player saves it. theme.tsx paints it over the whole
 * app while the editor is open, in the scheme being edited; closing the
 * editor puts the saved palette and theme back.
 */

type Scheme = "light" | "dark";

export interface PaletteDraft {
  /** This editing session: a late answer to an earlier one leaves it alone. */
  session: number;
  slot: CustomSlot;
  /** Whether the slot holds a saved palette this draft edits. */
  saved: boolean;
  /** The save this draft edits (`updatedAt`), named when replacing or deleting it. */
  updatedAt: number | null;
  name: string;
  base: PaletteChoice;
  /** The base's colours, which roles not set by hand follow. */
  origin: Record<Scheme, PaletteScheme>;
  light: PaletteScheme;
  dark: PaletteScheme;
  handSet: Record<Scheme, PaletteRole[]>;
  /** The scheme being edited, which the app shows while the editor is open. */
  scheme: Scheme;
  /** Whether anything changed since the editor opened or last saved. */
  dirty: boolean;
}

const store = createStore<{ draft: PaletteDraft | null }>(() => ({ draft: null }));

let sessions = 0;

export const usePaletteDraft = () => useStore(store, (state) => state.draft);

export const currentDraft = () => store.getState().draft;

/** A draft starting from a palette's colours, nothing set by hand. */
export function startDraft(
  slot: CustomSlot,
  name: string,
  base: PaletteChoice,
  colours: Record<Scheme, PaletteScheme>,
  scheme: Scheme,
): void {
  store.setState({
    draft: {
      session: ++sessions,
      slot,
      saved: false,
      updatedAt: null,
      name,
      base,
      origin: colours,
      light: colours.light,
      dark: colours.dark,
      handSet: { light: [], dark: [] },
      scheme,
      dirty: true,
    },
  });
}

/** A draft of a saved palette, as saved. */
export function editSaved(palette: CustomPalette, scheme: Scheme): void {
  store.setState({
    draft: {
      session: ++sessions,
      slot: palette.slot,
      saved: true,
      updatedAt: palette.updatedAt,
      name: palette.name,
      base: palette.base,
      origin: palette.origin,
      light: palette.light,
      dark: palette.dark,
      handSet: palette.handSet,
      scheme,
      dirty: false,
    },
  });
}

export const closeDraft = () => store.setState({ draft: null });

function change(update: (draft: PaletteDraft) => Partial<PaletteDraft>): void {
  const { draft } = store.getState();
  if (draft !== null) store.setState({ draft: { ...draft, ...update(draft), dirty: true } });
}

export const renameDraft = (name: string) => change(() => ({ name }));

export const showScheme = (scheme: Scheme) => {
  const { draft } = store.getState();
  if (draft !== null) store.setState({ draft: { ...draft, scheme } });
};

/**
 * Sets a role in the scheme being edited. A key colour moves the roles that
 * follow it; any other role is set by hand from then on.
 */
export function setColour(role: PaletteRole, hex: string): void {
  change((draft) => {
    const { scheme } = draft;
    const now = { ...draft[scheme], [role]: hex };
    if (isFollowing(role)) {
      const handSet = draft.handSet[scheme].includes(role)
        ? draft.handSet[scheme]
        : [...draft.handSet[scheme], role];
      return { [scheme]: now, handSet: { ...draft.handSet, [scheme]: handSet } };
    }
    return { [scheme]: deriveScheme(draft.origin[scheme], now, draft.handSet[scheme]) };
  });
}

/** Returns a hand-set role to following its key colour. */
export function followAgain(role: PaletteRole): void {
  change((draft) => {
    const { scheme } = draft;
    const handSet = draft.handSet[scheme].filter((set) => set !== role);
    return {
      [scheme]: deriveScheme(draft.origin[scheme], draft[scheme], handSet),
      handSet: { ...draft.handSet, [scheme]: handSet },
    };
  });
}

/** Replaces both schemes with another palette's colours; the name stays. */
export function startOver(base: PaletteChoice, colours: Record<Scheme, PaletteScheme>): void {
  change(() => ({
    base,
    origin: colours,
    light: colours.light,
    dark: colours.dark,
    handSet: { light: [], dark: [] },
  }));
}

/** Whether `submitted`'s editing session is still the open one. */
export const stillOpen = (submitted: PaletteDraft) =>
  store.getState().draft?.session === submitted.session;

/**
 * After `submitted` was saved as `saved`: its session edits that save now.
 * Whether the open draft is still exactly what was saved; edits made while
 * the save was on its way keep it unsaved, and another session is left alone.
 */
export function markSaved(submitted: PaletteDraft, saved: CustomPalette): boolean {
  const { draft } = store.getState();
  if (draft === null || draft.session !== submitted.session) return false;
  const unchanged = draft === submitted;
  store.setState({
    draft: {
      ...draft,
      slot: saved.slot,
      saved: true,
      updatedAt: saved.updatedAt,
      dirty: unchanged ? false : draft.dirty,
    },
  });
  return unchanged;
}

/** A new palette whose slot another tab took meanwhile moves to a free one. */
export function moveDraft(submitted: PaletteDraft, slot: CustomSlot): void {
  const { draft } = store.getState();
  if (draft !== null && draft.session === submitted.session && !draft.saved) {
    store.setState({ draft: { ...draft, slot } });
  }
}

/** What the server stores for the draft. */
export const draftInput = (draft: PaletteDraft): CustomPaletteInput => ({
  name: draft.name.trim(),
  base: draft.base,
  light: draft.light,
  dark: draft.dark,
  origin: draft.origin,
  handSet: draft.handSet,
});

/** The draft as a palette the stylesheet can paint, named even while its name is empty. */
export const draftPalette = (draft: PaletteDraft): CustomPalette => ({
  ...draftInput(draft),
  name: draft.name.trim() || "Draft",
  slot: draft.slot,
  updatedAt: 0,
});
