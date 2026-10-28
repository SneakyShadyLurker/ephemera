import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import relativeTime from "dayjs/plugin/relativeTime.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { CARD_LIMITS } from "../card/limits.ts";
import type { GenerationType } from "../preset/prompt.ts";
import {
  emptyMacroState,
  MACRO_STATE_LIMITS,
  type MacroState,
  RESERVED_MACRO_NAME,
} from "./macro-state.ts";

/** Native text macros use bounded work and memory-only state. Unknown macros remain literal. Date and time come from the request clock. */

interface MacroFields {
  characterSystemPrompt?: string;
  postHistoryInstructions?: string;
  characterNote?: string;
  creatorNotes?: string;
  characterVersion?: string;
  exampleDialogue?: string;
  firstMessage?: string;
  alternateGreetings?: readonly string[];
  lastMessage?: string;
  lastMessageId?: number;
  lastUserMessage?: string;
  lastCharMessage?: string;
  firstIncludedMessageId?: number;
  firstDisplayedMessageId?: number;
  lastSwipeId?: number;
  currentSwipeId?: number;
  allChatRange?: string;
  summary?: string;
  maxPrompt?: number;
  maxContextTokens?: number;
  maxResponseTokens?: number;
  model?: string;
  isMobile?: boolean;
  lastGenerationType?: GenerationType;
  idleDuration?: string;
  input?: string;
  systemPrompt?: string;
  defaultSystemPrompt?: string;
  authorsNote?: string;
  reasoningPrefix?: string;
  reasoningSuffix?: string;
  reasoningSeparator?: string;
}

/** Request-local accounting only; a caller may throw when its shared work bound is spent. */
export type MacroWorkBudget = (units: number) => void;

export interface MacroContext extends MacroFields {
  /** `{{char}}`: the card's name. */
  char: string;
  /** `{{user}}`: the persona's name, or "User". */
  user: string;
  description: string;
  personality: string;
  scenario: string;
  /** `{{persona}}`: the persona's description. */
  persona: string;
  /** `{{original}}`: the prompt a card override replaces; empty elsewhere. */
  original: string;
  clock: { now: number; timeZone: string };
  /**
   * The chat's pick seed, a uint32 made in the tab when the chat starts and
   * again on Clear: `{{pick}}` chooses by it, so one chat keeps its choices.
   */
  pickSeed: number;
  /** A number in [0, 1); injected so tests and the server choose the source. */
  random: () => number;
  /** A caller-owned working copy. Both namespaces are memory-only chat content. */
  state?: MacroState;
  /** Shares validation and expansion work with the caller's request budget. */
  workBudget?: MacroWorkBudget;
  /** Raw card metadata evaluated against a blind field context, sharing this working state. */
  resolveCardField?: (field: "description" | "personality" | "scenario" | "persona") => string;
}

/** A uint32 from the platform's CSPRNG: a chat's pick seed. */
export const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
/** Uniform in [0, 1) from the platform's CSPRNG, for `{{random}}` and `{{roll}}`. */
export const randomUniform = (): number => randomSeed() / 2 ** 32;

/**
 * A random source whose draws can be read again: after `rewind`, `random`
 * returns the draws made so far in their order, then new ones from
 * `source`. One request's attempts at the same prompt (a fit retried with
 * less memory) see the same macro values and lorebook chances. Request-local:
 * the draws go with it.
 */
export function replayableRandom(source: () => number): {
  random: () => number;
  rewind: () => void;
} {
  const draws: number[] = [];
  let next = 0;
  return {
    random: () => {
      if (next === draws.length) draws.push(source());
      const draw = draws[next] ?? source();
      next += 1;
      return draw;
    },
    rewind: () => {
      next = 0;
    },
  };
}

