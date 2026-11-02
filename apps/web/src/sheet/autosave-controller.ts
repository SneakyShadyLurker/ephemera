import type { z } from "zod";
import { signIn } from "../signin/signin.ts";
import type { SaveStatus } from "./autosave.ts";
import type { CreateResult, SaveFailure, SaveResult } from "./saving.ts";

export interface AutosaveOptions<
  Fields extends { name: string },
  Saved extends { revision: number },
> {
  id: string | null;
  /** The revision the editor loaded (0 for a new entity); read once, when the owner is made. */
  revision: number;
  fields: Fields;
  schema: z.ZodType<Fields>;
  labels: Record<keyof Fields & string, string>;
  /**
   * A field's limit in plain words ("a cue holds at most 60 characters"),
   * said instead of "is over the limit" when that field stops a save.
   */
  overLimit?: (key: keyof Fields & string, fields: Fields) => string | undefined;
  wholeLabel: string;
  /**
   * Fields another screen also edits (the sheet's lorebook): Keep mine sends
   * one only when this sheet changed it, so it never writes back a copy it
   * merely loaded over the other screen's save.
   */
  shared?: readonly (keyof Fields & string)[];
  create?: (id: string, fields: Fields) => Promise<CreateResult>;
  /** Saves `patch` against `revision`; what was saved carries the entity's new revision. */
  save: (id: string, patch: Partial<Fields>, revision: number) => Promise<SaveResult<Saved>>;
  onCreated?: (id: string) => void;
  onSaved: (id: string, saved: Saved) => void;
}

const RETRY_MS = [2_000, 5_000, 10_000, 30_000];
/** The pause after the last edit before saving. */
const PAUSE_MS = 600;
/** Edits that keep arriving still save this long after the first unsaved one. */
const LONGEST_WAIT_MS = 2_000;

/**
 * One sheet's in-memory save owner, including work queued while a request runs.
 *
 * A field is unsaved while its committed value differs from the last value
 * the server accepted. `update` brings in each commit, so an edit that
 * commits after a save began (a transition, a queued update) is still found
 * and saved; `touch` only says an edit is on its way, for the status and the
 * timer. Values compare by identity: every edit makes a new value.
 *
 * Each save names the revision the editor last had. A save another tab
 * overtook is refused as a conflict: nothing more is sent until the owner
 * reloads (the sheet remounts with the saved entity) or keeps their edits
 * (`keepMine` saves this tab's version over the other tab's).
 */
