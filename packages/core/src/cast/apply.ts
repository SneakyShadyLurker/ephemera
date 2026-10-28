import { castIdentity, groundedCastChanges } from "./effective.ts";
import { castKey, firstWordKey, isOneWord } from "./key.ts";
import { CAST_LIMITS as L } from "./limits.ts";
import {
  CAST_ANCHOR_FIELDS,
  type CastChange,
  type CastChanges,
  type CastEntry,
  type CastRegister,
  type CastSheetEntry,
  emptyCastAnchor,
  emptyCastState,
  setAnchorFields,
} from "./register.ts";

/*
 * The register's changes, pure: the keeper's answer applied to the register
 * the browser sent, a register seeded from a cast sheet, and a sheet laid
 * over a register. Chat content in and out; nothing is kept.
 */

export interface ApplyOptions {
  /** The persona's name: never an entry. Null drops nothing. */
  player: string | null;
  /** A new entry's id; called once per new entry. */
  newId: () => string;
  /**
   * Ids of entries the owner removed. They stay in `register` and resolve
   * by name and `aka` like any entry, so the keeper cannot add them again;
   * a change or an `absent` that resolves to one leaves it as it was.
   */
  removed?: ReadonlySet<string>;
  /**
   * Every entry the chat has known: a name `register` lacks that one of
   * them carries keeps that entry's id, names and anchor (which a change
   * only fills), never its state, so the owner's corrections and removals
   * stay attached.
   */
  previous?: CastRegister;
  /** Exact shown text of this batch, required for development and continuity updates. */
  shown?: readonly string[];
  /** Owner anchor fields are locked even when explicitly cleared. */
  corrected?: Readonly<Record<string, { anchor: Partial<CastEntry["anchor"]> }>>;
}

/** Whether the entry's name or an earlier one has `key`. */
const named = (entry: CastEntry, key: string): boolean =>
  castKey(entry.anchor.name) === key || entry.aka.some((aka) => castKey(aka) === key);

/** Whether one of two names is a single word that is the other's first: "Maren" and "Maren Holt". */
const firstNameOf = (short: string, full: string): boolean =>
  isOneWord(short) && !isOneWord(full) && castKey(short) === firstWordKey(full);

/**
 * The entry a name means (one rule for the keeper's changes and the sheet's
 * overlay): exact on the name or an `aka`; else the single entry that one
 * of the two names a first name of the other ("Maren" and "Maren Holt").
 * None (-1) when no entry or more than one matches that way.
 */
function resolve(entries: readonly CastEntry[], name: string): number {
  const exact = exactly(entries, name);
  return exact !== -1 ? exact : byFirstName(entries, name);
}

/** Shared name resolution for lifecycle bookkeeping as well as overlays and keeper changes. */
export const resolveCastEntry = (register: CastRegister, name: string): CastEntry | undefined =>
  register.entries[resolve(register.entries, name)];

/** Recover chat identities into a catch-up input, never their old scene state. */
export function withKnownIdentities(register: CastRegister, previous: CastRegister): CastRegister {
  const entries = [...register.entries];
  const ids = new Set(entries.map((entry) => entry.id));
  for (const entry of previous.entries) {
    if (ids.has(entry.id) || resolve(entries, entry.anchor.name) !== -1 || !hasRoom(entries))
      continue;
    entries.push({ ...castIdentity(entry), state: emptyCastState(false) });
    ids.add(entry.id);
  }
  return { entries };
}

/** The entry whose name or an `aka` is `name`; -1 for none. */
const exactly = (entries: readonly CastEntry[], name: string): number => {
  const key = castKey(name);
  return entries.findIndex((entry) => named(entry, key));
};

/** The single entry that `name` is a first name of, or that is a first name of `name`; else -1. */
function byFirstName(entries: readonly CastEntry[], name: string): number {
  const matches = entries.flatMap((entry, at) =>
    firstNameOf(name, entry.anchor.name) || firstNameOf(entry.anchor.name, name) ? [at] : [],
  );
  return matches.length === 1 ? (matches[0] ?? -1) : -1;
}

/**
 * Where a change's name lands in `entries`: exactly by the name or an `aka`,
 * else exactly by its `was`, else by first name; `renamed` when the entry
 * learns the name (a `was`, or a fuller name for a one-word entry). A `was`
 * names whom the keeper means, so it goes before any inference.
 */
function locate(
  entries: readonly CastEntry[],
  name: string,
  change: CastChange,
): { at: number; renamed: boolean } {
  const exact = exactly(entries, name);
  if (exact !== -1) return { at: exact, renamed: false };
  const was = change.was === undefined ? -1 : exactly(entries, change.was);
  if (was !== -1) return { at: was, renamed: true };
  const at = byFirstName(entries, name);
  return { at, renamed: at !== -1 && firstNameOf(entries[at]?.anchor.name ?? "", name) };
}

/**
 * An entry found through what the chat knew, under the name the keeper
 * wrote: that name becomes hers, unless it is her name or only the first
 * name of one she has (then that fuller name); every other name either
 * reading knew joins `aka` (by `castKey`, newest kept past the limit).
 */