/** Whether `Intl` knows the zone; the boundary refuses anything else. */
export function isTimeZone(timeZone: string): boolean {
  if (timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Normalize ICU's narrow no-break space for readable AM and PM text. */
const plain = (text: string) => text.replace(/ /g, " ");

/** A `{{datetimeformat}}` format longer than this stays as written. */
export const MAX_DATE_FORMAT = 200;

/** `now` in `timeZone`, in dayjs's (moment-style) format tokens. */
function zoned(now: number, timeZone: string, format: string): string {
  // Extended here, not at import, so the module does no work until a date macro runs.
  dayjs.extend(utc);
  dayjs.extend(timezone);
  return dayjs(now).tz(timeZone).format(format);
}

/** Human elapsed time supplied by the tab; no previous user turn is “just now”. */
export function humanizeIdleDuration(elapsedMilliseconds: number | null): string {
  if (elapsedMilliseconds === null) return "just now";
  if (!Number.isFinite(elapsedMilliseconds)) throw new MacroLimitError();
  dayjs.extend(relativeTime);
  dayjs.extend(duration);
  return dayjs.duration(Math.abs(elapsedMilliseconds)).locale("en").humanize();
}

/*
 * `{{pick}}` hashes the seed, the text and the macro's position with 32-bit
 * FNV-1a: the same chat and text choose the same item every time.
 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** Folds the low `bytes` bytes of `value` into `hash`. */
function fnv(hash: number, value: number, bytes: number): number {
  let next = hash;
  for (let byte = 0; byte < bytes; byte += 1) {
    next = Math.imul(next ^ ((value >>> (8 * byte)) & 0xff), FNV_PRIME);
  }
  return next >>> 0;
}

/** The seed and the text, hashed once per substitution. */
function textHash(seed: number, text: string): number {
  let hash = fnv(FNV_OFFSET, seed, 4);
  for (let i = 0; i < text.length; i += 1) hash = fnv(hash, text.charCodeAt(i), 2);
  return hash;
}

const MAX_DICE = 100;
const MAX_SIDES = 1_000_000;
const MAX_NEWLINES = 100;
/**
 * The most text one substitution may produce: four times a block's limit.
 * Macros such as `{{description}}` repeat whole fields, so hostile text could
 * otherwise expand a few kilobytes into gigabytes.
 */
export const MAX_MACRO_OUTPUT = 4 * CARD_LIMITS.textLength;

/** Output, work or state limit exceeded; the error never carries macro content. */
export class MacroLimitError extends Error {
  override name = "MacroLimitError";
  constructor() {
    super("Macro resource limit exceeded");
  }
}

/** A foreground action's shared limit; callers must not treat it as one unexpandable field. */
export class AggregateMacroLimitError extends MacroLimitError {}

/** Deeper `{{` stays as written, so hostile text cannot exhaust the stack. */
export const MAX_MACRO_NESTING = 16;
/** Bounds repeated parsing and intermediate expansion, even when the final output is small. */
export const MAX_MACRO_WORK = 32 * MAX_MACRO_OUTPUT;
/**
 * Work units per variable each state recount spends. A recount of 511
 * variables measured about 26 ns per variable, about one and a quarter
 * parsing units (the lorebook scan reserves 21 ns per unit), so a full
 * state cannot make every substitution or card field reread free.
 */
export const MACRO_STATE_VARIABLE_WORK = 2;
/** One foreground action's budget, including intermediate JSON work and state recounts. */
export function createMacroWorkBudget(): MacroWorkBudget {
  let work = 0;
  return (units) => {
    work += units;
    if (work > MAX_MACRO_WORK) throw new AggregateMacroLimitError();
  };
}

/** `XdY+Z`, `dY`, or a bare `N` meaning `dN`; undefined when malformed or oversized. */
function roll(formula: string, random: () => number): string | undefined {
  const bare = /^(\d+)$/.exec(formula);
  const dice = bare ? ["", "1", bare[1] ?? ""] : /^(\d*)d(\d+)([+-]\d+)?$/i.exec(formula);
  if (dice === null) return undefined;
  const count = dice[1] === "" || dice[1] === undefined ? 1 : Number(dice[1]);
  const sides = Number(dice[2]);
  if (count < 1 || count > MAX_DICE || sides < 1 || sides > MAX_SIDES) return undefined;
  let total = Number(dice[3] ?? 0);
  for (let i = 0; i < count; i += 1) total += Math.floor(random() * sides) + 1;
  return String(total);
}

/** `a,b\,c` splits on unescaped commas; `a::b` on double colons. */
function choices(separator: string, argument: string): string[] {
  if (separator === "::") return argument.split("::");
  return argument.split(/(?<!\\),/).map((choice) => choice.replace(/\\,/g, ","));
}

interface Header {
  name: string;
  separator: string;
  argument: string | undefined;
  preserve: boolean;
}

function header(raw: string): Header | undefined {
  let body = raw.trim();
  const preserve = body.startsWith("#");
  if (preserve) body = body.slice(1).trimStart();
  if (body.startsWith("//")) {
    return { name: "//", separator: "", argument: body.slice(2).trim() || undefined, preserve };
  }
  const match = /^([a-z][a-z0-9_-]*)(?:\s*(::|:)\s*([\s\S]*)|\s+([\s\S]*))?$/i.exec(body);
  if (match === null) return undefined;
  return {
    name: (match[1] ?? "").toLowerCase(),
    separator: match[2] ?? (match[4] === undefined ? "" : " "),
    argument: (match[3] ?? match[4])?.trim(),
    preserve,
  };
}

/** Split only source-level separators: nested macro values cannot introduce new arguments. */
function argumentsOf(raw: string, separator: string): string[] {
  if (separator !== "::") return [raw];
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < raw.length - 1; index += 1) {
    if (raw[index] === "\\") {
      index += 1;
    } else if (raw.startsWith("{{", index)) {
      depth += 1;
      index += 1;
    } else if (raw.startsWith("}}", index)) {
      depth = Math.max(0, depth - 1);
      index += 1;
    } else if (depth === 0 && raw.startsWith("::", index)) {
      result.push(raw.slice(start, index).trim());
      index += 1;
      start = index + 1;
    }
  }
  result.push(raw.slice(start).trim());
  return result;
}

type Node =
  | { kind: "text"; value: string }
  | { kind: "macro"; raw: string; body: Sequence; at: number; closed: boolean };
interface Sequence {
  nodes: Node[];
  scopes: Map<number, number>;
}

/** Arguments already supplied by an opening tag, before its scoped last argument. */
const SCOPED_ARGUMENTS: Readonly<Record<string, number>> = {
  setvar: 1,
  setglobalvar: 1,
  setvarkey: 2,
  setvarindex: 2,
  setglobalvarkey: 2,
  setglobalvarindex: 2,
  getvarkey: 1,
  getvarindex: 1,
  getglobalvarkey: 1,
  getglobalvarindex: 1,
  addvar: 1,
  addglobalvar: 1,
  getvar: 0,
  getglobalvar: 0,
  incvar: 0,
  incglobalvar: 0,
  decvar: 0,
  decglobalvar: 0,
  hasvar: 0,
  hasglobalvar: 0,
  deletevar: 0,
  deleteglobalvar: 0,
  reverse: 0,
  roll: 0,
  datetimeformat: 0,
  newline: 0,
  space: 0,
  time: 0,
  timediff: 1,
  firstmessage: 0,
};

function pairScopes(nodes: Node[]): Map<number, number> {
  const pending = new Map<string, number[]>();
  const pairs = new Map<number, number>();
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== "macro" || !node.closed) continue;
    const close = /^\s*\/\s*([a-z][a-z0-9_-]*|\/\/)\s*$/i.exec(node.raw);
    if (close) {
      const name = (close[1] ?? "").toLowerCase();
      const opened = pending.get(name)?.pop();
      if (opened !== undefined) pairs.set(opened, index);
      continue;
    }
    const parsed = header(node.raw);
    if (!parsed) continue;
    const supplied =
      parsed.argument === undefined ? 0 : argumentsOf(parsed.argument, parsed.separator).length;
    const expected = Object.hasOwn(SCOPED_ARGUMENTS, parsed.name)
      ? SCOPED_ARGUMENTS[parsed.name]
      : undefined;
    if (
      parsed.name === "if" ||
      (parsed.name === "//" && parsed.argument === undefined) ||
      parsed.name === "random" ||
      parsed.name === "pick" ||
      expected === supplied
    ) {
      const stack = pending.get(parsed.name) ?? [];
      stack.push(index);
      pending.set(parsed.name, stack);
    }
  }
  return pairs;
}

