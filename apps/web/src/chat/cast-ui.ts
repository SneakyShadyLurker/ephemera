import type { CastAnchorField, CastEntry, CastRegister, CastStateField } from "@ephemera/core";
import {
  CAST_ANCHOR_FIELDS,
  CAST_STATE_FIELDS,
  discoveredCastEntry,
  effectiveCastAnchor,
} from "@ephemera/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { baseBefore, type ChatCast, currentRegister, keeperTargetUncovered } from "./cast-slice.ts";
import { chatStore, useChat } from "./session.ts";
import { type ChatState, shownReply } from "./store.ts";

/*
 * The cast panel's presentation state: where the record surface is open and
 * what it shows (an entry id and an element), and the quiet line a removal
 * leaves in the roster. The line holds the removed name, chat content kept
 * in this tab's memory only, and a Clear drops it with the surface.
 */

export type CastTextField = CastAnchorField | CastStateField;

export const CAST_TEXT_FIELDS: readonly CastTextField[] = [
  ...CAST_ANCHOR_FIELDS,
  ...CAST_STATE_FIELDS,
];

/**
 * Field names: for assistive technology in the cast record's reading mode,
 * visible labels in its edit mode and on the memory notebook's cast.
 */
export const CAST_FIELD_LABELS: Record<CastTextField, string> = {
  age: "Age",
  ethnicity: "Ethnicity",
  skin: "Skin",
  face: "Face",
  experience: "Sexual experience",
  relationship: "Relationship",
  height: "Height",
  weight: "Weight",
  build: "Build",
  hair: "Hair",
  eyes: "Eyes",
  intimate: "Intimate body",
  personality: "Personality",
  fetishes: "Fetishes and taboos",
  outfit: "Outfit",
  disarray: "Clothing state",
  position: "Position",
  activity: "Activity",
  mood: "Mood",
  arousal: "Arousal",
  injuries: "Injuries",
  intoxication: "Intoxication",
};

const isAnchorField = (field: CastTextField): field is CastAnchorField =>
  (CAST_ANCHOR_FIELDS as readonly string[]).includes(field);

export const castFieldText = (entry: CastEntry, field: CastTextField): string =>
  isAnchorField(field) ? effectiveCastAnchor(entry)[field] : entry.state[field];

// ---------------------------------------------------------------------------
// What the newest snapshot changed.

export interface CastChange {
  /** The snapshot: its reply and when it landed. */
  key: string;
  /** When it landed (ms since the epoch), for its wash. */
  at: number;
  /** By entry id, the fields it changed in an entry the register held before. */
  fields: ReadonlyMap<string, ReadonlySet<CastTextField>>;
}

const changes = new WeakMap<ChatState["messages"], WeakMap<ChatCast, CastChange | null>>();

const publicEntry = (state: ChatState, entry: CastEntry): CastEntry =>
  discoveredCastEntry(entry, state.cast.corrections[entry.id]?.anchor);

/** The in-chat panel's register: introduced people and discovered fields only. */
const discovered = new WeakMap<CastRegister, CastRegister>();
export function discoveredRegister(state: ChatState): CastRegister {
  const current = currentRegister(state);
  const known = discovered.get(current);
  if (known !== undefined) return known;
  const register = {
    entries: current.entries.flatMap((entry) =>
      entry.introduced === true ? [publicEntry(state, entry)] : [],
    ),
  };
  discovered.set(current, register);
  return register;
}

function findChange(state: ChatState): CastChange | null {
  for (let at = state.messages.length - 1; at >= 0; at--) {
    const message = state.messages[at];
    if (message?.role !== "assistant") continue;
    const reply = shownReply(message);
    const snapshot = state.cast.snapshots[reply.id];
    if (snapshot === undefined) continue;
    const before = new Map(
      baseBefore(state, at).entries.map((entry) => [entry.id, publicEntry(state, entry)]),
    );
    const fields = new Map<string, ReadonlySet<CastTextField>>();
    for (const canonical of snapshot.register.entries) {
      if (canonical.introduced !== true) continue;
      const entry = publicEntry(state, canonical);
      const old = before.get(entry.id);
      if (old === undefined) continue;
      const changed = CAST_TEXT_FIELDS.filter(
        (field) => castFieldText(old, field) !== castFieldText(entry, field),
      );
      if (changed.length > 0) fields.set(entry.id, new Set(changed));
    }
    return { key: `${reply.id}:${snapshot.at}`, at: snapshot.at, fields };
  }
  return null;
}

/** The newest snapshot's changes; the same object while the messages and the cast are. */
export function latestChange(state: ChatState): CastChange | null {
  const byCast = changes.get(state.messages) ?? new WeakMap<ChatCast, CastChange | null>();
  changes.set(state.messages, byCast);
  const known = byCast.get(state.cast);
  if (known !== undefined) return known;
  const change = findChange(state);
  byCast.set(state.cast, change);
  return change;
}

// ---------------------------------------------------------------------------
// The record surface and the removal line.

interface CastSurface {
  open: boolean;
  /** The record shown; null for the roster. */
  entryId: string | null;
  /** Opened at the roster: the record offers the way back to it. */
  fromRoster: boolean;
  /** What the popover hangs from and focus returns to; null where nothing should take it back. */
  anchor: HTMLElement | null;
  /** Beside a roster entry, or above the control that opened it. */
  side: "inline-end" | "top";
}