function reconciled(target: CastEntry, known: CastEntry, name: string): CastEntry {
  const key = castKey(name);
  const own = [target.anchor.name, known.anchor.name].find(
    (other) => castKey(other) === key || firstNameOf(name, other),
  );
  const anchor = { ...target.anchor, name: own ?? name };
  const seen = new Set([castKey(anchor.name)]);
  const aka: string[] = [];
  const earlier = [...known.aka, known.anchor.name, ...target.aka, target.anchor.name];
  for (const other of earlier) {
    const otherKey = castKey(other);
    if (seen.has(otherKey)) continue;
    seen.add(otherKey);
    aka.push(other);
  }
  return { ...target, anchor, aka: aka.slice(-L.aka) };
}

/** `entry` under the name the chat now gives it, the old one kept in `aka`. */
const renamedTo = (entry: CastEntry, name: string): CastEntry => ({
  ...entry,
  anchor: { ...entry.anchor, name },
  aka: withAka({ ...entry, anchor: { ...entry.anchor, name } }, entry.anchor.name),
});

/** Whether a register has room for one more entry: the one capacity rule. */
const hasRoom = (entries: readonly CastEntry[]): boolean => entries.length < L.entries;

/** Whether `name` is the player: the whole name, or one word that is the player's first. */
function isPlayer(name: string, player: string | null): boolean {
  if (player === null || castKey(player) === "") return false;
  const key = castKey(name);
  return key === castKey(player) || (isOneWord(name) && key === firstWordKey(player));
}

/** `aka` with `earlier` added, oldest dropped past the limit; unchanged when it is the name or known. */
function withAka(entry: CastEntry, earlier: string): string[] {
  const key = castKey(earlier);
  if (named(entry, key)) return entry.aka;
  return [...entry.aka, earlier].slice(-L.aka);
}

/** `entry` with the change's anchor filled where empty, its role and state written. */
function changed(
  entry: CastEntry,
  change: CastChange,
  correction: Partial<CastEntry["anchor"]> = {},
): CastEntry {
  const anchor = { ...entry.anchor };
  const given = setAnchorFields(change.anchor ?? {});
  for (const field of CAST_ANCHOR_FIELDS) {
    const value = given[field];
    if (value !== undefined && anchor[field] === "" && !(field in correction))
      anchor[field] = value;
  }
  // `other` is what a missing gender reads as, so a later answer may say which.
  if (change.gender !== undefined && anchor.gender === "other" && !("gender" in correction))
    anchor.gender = change.gender;
  const developments = { ...entry.developments };
  for (const field of CAST_ANCHOR_FIELDS) {
    const update = change.developments?.[field];
    if (update === undefined || field in correction) continue;
    // Empty baseline admission belongs to the original `anchor` path.
    if (anchor[field] !== "") developments[field] = update.value;
  }
  const continuity = { ...entry.continuity };
  for (const field of ["voice", "goals", "knowledge"] as const) {
    const update = change.continuity?.[field];
    if (update !== undefined) continuity[field] = update.value;
  }
  return {
    ...entry,
    role: change.role ?? entry.role,
    anchor,
    ...(Object.keys(developments).length === 0 ? {} : { developments }),
    ...(Object.keys(continuity).length === 0 ? {} : { continuity }),
    state: {
      ...entry.state,
      ...definedState(change.state),
      present: change.state?.present ?? true,
    },
  };
}

/** The given state fields, without the ones the change left out. */
const definedState = (state: CastChange["state"]): Partial<CastEntry["state"]> =>
  Object.fromEntries(Object.entries(state ?? {}).filter(([, value]) => value !== undefined));

/**
 * The register after the keeper's changes (spec § 3.5): each change resolved
 * to an entry by name or `aka` or a single first-name match (a fuller name
 * renames a one-word entry), then `was`, then an identity the reply's earlier
 * the chat knew before (`previous`), else a new entry; the player's names dropped; a set anchor field never
 * rewritten; state written as given, everyone named present unless the
 * change says otherwise; `absent` names marked away; new entries past
 * `CAST_LIMITS.entries` refused.
 */