/** ST 1.19.0's observed falsy strings; contrary to the docs, `no` is truthy. */
const truthy = (value: string | undefined) =>
  value !== undefined && !["", "false", "0", "off"].includes(value.trim().toLowerCase());

function dedent(value: string): string {
  const lines = value.split("\n");
  const first = lines.find((line) => line.trim() !== "") ?? "";
  const indentation = /^[\t ]*/.exec(first)?.[0] ?? "";
  return lines
    .map((line) => (line.startsWith(indentation) ? line.slice(indentation.length) : line))
    .join("\n")
    .trim();
}

/** Every scalar field a `{{name}}` macro reads; the record type makes the list exhaustive. */
const SCALAR_FIELDS: Record<Exclude<keyof MacroFields, "alternateGreetings">, true> = {
  characterSystemPrompt: true,
  postHistoryInstructions: true,
  characterNote: true,
  creatorNotes: true,
  characterVersion: true,
  exampleDialogue: true,
  firstMessage: true,
  lastMessage: true,
  lastMessageId: true,
  lastUserMessage: true,
  lastCharMessage: true,
  firstIncludedMessageId: true,
  firstDisplayedMessageId: true,
  lastSwipeId: true,
  currentSwipeId: true,
  allChatRange: true,
  summary: true,
  maxPrompt: true,
  maxContextTokens: true,
  maxResponseTokens: true,
  model: true,
  isMobile: true,
  lastGenerationType: true,
  idleDuration: true,
  input: true,
  systemPrompt: true,
  defaultSystemPrompt: true,
  authorsNote: true,
  reasoningPrefix: true,
  reasoningSuffix: true,
  reasoningSeparator: true,
};
const FIELD_NAMES = Object.keys(SCALAR_FIELDS) as (keyof typeof SCALAR_FIELDS)[];
const FIELD_KEYS = new Map(FIELD_NAMES.map((name) => [name.toLowerCase(), name]));
/** One evaluation owns only its counters and the caller's explicitly supplied working state. */
class Evaluation {
  private work = 0;
  private hashed: number | undefined;
  private readonly state: MacroState;
  private variables = 0;
  private total = 0;
  private readonly evaluated = new Map<number, { raw: string; value: string }>();
  private readonly source: string;
  private readonly context: MacroContext;
  private readonly limit: number;