/** The line a removal leaves where the entry was, until the next snapshot or the panel is used. */
export interface CastRemoval {
  entryId: string;
  name: string;
  /** Present or away when removed, and her place among them. */
  present: boolean;
  index: number;
  /** The newest snapshot when removed: a later one ends the line. */
  key: string | null;
}

const CLOSED: CastSurface = {
  open: false,
  entryId: null,
  fromRoster: false,
  anchor: null,
  side: "top",
};

const store = createStore<{ surface: CastSurface; removal: CastRemoval | null }>(() => ({
  surface: CLOSED,
  removal: null,
}));

// A Clear (and `pagehide`) empties the surface, its anchor in the old thread included, and drops
// the line: nothing of the old chat stays referenced here.
chatStore.subscribe((state, previous) => {
  if (state.epoch !== previous.epoch) store.setState({ surface: CLOSED, removal: null });
});

export const useCastSurface = <T>(selector: (state: CastSurface) => T): T =>
  useStore(store, (state) => selector(state.surface));

const setSurface = (patch: Partial<CastSurface>) =>
  store.setState((state) => ({ surface: { ...state.surface, ...patch } }));

/**
 * Opens the record of `entryId`, or the roster for null, hung from `anchor`
 * on `side`. Using the panel ends a removal's line.
 */
export function openCast(
  entryId: string | null,
  anchor: HTMLElement | null,
  side: CastSurface["side"] = "top",
): void {
  store.setState({
    surface: { open: true, entryId, fromRoster: entryId === null, anchor, side },
    removal: null,
  });
}

/** From the roster in the surface to one record, and back (null). */
export const showCastEntry = (entryId: string | null): void => setSurface({ entryId });

export const closeCast = (): void => setSurface({ open: false });

/** The roster entry's own control toggles its record, beside it. */
export function toggleCast(entryId: string, anchor: HTMLElement): void {
  const { open, entryId: shown } = store.getState().surface;
  if (open && shown === entryId) closeCast();
  else openCast(entryId, anchor, "inline-end");
}

/** The entries the panel lists: introduced women; the canonical register keeps everyone. */
export const listedEntries = (register: CastRegister): CastEntry[] =>
  register.entries.filter((entry) => entry.introduced === true && entry.anchor.gender === "female");

/**
 * Remove from cast: the entry leaves the cast for this chat, the surface
 * closes, and the roster says so where she was, with Undo.
 */
export function removeFromCast(entry: CastEntry): void {
  const state = chatStore.getState();
  const group = listedEntries(discoveredRegister(state)).filter(
    (other) => other.state.present === entry.state.present,
  );
  store.setState((now) => ({
    surface: { ...now.surface, open: false },
    removal: {
      entryId: entry.id,
      name: entry.anchor.name,
      present: entry.state.present,
      index: Math.max(
        0,
        group.findIndex((other) => other.id === entry.id),
      ),
      key: latestChange(state)?.key ?? null,
    },
  }));
  state.removeCast(entry.id);
}

/** Undo on the removal line: the entry comes back where she was. */
export function undoCastRemoval(): void {
  const { removal } = store.getState();
  if (removal === null) return;
  chatStore.getState().restoreCast(removal.entryId);
  store.setState({ removal: null });
}

/** The removal line while it stands: until the next snapshot lands or the panel is used. */
export function useCastRemoval(): CastRemoval | null {
  const removal = useStore(store, (state) => state.removal);
  const key = useChat((state) => latestChange(state)?.key ?? null);
  return removal !== null && removal.key === key ? removal : null;
}

/** The sheet could not be read and nobody is in the register: the panel says so, with Try again. */
export const sheetUnread = (state: ChatState): boolean =>
  state.cast.sheetStatus === "failed" && discoveredRegister(state).entries.length === 0;

/** No cast model is chosen and nobody is in the register: the panel says how to fill it. */
export const sheetWaiting = (state: ChatState): boolean =>
  state.cast.sheetStatus === "waiting" && discoveredRegister(state).entries.length === 0;

/**
 * The panel shows with at least one introduced woman, present or away,
 * and, with nobody in it yet, while the first sheet waits for a model, is
 * read, or could not be, or the keeper could not update the shown target
 * and, after such a failure, while it tries again.
 */
const castVisible = (state: ChatState): boolean => {
  const register = discoveredRegister(state);
  const { cast } = state;
  return (
    listedEntries(register).length > 0 ||
    (cast.sheetStatus === "loading" && register.entries.length === 0) ||
    sheetWaiting(state) ||
    sheetUnread(state) ||
    ((cast.status === "failed" || (busyOf(state) && cast.failures > 0)) &&
      keeperTargetUncovered(state))
  );
};

/** The keeper is at work: seeding the greeting or updating after a reply. */
export const busyOf = (state: ChatState): boolean =>
  state.cast.status === "updating" || state.cast.status === "seeding";

/** Shown as `castVisible` says, and while a removal's line stands, the last woman's included. */
export function useCastVisible(): boolean {
  const visible = useChat(castVisible);
  const removal = useCastRemoval();
  return visible || removal !== null;
}