export function applyCastChanges(
  register: CastRegister,
  changes: CastChanges,
  { player, newId, removed = new Set(), previous, shown = [], corrected = {} }: ApplyOptions,
): CastRegister {
  changes = groundedCastChanges(changes, shown);
  const entries = [...register.entries];
  for (const [name, change] of Object.entries(changes.cast)) {
    if (isPlayer(name, player)) continue;
    // A fuller name for a one-word entry is that entry learning its name, as `was` says.
    const { at, renamed } = locate(entries, name, change);
    const entry = entries[at];
    if (entry !== undefined) {
      if (removed.has(entry.id)) continue;
      entries[at] = changed(
        renamed ? renamedTo(entry, name) : entry,
        change,
        corrected[entry.id]?.anchor,
      );
      continue;
    }
    // Known to the chat before (`previous`): the entry keeps its id, found as above (a `was` and a
    // rename included); in the register under another name, that entry; a removed one stays.
    // What it lends is who she is and her looks, never her state: the turns read describe that.
    const earlier = previous === undefined ? undefined : locate(previous.entries, name, change);
    const found = earlier === undefined ? undefined : previous?.entries[earlier.at];
    if (found !== undefined) {
      const known: CastEntry = { ...castIdentity(found), state: emptyCastState(false) };
      const here = entries.findIndex((other) => other.id === known.id);
      const target = entries[here] ?? known;
      if (removed.has(known.id)) {
        if (here === -1 && hasRoom(entries)) entries.push(known);
        continue;
      }
      const next = changed(reconciled(target, known, name), change, corrected[target.id]?.anchor);
      if (here !== -1) entries[here] = next;
      else if (hasRoom(entries)) entries.push(next);
      continue;
    }
    if (!hasRoom(entries)) continue;
    entries.push(
      changed(
        {
          id: newId(),
          role: change.role ?? "minor",
          anchor: emptyCastAnchor(name, change.gender ?? "other"),
          aka: [],
          state: emptyCastState(true),
        },
        change,
      ),
    );
  }
  for (const name of changes.absent) {
    if (isPlayer(name, player)) continue;
    const at = resolve(entries, name);
    const entry = entries[at];
    if (entry === undefined || removed.has(entry.id)) continue;
    entries[at] = { ...entry, state: { ...entry.state, present: false } };
  }
  return { entries };
}

/** A register seeded from a cast sheet: every entry away, in sheet order, ids as the sheet has them. */
export const registerFromSheet = (sheet: { entries: readonly CastSheetEntry[] }): CastRegister => ({
  entries: sheet.entries.map((entry) => ({ ...entry, state: emptyCastState(false) })),
});

/**
 * The sheet laid over a register (the web's overlay): for every sheet entry,
 * the register entry with its id, else the one a sheet name resolves to as
 * a keeper's name would (exact, then a single first-name match; one that
 * more than one sheet entry would take by first name, or an exact match
 * took, is no one's), takes the
 * sheet's gender and every anchor field the
 * sheet has set (the sheet is read from the card); its name stays the
 * chat's. A sheet entry with no match is added away at the end, in sheet
 * order, while the register has room. Pure and idempotent.
 */
export function withSheet(
  sheet: { entries: readonly CastSheetEntry[] },
  register: CastRegister,
  options: { player?: string | null; fillOnly?: boolean } = {},
): CastRegister {
  if (options.player != null) {
    sheet = {
      entries: sheet.entries.filter((item) => !isPlayer(item.anchor.name, options.player ?? null)),
    };
  }
  const entries = [...register.entries];
  // Every sheet entry is resolved first: by id, else exactly by a name or `aka`. The rest are
  // appended unless a first name finds them a register entry. Those appended count as people too:
  // a first name that also fits one of them, or more than one person, or that another sheet
  // entry claims, or that an exact match took, is no one's. So a second pass decides the same.
  const exact = sheet.entries.map((item) => {
    const at = register.entries.findIndex((entry) => entry.id === item.id);
    return at !== -1
      ? at
      : [item.anchor.name, ...item.aka].reduce(
          (found, name) => (found === -1 ? exactly(register.entries, name) : found),
          -1,
        );
  });
  const appended = sheet.entries.filter((_, index) => exact[index] === -1);
  const found = sheet.entries.map((item, index) => {
    const at = exact[index] ?? -1;
    if (at !== -1) return { at, exact: true };
    const people = [
      ...register.entries,
      ...appended
        .filter((other) => other !== item)
        .map((other) => ({ ...other, state: emptyCastState(false) })),
    ];
    const match = [item.anchor.name, ...item.aka].reduce(
      (found, name) => (found === -1 ? byFirstName(people, name) : found),
      -1,
    );
    return { at: match < register.entries.length ? match : -1, exact: false };
  });
  const claims = (at: number, exact: boolean) =>
    found.filter((other) => other.at === at && other.exact === exact).length;
  const targets = found.map(({ at, exact }) =>
    at === -1 || exact || (claims(at, false) === 1 && claims(at, true) === 0) ? at : -1,
  );
  for (const [index, item] of sheet.entries.entries()) {
    const at = targets[index] ?? -1;
    const entry = entries[at];
    if (entry === undefined) {
      if (hasRoom(entries)) entries.push({ ...item, state: emptyCastState(false) });
      continue;
    }
    entries[at] = {
      ...entry,
      anchor: {
        ...entry.anchor,
        ...setAnchorFields(
          options.fillOnly
            ? Object.fromEntries(
                Object.entries(item.anchor).filter(
                  ([field]) => entry.anchor[field as keyof typeof entry.anchor] === "",
                ),
              )
            : item.anchor,
        ),
        gender:
          options.fillOnly && entry.anchor.gender !== "other"
            ? entry.anchor.gender
            : item.anchor.gender,
      },
    };
  }
  return { entries };
}