  constructor(source: string, context: MacroContext, limit: number) {
    this.source = source;
    this.context = context;
    this.limit = limit;
    this.state = context.state ?? emptyMacroState();
    this.syncState();
  }

  /**
   * Recount the working state, which a nested field evaluation may have
   * changed. The state is a validated copy (`cloneMacroState`) that every
   * write keeps within `MACRO_STATE_LIMITS`, so this only checks the bounds
   * while it counts, and spends work for each variable it counts.
   */
  private syncState() {
    this.variables = 0;
    this.total = 0;
    for (const namespace of [this.state.local, this.state.global]) {
      for (const [name, value] of Object.entries(namespace)) {
        this.variables += 1;
        this.total += name.length + value.length;
        if (
          name.length === 0 ||
          name.length > MACRO_STATE_LIMITS.name ||
          value.length > MACRO_STATE_LIMITS.value
        )
          throw new MacroLimitError();
      }
    }
    if (this.variables > MACRO_STATE_LIMITS.variables || this.total > MACRO_STATE_LIMITS.total)
      throw new MacroLimitError();
    this.spend(this.variables * MACRO_STATE_VARIABLE_WORK);
  }

  private spend(amount: number) {
    this.context.workBudget?.(amount);
    this.work += amount;
    if (this.work > MAX_MACRO_WORK) throw new MacroLimitError();
  }

  private parse(
    text: string,
    start = 0,
    depth = 0,
    offset = 0,
  ): { sequence: Sequence; end: number; closed: boolean } {
    const nodes: Node[] = [];
    const braces = /\\[{}]|\{\{|\}\}/g;
    let index = start;
    while (index < text.length) {
      braces.lastIndex = index;
      const next = braces.exec(text);
      const end = next?.index ?? text.length;
      this.spend(end - index + 1);
      if (end > index) nodes.push({ kind: "text", value: text.slice(index, end) });
      if (!next) return { sequence: { nodes, scopes: pairScopes(nodes) }, end, closed: false };
      const token = next[0];
      if (token.startsWith("\\")) {
        nodes.push({ kind: "text", value: token.slice(1) });
        index = end + 2;
      } else if (token === "}}" && depth > 0) {
        return { sequence: { nodes, scopes: pairScopes(nodes) }, end: end + 2, closed: true };
      } else if (token === "{{" && depth < MAX_MACRO_NESTING) {
        const inner = this.parse(text, end + 2, depth + 1, offset);
        nodes.push({
          kind: "macro",
          raw: text.slice(end + 2, inner.end - (inner.closed ? 2 : 0)),
          body: inner.sequence,
          at: offset + end,
          closed: inner.closed,
        });
        index = inner.end;
      } else {
        nodes.push({ kind: "text", value: token });
        index = end + 2;
      }
    }
    return { sequence: { nodes, scopes: pairScopes(nodes) }, end: index, closed: false };
  }