export function createAutosave<Fields extends { name: string }, Saved extends { revision: number }>(
  initialOptions: AutosaveOptions<Fields, Saved>,
  report: (status: SaveStatus) => void,
) {
  type Key = keyof Fields & string;
  let options = initialOptions;
  let id = options.id;
  /** The revision the server last accepted from this sheet (or the editor loaded). */
  let revision = options.revision;
  /** Set after a conflict: the revision another tab's save left. Nothing is sent meanwhile. */
  let conflicted: number | undefined;
  const newId = crypto.randomUUID();
  /** Keys touched but not yet sent. */
  const dirty = new Set<Key>();
  /** Per key, the value the server last accepted; none before a first create. */
  let accepted: Record<string, unknown> | null = id === null ? null : { ...options.fields };
  let createSnapshot: Fields | undefined;
  /** The committed values the create snapshot was parsed from. */
  let createSource: Fields | undefined;
  let pendingCreated = false;
  /** Whether a create went out under `newId`: the entity may exist though no answer said so. */
  let createSent = false;
  let disposed = true;
  let discarded = false;
  /** Set while a deletion runs: nothing new is sent until `resume`. */
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the oldest unsaved edit was scheduled; the longest wait counts from it. */
  let waitingSince: number | null = null;
  let attempt = 0;
  let inFlight: Promise<boolean> | null = null;
  /** An edit committed while a save ran; scheduled once it ends if that save did not take it. */
  let editedDuringSave = false;
  /**
   * A save whose answer never came: the server may have applied it. It is sent
   * again exactly as it was, alone, so the server answers it as saved either
   * way and names its revision before newer edits go out against it.
   */
  let uncertain: { patch: Partial<Fields>; values: Record<string, unknown> } | null = null;
  /** Set while the edits wait for a session: nothing is sent until the renewal flushes them. */
  let heldForSignIn: (() => void) | undefined;
  let stopResuming: (() => void) | undefined;

  const releaseHold = () => {
    heldForSignIn?.();
    heldForSignIn = undefined;
  };

  const keys = () => Object.keys(options.fields) as Key[];
  /** Keys whose committed value is not the accepted one. */
  const changed = () =>
    accepted === null ? keys() : keys().filter((key) => options.fields[key] !== accepted?.[key]);

  /** Saves after `delay`; an edit's pause never runs past the longest wait, a retry's backoff may. */
  function schedule(delay: number, retry = false) {
    clearTimeout(timer);
    if (disposed || discarded || paused) return;
    // Signed out: the renewal saves everything at once.
    if (heldForSignIn !== undefined) {
      report({ kind: "signed-out" });
      return;
    }
    // Changed in another tab: edits wait for Reload or Keep mine.
    if (conflicted !== undefined) {
      report({ kind: "conflict" });
      return;
    }
    let wait = delay;
    if (!retry) {
      const now = Date.now();
      waitingSince ??= now;
      wait = Math.min(delay, Math.max(0, waitingSince + LONGEST_WAIT_MS - now));
    }
    timer = setTimeout(() => void flush(), wait);
  }

  async function run(): Promise<boolean> {
    clearTimeout(timer);
    waitingSince = null;
    while (!disposed && !discarded && !paused) {
      if (conflicted !== undefined) {
        report({ kind: "conflict" });
        return false;
      }
      const { fields, schema, labels, overLimit, wholeLabel, create, save, onSaved, onCreated } =
        options;
      for (const key of changed()) dirty.add(key);
      if (dirty.size === 0 && id !== null) {
        report({ kind: "saved" });
        if (pendingCreated) {
          pendingCreated = false;
          onCreated?.(id);
        }
        return true;
      }
      const parsed = schema.safeParse(fields);
      if (!parsed.success) {
        const key = String(parsed.error.issues[0]?.path[0] ?? "name");
        const limit = overLimit?.(key as Key, fields);
        report(
          key === "name" && fields.name.trim() === ""
            ? { kind: "needs-name" }
            : {
                kind: "invalid",
                field: labels[key as Key] ?? key,
                ...(limit === undefined ? {} : { limit }),
              },
        );
        return false;
      }
      const sent = new Set(dirty);
      dirty.clear();
      report({ kind: "saving" });
      let failure: SaveFailure | undefined;
      /** What a resent save carried, when the server refused it outright. */
      let refusedResend: Record<string, unknown> | undefined;
      if (id === null) {
        // A lost response can mean this exact snapshot already exists. Every
        // retry sends it again; subsequent edits are reconciled with PATCH.
        if (createSnapshot === undefined) {
          createSnapshot = parsed.data;
          createSource = fields;
        }
        createSent = create !== undefined;
        const result = create
          ? await create(newId, createSnapshot)
          : ({ ok: false, reason: "invalid" } as const);
        if (discarded || disposed) return discarded;
        if (result.ok) {
          id = newId;
          pendingCreated = true;
          // What the create carried is accepted; anything edited since is found by value.
          accepted = { ...createSource };
          createSnapshot = undefined;
          createSource = undefined;
        } else {
          failure = result.reason;
          // A definitive refusal did not create this snapshot. Let corrected
          // fields replace it, while uncertain failures keep their retry identity.
          if (failure === "invalid" || failure === "too_large") {
            createSnapshot = undefined;
            createSource = undefined;
          }
        }
      } else {
        const resend = uncertain;
        const values =
          resend?.values ?? Object.fromEntries([...sent].map((key) => [key, fields[key]]));
        const patch =
          resend?.patch ??
          (Object.fromEntries([...sent].map((key) => [key, parsed.data[key]])) as Partial<Fields>);
        // Keys the resend does not carry wait for the next pass, against the revision it names.
        if (resend !== null) for (const key of sent) if (!(key in patch)) dirty.add(key);
        const result = await save(id, patch, revision);
        if (discarded || disposed) return discarded;
        // Signed out, the request never reached Ephemera: what was uncertain stays so. While
        // no answer comes (offline) the resend keeps going alone; one the server answers
        // with an error gives that up, so one failing patch never holds back later edits.
        if (result.ok || result.reason !== "signed_out") {
          const silent = !result.ok && result.reason === "unreachable" && !("answered" in result);
          uncertain =
            !result.ok && result.reason === "unreachable" && (resend === null || silent)
              ? { patch, values }
              : null;
        }
        if (result.ok) {
          accepted = { ...accepted, ...values };
          revision = result.saved.revision;
          onSaved(id, result.saved);
        } else {
          failure = result.reason;
          if (result.reason === "conflict") conflicted = result.revision;
          if (resend !== null && (failure === "invalid" || failure === "too_large")) {
            refusedResend = values;
          }
        }
      }
      if (failure === undefined) {
        attempt = 0;
        releaseHold();
        // Drain edits made during the request before saying Saved or navigating.
        continue;
      }
      for (const key of sent) dirty.add(key);
      if (failure === "signed_out") {
        heldForSignIn ??= signIn.holdEdits();
        report({ kind: "signed-out" });
      } else if (failure === "conflict") report({ kind: "conflict" });
      else if (failure === "gone") report({ kind: "gone" });
      else if (failure === "invalid") report({ kind: "invalid", field: "A field" });
      else if (failure === "too_large") report({ kind: "invalid", field: wholeLabel });
      else {
        report({ kind: "unreachable" });
        waitingSince = null;
        schedule(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)] ?? 30_000, true);
      }
      // The refused resend was the old patch; the fields as they are now may be valid.
      const after = refusedResend;
      if (
        after !== undefined &&
        Object.keys(after).some((key) => options.fields[key as Key] !== after[key])
      ) {
        schedule(PAUSE_MS);
      }
      return false;
    }
    return discarded;
  }

  /** Serialize both active and queued flushes; unmount/deletion makes queued work inert. */
  function flush(): Promise<boolean> {
    if (discarded) return Promise.resolve(true);
    if (disposed) return Promise.resolve(false);
    const next = (inFlight ?? Promise.resolve(true)).then(run);
    const tracked = next.finally(() => {
      if (inFlight !== tracked) return;
      inFlight = null;
      // An edit that arrived during a save the server refused is not lost: it saves after a pause.
      if (editedDuringSave) {
        editedDuringSave = false;
        if (!disposed && !discarded && id !== null && changed().length > 0) schedule(PAUSE_MS);
      }
    });
    inFlight = tracked;
    return next;
  }

  const hasEdits = () => dirty.size > 0 || (id !== null && changed().length > 0);

  return {
    /** Each commit's options; a committed value the server has not accepted is saved. */
    update: (next: AutosaveOptions<Fields, Saved>) => {
      const previous = options.fields;
      options = next;
      if (disposed || discarded || id === null) return;
      // Only a newly committed edit schedules; a re-render of the same values (a status
      // change, a retry's backoff) leaves the timer as it is.
      const edited = keys().some((key) => next.fields[key] !== previous[key]);
      // A running save takes the edit when it succeeds; otherwise it is scheduled after it.
      if (inFlight !== null) {
        if (edited) editedDuringSave = true;
        return;
      }
      if (edited && changed().length > 0) {
        report({ kind: "saving" });
        schedule(PAUSE_MS);
      }
    },
    flush,
    mount: () => {
      disposed = false;
      stopResuming = signIn.onRenewed(async () => {
        if (heldForSignIn === undefined) return;
        releaseHold();
        return (await flush()) ? "edits" : undefined;
      });
      if (hasEdits()) schedule(PAUSE_MS);
    },
    unmount: () => {
      disposed = true;
      clearTimeout(timer);
      waitingSince = null;
      stopResuming?.();
      releaseHold();
    },
    touch: (...touched: Key[]) => {
      if (disposed || discarded) return;
      for (const key of touched) dirty.add(key);
      if (options.fields.name.trim() !== "" || id !== null) report({ kind: "saving" });
      schedule(PAUSE_MS);
    },
    /**
     * After a conflict: saves this tab's whole version over the other tab's
     * save, against the revision it left, so no field here shows a value the
     * server lacks. Another tab saving first again is another conflict.
     */
    keepMine: () => {
      if (conflicted !== undefined) {
        revision = conflicted;
        conflicted = undefined;
        const unsaved = new Set(changed());
        for (const key of keys()) {
          if (!options.shared?.includes(key) || unsaved.has(key)) dirty.add(key);
        }
      }
      return flush();
    },
    /** Whether the field holds a value the server has not accepted from this sheet. */
    isUnsaved: (key: Key) => dirty.has(key) || changed().includes(key),
    /**
     * Takes values the server held at `saved` (a saved copy, such as another
     * screen's save) as this sheet's committed and accepted ones, so nothing
     * sends them back; the editor then writes the same values into its
     * fields. A copy older than this sheet's last save is refused (false).
     * The revision stays the one this sheet last saved against.
     */
    adopt: (values: Partial<Fields>, saved: number): boolean => {
      if (accepted === null || saved < revision) return false;
      accepted = { ...accepted, ...values };
      options = { ...options, fields: { ...options.fields, ...values } };
      return true;
    },
    /**
     * Before a deletion: stops sending, keeping every edit, until `resume`
     * (the deletion failed) or `discard` (it succeeded).
     */
    pause: () => {
      paused = true;
      clearTimeout(timer);
      waitingSince = null;
    },
    /** After a deletion that failed: saving goes on from where `pause` stopped it. */
    resume: () => {
      if (!paused) return;
      paused = false;
      schedule(PAUSE_MS);
    },
    /**
     * After `pause`, for an entity deleted while a save may be on its way:
     * waits for the save in flight, then gives the id the entity has or may
     * have been created under, null when no create went out.
     */
    settle: async (): Promise<string | null> => {
      await inFlight?.catch(() => undefined);
      return id ?? (createSent ? newId : null);
    },
    /** Call only once deletion succeeds; late saves then cannot resurrect edits or callbacks. */
    discard: () => {
      discarded = true;
      clearTimeout(timer);
      dirty.clear();
      releaseHold();
    },
    hasUnsaved: () =>
      !discarded &&
      (hasEdits() || inFlight !== null || (id === null && options.fields.name.trim() !== "")),
  };
}
