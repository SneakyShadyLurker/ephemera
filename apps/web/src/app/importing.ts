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

/**
 * Sends one file's import; never throws, so a batch reports every file.
 * `reasons` words each refusal code the route answers with 422 (typed from
 * the route, so a new code fails the typecheck there); `read` parses the
 * success body with its core schema.
 */
export async function importFile<Refusal extends string, T extends object>(
  file: File,
  send: (init: { signal: AbortSignal }) => Promise<Response>,
  reasons: Record<Refusal, string>,
  read: (body: unknown) => T | undefined,
): Promise<FileImport<T>> {
  const key = crypto.randomUUID();
  const fail = (reason: string): FileImport<T> => ({ key, ok: false, file: file.name, reason });
  try {
    const response = await send({ signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS) });
    if (response.status === 413) return fail(TOO_LARGE);
    // A body cut off or not Ephemera's is that file's failure, never a thrown batch.
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const imported = read(body);
      return imported === undefined
        ? fail(notReached())
        : { key, ok: true, file: file.name, ...imported };
    }
    const refusal = response.status === 422 ? refusalOf(body, reasons) : undefined;
    return fail(refusal ?? notReached());
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
export type ImportProgress = { done: number; total: number };

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