  private get(namespace: Record<string, string>, name: string): string | undefined {
    return Object.hasOwn(namespace, name) ? namespace[name] : undefined;
  }

  private set(namespace: Record<string, string>, name: string, value: string): void {
    if (name === RESERVED_MACRO_NAME) return;
    const previous = this.get(namespace, name);
    const variables = this.variables + (previous === undefined ? 1 : 0);
    const total =
      this.total +
      value.length -
      (previous?.length ?? 0) +
      (previous === undefined ? name.length : 0);
    if (
      name.length === 0 ||
      name.length > MACRO_STATE_LIMITS.name ||
      value.length > MACRO_STATE_LIMITS.value ||
      variables > MACRO_STATE_LIMITS.variables ||
      total > MACRO_STATE_LIMITS.total
    )
      throw new MacroLimitError();
    Object.defineProperty(namespace, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    this.variables = variables;
    this.total = total;
  }

  private remove(namespace: Record<string, string>, name: string) {
    const previous = this.get(namespace, name);
    if (previous === undefined) return;
    delete namespace[name];
    this.variables -= 1;
    this.total -= name.length + previous.length;
  }

  private fragment(text: string, depth: number, offset: number): string {
    if (depth > MAX_MACRO_NESTING) return text;
    return this.render(this.parse(text, 0, depth, offset).sequence, depth);
  }

  private numeric(value: string): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  private add(previous: string, value: string): string {
    const left = this.numeric(previous);
    const right = this.numeric(value);
    return left === undefined || right === undefined ? previous + value : String(left + right);
  }

  /** Validate JSON depth/array lengths iteratively before recursive serialization. */
  private boundedJson(value: unknown): void {
    const pending = [{ value, depth: 0 }];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || typeof current.value !== "object" || current.value === null)
        continue;
      if (
        current.depth > MACRO_STATE_LIMITS.jsonDepth ||
        (Array.isArray(current.value) && current.value.length > MACRO_STATE_LIMITS.indexedArray)
      )
        throw new MacroLimitError();
      this.spend(1);
      for (const child of Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  private indexed(
    namespace: Record<string, string>,
    name: string,
    key: string,
    value?: string,
  ): string {
    if (
      name.length === 0 ||
      name.length > MACRO_STATE_LIMITS.name ||
      key.length > MACRO_STATE_LIMITS.name ||
      (value !== undefined && value.length > MACRO_STATE_LIMITS.value)
    )
      throw new MacroLimitError();
    const previous = this.get(namespace, name);
    let parsed: unknown;
    if (previous !== undefined) {
      this.spend(previous.length + 1);
      try {
        parsed = JSON.parse(previous) as unknown;
      } catch {
        return value === undefined ? previous : "";
      }
      if (typeof parsed !== "object" || parsed === null) return value === undefined ? previous : "";
    } else if (value === undefined) return "";
    else parsed = Number.isNaN(Number(key)) ? (Object.create(null) as Record<string, unknown>) : [];
    if (typeof parsed !== "object" || parsed === null) return "";
    this.boundedJson(parsed);
    // Numeric keys are normalized, including blank -> 0 and 01 -> 1.
    const number = Number(key);
    const property = Number.isNaN(number) ? key : String(number);
    if (value === undefined) {
      if (!Object.hasOwn(parsed, property)) return "";
      const found: unknown = (parsed as Record<string, unknown>)[property];
      if (typeof found === "object" && found !== null) {
        const result = JSON.stringify(found);
        this.spend(result.length + 1);
        return result;
      }
      return String(found);
    }
    if (Array.isArray(parsed)) {
      if (
        !Number.isNaN(number) &&
        (!Number.isFinite(number) || number >= MACRO_STATE_LIMITS.indexedArray)
      )
        throw new MacroLimitError();
      if (property === "length") {
        const length = Number(value);
        if (!Number.isInteger(length) || length < 0 || length > MACRO_STATE_LIMITS.indexedArray)
          throw new MacroLimitError();
        parsed.length = length;
      } else
        Object.defineProperty(parsed, property, {
          value,
          configurable: true,
          enumerable: true,
          writable: true,
        });
    } else
      Object.defineProperty(parsed, property, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    const result = JSON.stringify(parsed);
    this.spend(result.length + 1);
    this.set(namespace, name, result);
    return "";
  }

  private shorthand(raw: string, depth: number, offset: number): string | undefined {
    const match =
      /^([.$])([a-z](?:[a-z0-9_-]*[a-z0-9])?)\s*(?:(\|\|=|\?\?=|\|\||\?\?|\+\+|--|\+=|-=|==|!=|>=|<=|=|>|<)\s*([\s\S]*))?$/i.exec(
        raw.trim(),
      );
    if (!match) return undefined;
    const namespace = match[1] === "$" ? this.state.global : this.state.local;
    const name = match[2] ?? "";
    const previous = this.get(namespace, name);
    const operator = match[3];
    if (operator === undefined) return previous ?? "";
    if ((operator === "||" || operator === "||=") && truthy(previous)) return previous ?? "";
    if ((operator === "??" || operator === "??=") && previous !== undefined) return previous;
    const value = this.fragment((match[4] ?? "").trim(), depth + 1, offset);
    switch (operator) {
      case "||":
      case "??":
        return value;
      case "||=":
      case "??=":
        this.set(namespace, name, value);
        return value;
      case "=":
        this.set(namespace, name, value);
        return "";
      case "++":
      case "--": {
        if (value !== "") return undefined;
        const next = String((this.numeric(previous ?? "") ?? 0) + (operator === "++" ? 1 : -1));
        this.set(namespace, name, next);
        return next;
      }
      case "+=":
        this.set(namespace, name, this.add(previous ?? "", value));
        return "";
      case "-=": {
        const left = this.numeric(previous ?? "");
        const right = this.numeric(value);
        if (left !== undefined && right !== undefined)
          this.set(namespace, name, String(left - right));
        return "";
      }
      case "==":
        return String((previous ?? "") === value);
      case "!=":
        return String((previous ?? "") !== value);
      case ">":
        return String(Number(previous ?? "") > Number(value));
      case ">=":
        return String(Number(previous ?? "") >= Number(value));
      case "<":
        return String(Number(previous ?? "") < Number(value));
      case "<=":
        return String(Number(previous ?? "") <= Number(value));
      default:
        return undefined;
    }
  }

  private condition(raw: string, depth: number, offset: number): boolean {
    let condition = raw.trim();
    const inverted = condition.startsWith("!");
    if (inverted) condition = condition.slice(1).trimStart();
    const value =
      this.shorthand(condition, depth, offset) ??
      this.simple(condition.toLowerCase()) ??
      this.fragment(condition, depth + 1, offset);
    return inverted ? !truthy(value) : truthy(value);
  }

  private simple(name: string): string | undefined {
    const { timeZone, now } = this.context.clock;
    switch (name) {
      case "char":
      case "user":
        return this.context[name];
      case "description":
      case "personality":
      case "scenario":
      case "persona":
        if (this.context.resolveCardField === undefined) return this.context[name];
        {
          const value = this.context.resolveCardField(name);
          this.syncState();
          return value;
        }
      case "original":
        return this.context[name];
      case "time":
        return plain(
          new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(
            now,
          ),
        );
      case "date":
        return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone }).format(now);
      case "weekday":
        return zoned(now, timeZone, "dddd");
      case "isotime":
        return zoned(now, timeZone, "HH:mm");
      case "isodate":
        return zoned(now, timeZone, "YYYY-MM-DD");
      case "newline":
        return "\n";
      case "space":
        return " ";
      case "noop":
      case "trim":
        return "";
      default: {
        const key = FIELD_KEYS.get(name);
        if (key !== undefined)
          return String(this.context[key] ?? (key === "isMobile" ? false : ""));
        return undefined;
      }
    }
  }

  private evaluate(
    node: Extract<Node, { kind: "macro" }>,
    parsed: Header,
    depth: number,
    scoped?: string,
  ): string | undefined {
    const { name, separator, argument } = parsed;
    if (name === "//") return "";
    const variable = /^(get|set|add|inc|dec|has|delete)(global)?var$/.exec(name);
    const indexed = /^(get|set)(global)?var(?:key|index)$/.exec(name);
    if (
      argument !== undefined &&
      !variable &&
      !indexed &&
      ![
        "random",
        "pick",
        "datetimeformat",
        "roll",
        "reverse",
        "newline",
        "space",
        "firstmessage",
        "time",
        "timediff",
      ].includes(name)
    )
      return undefined;
    let cursor = 0;
    const argumentAt = node.at + 2 + (argument === undefined ? 0 : node.raw.lastIndexOf(argument));
    const args =
      argument === undefined
        ? []
        : argumentsOf(argument, separator).map((value) => {
            const start = argument.indexOf(value, cursor);
            cursor = start + value.length;
            return this.fragment(value, depth + 1, argumentAt + start);
          });
    if (scoped !== undefined) args.push(scoped);
    if (args.length === 0) return this.simple(name);
    const first = args[0] ?? "";
    const second = args[1] ?? "";
    if (indexed) {
      if (args.length !== (indexed[1] === "get" ? 2 : 3)) return undefined;
      return this.indexed(
        indexed[2] ? this.state.global : this.state.local,
        first,
        second,
        indexed[1] === "get" ? undefined : (args[2] ?? ""),
      );
    }
    if (variable) {
      const namespace = variable[2] ? this.state.global : this.state.local;
      const previous = this.get(namespace, first);
      switch (variable[1]) {
        case "get":
          return args.length === 1 ? (previous ?? "") : undefined;
        case "has":
          return args.length === 1 ? String(previous !== undefined) : undefined;
        case "delete":
          if (args.length !== 1) return undefined;
          this.remove(namespace, first);
          return "";
        case "set":
          if (args.length !== 2) return undefined;
          this.set(namespace, first, second);
          return "";
        case "add":
          if (args.length !== 2) return undefined;
          this.set(namespace, first, this.add(previous ?? "", second));
          return "";
        case "inc":
        case "dec": {
          if (args.length !== 1) return undefined;
          const next = String(
            (this.numeric(previous ?? "") ?? 0) + (variable[1] === "inc" ? 1 : -1),
          );
          this.set(namespace, first, next);
          return next;
        }
      }
    }
    const { timeZone, now } = this.context.clock;
    switch (name) {
      case "random":
      case "pick": {
        const list = separator === "::" || scoped !== undefined ? args : choices(separator, first);
        if (name === "random")
          return (
            list[Math.min(list.length - 1, Math.floor(this.context.random() * list.length))] ?? ""
          );
        this.hashed ??= textHash(this.context.pickSeed, this.source);
        return list[fnv(this.hashed, node.at, 4) % list.length] ?? "";
      }
      case "time": {
        if (args.length !== 1) return undefined;
        const offset = /^UTC([+-]\d+)$/.exec(first);
        const offsetValue = Number(offset?.[1]);
        if (offset === null || !Number.isFinite(offsetValue) || Math.abs(offsetValue) > 1_440)
          return this.simple("time");
        dayjs.extend(utc);
        // Offsets below 16 are hours; Day.js utcOffset uses <=16.
        const minutes = Math.abs(offsetValue) < 16 ? offsetValue * 60 : offsetValue;
        return dayjs.utc(now).add(minutes, "minute").locale("en").format("h:mm A");
      }
      case "timediff": {
        if (args.length !== 2) return undefined;
        dayjs.extend(relativeTime);
        dayjs.extend(utc);
        dayjs.extend(timezone);
        // Offset-bearing dates denote instants. Naive dates are wall clocks in
        // the caller's browser zone, which may differ from the server's zone.
        const parse = (text: string) =>
          /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? dayjs(text) : dayjs.tz(text, timeZone);
        try {
          const left = parse(first);
          const right = parse(second);
          return left.isValid() && right.isValid() ? left.locale("en").from(right) : "Invalid date";
        } catch {
          return "Invalid date";
        }
      }
      case "datetimeformat":
        return args.length === 1 && first.length <= MAX_DATE_FORMAT
          ? zoned(now, timeZone, first)
          : undefined;
      case "roll":
        return args.length === 1 ? roll(first, this.context.random) : undefined;
      case "reverse":
        return args.length === 1 ? Array.from(first).reverse().join("") : undefined;
      case "newline":
      case "space": {
        const count = Number(first);
        return args.length === 1 && Number.isInteger(count) && count >= 0 && count <= MAX_NEWLINES
          ? (name === "newline" ? "\n" : " ").repeat(count)
          : undefined;
      }
      case "firstmessage": {
        const index = Number(first);
        if (args.length !== 1 || !Number.isInteger(index) || index < 0) return undefined;
        return index === 0
          ? (this.context.firstMessage ?? "")
          : (this.context.alternateGreetings?.[index - 1] ?? "");
      }
      default:
        return undefined;
    }
  }

  private render(
    sequence: Sequence,
    depth: number,
    start = 0,
    end = sequence.nodes.length,
  ): string {
    let output = "";
    let trimNext = false;
    const append = (piece: string) => {
      const kept = trimNext ? piece.replace(/^\n+/, "") : piece;
      this.spend(piece.length + 1);
      if (output.length + kept.length > this.limit) throw new MacroLimitError();
      output += kept;
      if (piece !== "") trimNext = trimNext && kept === "";
    };
    for (let index = start; index < end; index += 1) {
      const node = sequence.nodes[index];
      if (!node) continue;
      if (node.kind === "text") {
        append(node.value);
        continue;
      }
      if (depth >= MAX_MACRO_NESTING) {
        append(`{{${node.raw}${node.closed ? "}}" : ""}`);
        continue;
      }
      if (!node.closed) {
        append(`{{${this.render(node.body, depth + 1)}`);
        continue;
      }
      const parsed = header(node.raw);
      const closing = sequence.scopes.get(index);
      const cached = this.evaluated.get(node.at);
      if (closing === undefined && parsed?.name !== "trim" && cached?.raw === node.raw) {
        append(cached.value);
        continue;
      }
      let value: string | undefined;
      if (parsed && closing !== undefined && closing < end) {
        if (parsed.name === "if") {
          let alternative = closing;
          for (let cursor = index + 1; cursor < closing; cursor += 1) {
            const nestedClose = sequence.scopes.get(cursor);
            if (nestedClose !== undefined) {
              cursor = nestedClose;
              continue;
            }
            const candidate = sequence.nodes[cursor];
            if (candidate?.kind === "macro" && /^\s*else\s*$/i.test(candidate.raw)) {
              alternative = cursor;
              break;
            }
          }
          const selected = this.condition(parsed.argument ?? "", depth, node.at);
          value = selected
            ? this.render(sequence, depth + 1, index + 1, alternative)
            : alternative < closing
              ? this.render(sequence, depth + 1, alternative + 1, closing)
              : "";
          if (!parsed.preserve) value = dedent(value);
        } else {
          const content = this.render(sequence, depth + 1, index + 1, closing);
          value = this.evaluate(node, parsed, depth, parsed.preserve ? content : dedent(content));
        }
        index = closing;
      } else {
        value = this.shorthand(node.raw.replace(/^\s*#\s*/, ""), depth, node.at);
        if (value === undefined && parsed) {
          // Inline comments, like scoped comments, process nested expressions
          // before removing their own output.
          if (parsed.name === "//") this.render(node.body, depth + 1);
          value = this.evaluate(node, parsed, depth);
        }
      }
      if (value === undefined) value = `{{${this.render(node.body, depth + 1)}}}`;
      if (closing === undefined && parsed?.name !== "trim")
        this.evaluated.set(node.at, { raw: node.raw, value });
      if (parsed?.name === "trim" && parsed.argument === undefined && closing === undefined) {
        let kept = output.length;
        while (kept > 0 && output.charCodeAt(kept - 1) === 10) kept -= 1;
        output = output.slice(0, kept);
        trimNext = true;
      } else append(value);
    }
    return output;
  }

  run(): string {
    return this.render(this.parse(this.source).sequence, 0);
  }
}

/**
 * Replaces known macros with bounded plain text. Explicit `context.state` is
 * a mutable working copy; omitted state is fresh for this call. Clone a tab's
 * state before previews and commit generation state only after acceptance.
 */
export function substituteMacros(
  text: string,
  context: MacroContext,
  limit: number = MAX_MACRO_OUTPUT,
): string {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_MACRO_OUTPUT)
    throw new MacroLimitError();
  return new Evaluation(text, context, limit).run();
}
