import { isDeepStrictEqual } from "node:util";
import type { Updated } from "./store.ts";

/** A partial edit without its absent keys: what the edit sets. */
export const defined = <T extends object>(patch: T) =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/**
 * A revision-guarded edit (`Updated`), inside the caller's transaction: no
 * row is `missing`. At another revision, an edit that would change nothing
 * (a retried save whose answer was lost) is answered as saved with the row
 * as it is, and any other, one the row cannot take included, is a conflict.
 * At this revision `write` stores the edited row at the next revision and
 * returns it as stored.
 */
export function revised<Row extends { revision: number }, Next>(
  current: Row | undefined,
  expected: number,
  edit: {
    /** The edit applied to the row; may throw for one the row cannot take. */
    apply: (row: Row) => Next;
    /** The row as `apply` shapes it: the edit changes nothing when both are deeply equal. */
    compare: (row: Row) => Next;
    write: (next: Next, revision: number) => Row | undefined;
  },
): Updated<Row> {
  if (current === undefined) return { status: "missing" };
  if (current.revision !== expected) {
    let unchanged: boolean;
    try {
      unchanged = isDeepStrictEqual(edit.apply(current), edit.compare(current));
    } catch {
      unchanged = false;
    }
    return unchanged
      ? { status: "updated", value: current }
      : { status: "conflict", revision: current.revision };
  }
  const value = edit.write(edit.apply(current), expected + 1);
  return value === undefined ? { status: "missing" } : { status: "updated", value };
}
