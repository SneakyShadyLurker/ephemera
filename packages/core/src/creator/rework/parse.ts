import { scan, type Tagged } from "../parse.ts";
import { parseFieldKey } from "./fields.ts";
import type { ReworkProblem } from "./schema.ts";

/*
 * One reading of a rework answer: `<change>` blocks, then one `<summary>`.
 * The same scan serves the stream and the finished answer. Blocks are found
 * only at the top level, after the previous block closed, so a literal
 * `<change>` inside a find or replace is text, not a new block. A block is
 * read once its `</change>` arrived; one never closed is not read.
 *
 * Find and replace are taken byte for byte between their tags, except one
 * leading and one trailing newline: models put the block content on its own
 * lines, which the prompt does not ask for and the field does not hold.
 * Field and why are trimmed.
 */

/** One change block as written, before it is placed in the card. */
export interface RawChange {
  /** The field key as written, trimmed; `parseFieldKey` reads it. */
  field: string;
  /** The model's reason, trimmed; empty when absent. */
  why: string;
  find: string;
  replace: string;
  /** Order of arrival, from 0. */
  at: number;
}

interface ChangeRead {
  /** The blocks that closed after `from`, in order. */
  changes: RawChange[];
  /** Where the next read starts: after the last closed block, never before `from`. */
  next: number;
  /**
   * Closed blocks skipped because they lack a field, a replace or (but for a
   * new greeting or entry) a find, nest another change or leave a tag open.
   */
  malformed: number;
}

interface ReworkAnswer {
  changes: RawChange[];
  /** The summary, trimmed; null when absent or empty. */
  summary: string | null;
  problems: ReworkProblem[];
  malformed: number;
}

const TOP_OPEN = "<(change|summary)\\s*>";
const INNER_OPEN = "<(field|why|find|replace)\\s*>";
const NESTED = /<change\s*>/u;

/** Find and replace text without the one newline a model puts on each side. */
const unwrap = (text: string): string => text.replace(/^\n/u, "").replace(/\n$/u, "");

/** The top-level blocks from `from` on, with offsets into the whole answer. */
function topLevel(answer: string, from: number): Tagged[] {
  return scan(answer.slice(from), TOP_OPEN).map((tagged) => ({
    ...tagged,
    at: tagged.at + from,
    end: tagged.end + from,
  }));
}

/** The four inner tags of a closed block; undefined when the block is malformed. */
function readBlock(body: string): Omit<RawChange, "at"> | undefined {
  const inner = scan(body, INNER_OPEN);
  if (inner.some((tagged) => tagged.state === "incomplete")) return undefined;
  let outside = "";
  let last = 0;
  for (const tagged of inner) {
    outside += body.slice(last, tagged.at);
    last = tagged.end;
  }
  outside += body.slice(last);
  if (NESTED.test(outside)) return undefined;
  const first = (name: string) => inner.find((tagged) => tagged.name === name)?.body;
  const field = first("field")?.trim();
  const find = first("find");
  const replace = first("replace");
  if (field === undefined || field === "" || replace === undefined) return undefined;
  // An empty find replaces the whole field, so only an explicit one says so; a new item has none.
  const kind = parseFieldKey(field)?.kind;
  if (find === undefined && kind !== "alternate_new" && kind !== "entry_new") return undefined;
  return {
    field,
    why: (first("why") ?? "").trim(),
    find: unwrap(find ?? ""),
    replace: unwrap(replace),
  };
}

/**
 * The change blocks that closed after `from`, for reading an answer while it
 * streams: the caller keeps `next` and passes it back with the count read so
 * far (`seen`), so text before `next` is never scanned again.
 */
export function readChanges(answer: string, from: number, seen = 0): ChangeRead {
  const changes: RawChange[] = [];
  let next = from;
  let malformed = 0;
  for (const tagged of topLevel(answer, from)) {
    if (tagged.state === "incomplete") break;
    next = tagged.end;
    if (tagged.name !== "change") continue;
    const block = readBlock(tagged.body);
    if (block === undefined) malformed += 1;
    else changes.push({ ...block, at: seen + changes.length });
  }
  return { changes, next, malformed };
}

/** Reads a finished answer: every change, the summary and what is wrong with it as a whole. */
export function parseReworkAnswer(answer: string): ReworkAnswer {
  const { changes, malformed } = readChanges(answer, 0);
  const blocks = topLevel(answer, 0);
  const summary =
    blocks
      .find((tagged) => tagged.name === "summary" && tagged.state === "complete")
      ?.body.trim() || null;
  const problems: ReworkProblem[] = [];
  if (blocks.some((tagged) => tagged.name === "change" && tagged.state === "incomplete")) {
    problems.push("incomplete");
  }
  if (summary === null) problems.push("no_summary");
  return { changes, summary, problems, malformed };
}
