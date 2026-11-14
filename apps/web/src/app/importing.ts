import { MAX_REQUEST_BYTES } from "@ephemera/core";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { notReached } from "../signin/signin.ts";

/*
 * How a list screen imports files: one at a time through the entity's
 * import route, each answer read the same way, the batch's progress and
 * outcomes kept in memory while the tab is open. File names and refusal
 * codes only, never a file's text.
 */

/** JSON files a drop or picker may offer; anything else is left to the server to refuse. */
export const JSON_FILE_TYPES = ".json,application/json";

/** An upload of up to 32 MB, over a slow uplink too, that has not answered by then is not reached. */
const IMPORT_TIMEOUT_MS = 600_000;

/** One file's import: what the route answered, or why it was not imported. */
export type FileImport<T> = { key: string; file: string } & (
  | ({ ok: true } & T)
  | { ok: false; reason: string }
);

/** What an import says when a file is past the body limit, whichever route refused it. */
const TOO_LARGE = "it is larger than Ephemera accepts";

/** The ids an import's records take: one record, or a pair made from one file. */
export type ImportIds = { id: string; pairId: string };

/**
 * The ids of imports whose answer never came, by the kind of import and a
 * digest of the file's bytes (never its text). Such an import may have been
 * stored, so the same file sent to the same import again carries the same
 * ids and the server stores it once.
 */
const unanswered = new Map<string, ImportIds>();

/**
 * The key of `file` in `unanswered`; undefined, so nothing is kept for it,
 * when its bytes cannot be read or it is past what any import accepts: such
 * a file is refused by the server unread, and is never read here either.
 */
async function importKey(kind: string, file: File): Promise<string | undefined> {
  if (file.size > MAX_REQUEST_BYTES) return undefined;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
    return `${kind}\n${hex.join("")}`;
  } catch {
    return undefined;
  }
}

/**
 * Sends one file's import; never throws, so a batch reports every file.
 * `kind` names the import, and `send` gives the route the ids its records take.
 * `reasons` words each refusal code the route answers with 422 (typed from
 * the route, so a new code fails the typecheck there); `read` parses the
 * success body with its core schema.
 */
export async function importFile<Refusal extends string, T extends object>(
  kind: string,
  file: File,
  send: (init: { signal: AbortSignal }, ids: ImportIds) => Promise<Response>,
  reasons: Record<Refusal, string>,
  read: (body: unknown) => T | undefined,
): Promise<FileImport<T>> {
  const key = crypto.randomUUID();
  const fail = (reason: string): FileImport<T> => ({ key, ok: false, file: file.name, reason });
  const held = await importKey(kind, file);
  const ids = (held === undefined ? undefined : unanswered.get(held)) ?? {
    id: crypto.randomUUID(),
    pairId: crypto.randomUUID(),
  };
  // Until an answer is read, the import may have been stored under these ids.
  if (held !== undefined) unanswered.set(held, ids);
  const answered = <Outcome>(outcome: Outcome): Outcome => {
    if (held !== undefined) unanswered.delete(held);
    return outcome;
  };
  try {
    const response = await send({ signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS) }, ids);
    if (response.status === 413) return answered(fail(TOO_LARGE));
    // A body cut off or not Ephemera's is that file's failure, never a thrown batch.
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const imported = read(body);
      return imported === undefined
        ? fail(notReached())
        : answered({ key, ok: true, file: file.name, ...imported });
    }
    const refusal = response.status === 422 ? refusalOf(body, reasons) : undefined;
    return refusal === undefined ? fail(notReached()) : answered(fail(refusal));
  } catch {
    return fail(notReached());
  }
}

/** A refusal's words, with the schema path of the field at fault when the route names one. */
function refusalOf<Refusal extends string>(
  body: unknown,
  reasons: Record<Refusal, string>,
): string | undefined {
  const refusal = z
    .object({
      error: z.enum(Object.keys(reasons) as [Refusal, ...Refusal[]]),
      field: z.string().optional(),
    })
    .safeParse(body);
  if (!refusal.success) return undefined;
  // Never card text: core's import names the field by its path.
  const { error, field } = refusal.data;
  return reasons[error] + (field === undefined ? "" : ` (${field})`);
}

/** A file refused before it is sent: too large to send, as the server would say. */
export const tooLargeImport = <T>(file: File): FileImport<T> => ({
  key: crypto.randomUUID(),
  ok: false,
  file: file.name,
  reason: TOO_LARGE,
});

/** The import running now: files done of all files queued onto it. */
type ImportProgress = { done: number; total: number };

/** "Importing…" for one file, "Importing 2 of 5…" for a batch. */
export const importProgress = ({ done, total }: ImportProgress): string =>
  total === 1 ? "Importing…" : `Importing ${Math.min(done + 1, total)} of ${total}…`;

interface ImportState<Outcome> {
  importing: ImportProgress | null;
  /** Outcomes of the latest batch, shown until dismissed. */
  report: Outcome[];
}

/**
 * One screen's import queue, kept in memory for the tab so a batch carries
 * on and reports while the owner is elsewhere. Files picked or dropped while
 * a batch runs join it and its one report; each file that arrives goes to
 * the latest `arrive` (a refresh, the "Imported" mark) before the next.
 */
export function createImportQueue<Outcome extends { ok: boolean }>(
  importOne: (file: File) => Promise<Outcome>,
) {
  const store = createStore<ImportState<Outcome>>()(() => ({ importing: null, report: [] }));
  const queue: File[] = [];
  let running: Promise<void> | null = null;
  let arrive: (outcome: Extract<Outcome, { ok: true }>) => Promise<void> | void = () => {};

  const add = (
    files: File[],
    onArrive: (outcome: Extract<Outcome, { ok: true }>) => Promise<void> | void,
  ): Promise<void> => {
    if (files.length === 0) return running ?? Promise.resolve();
    arrive = onArrive;
    queue.push(...files);
    store.setState(({ importing, report }) => ({
      report: running === null ? [] : report,
      importing: { done: importing?.done ?? 0, total: (importing?.total ?? 0) + files.length },
    }));
    running ??= (async () => {
      const outcomes: Outcome[] = [];
      try {
        for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
          const outcome = await importOne(file);
          outcomes.push(outcome);
          store.setState(({ importing }) => ({
            importing: importing && { ...importing, done: importing.done + 1 },
          }));
          if (outcome.ok) await arrive(outcome as Extract<Outcome, { ok: true }>);
        }
      } finally {
        // Whatever ends the batch, the next pick or drop starts a new one.
        queue.length = 0;
        store.setState({ report: outcomes, importing: null });
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    add,
    /** Dismisses one outcome, or the whole report. */
    dismiss: (outcome?: Outcome) =>
      store.setState(({ report }) => ({
        report: outcome === undefined ? [] : report.filter((other) => other !== outcome),
      })),
    use: <T>(selector: (state: ImportState<Outcome>) => T): T => useStore(store, selector),
  };
}
