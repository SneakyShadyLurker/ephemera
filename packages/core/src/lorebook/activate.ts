import type { RE2JS } from "re2js";
import { CARD_LIMITS, textLength } from "../card/limits.ts";
import type { LorebookEntry } from "../card/schema.ts";
import { type ChatTurn, type SpeakerNames, scanTextOf, speakerOf } from "../chat.ts";
import { withoutHighlights } from "../preset/highlight.ts";
import type { PromptRole } from "../preset/prompt.ts";
import type { LorebookReport } from "../prompt/inspect.ts";
import {
  AggregateMacroLimitError,
  MAX_MACRO_OUTPUT,
  MacroLimitError,
  type MacroWorkBudget,
} from "../prompt/macros.ts";
import type { CombinedLorebooks } from "./combine.ts";
import {
  compileCost,
  compilePattern,
  EXHAUSTED,
  type KeyMatch,
  type KeyProblem,
  matchPattern,
  matchPlain,
  parseKey,
  ScannedMessage,
  WorkMeter,
} from "./keys.ts";
import { EventPools } from "./pools.ts";
import {
  clip,
  entryTitle,
  insertionOrder,
  LOREBOOK_RULES,
  LOREBOOK_STATUSES,
  type LorebookStatus,
} from "./rules.ts";
import { type EntryLogic, type EntrySettings, entrySettings } from "./settings.ts";
import { applyTimed, type LorebookState, nextState, type TimedIdentity } from "./timed.ts";

/*
 * Which entries of a character's lorebooks one request sends
 * (ARCHITECTURE.md § Generation flow). The result is chat content: it lives in this request and
 * in the tab's inspector, nowhere else.
 */

/** What an activation needs besides its books. */
interface ActivationRequest {
  /** The request's turns, oldest first; each is scanned as `${name}: ${content}`. */
  turns: Pick<ChatTurn, "role" | "content" | "name" | "scanText">[];
  names: SpeakerNames;
  /** Fills macros; throws MacroLimitError past `limit`, sharing the supplied work budget. */
  macros: (text: string, limit?: number, workBudget?: MacroWorkBudget) => string;
  /** Tokens of one entry's text (the server's calibrated estimate). */
  count: (text: string) => number;
  /** Tokens the sent entries' texts may use; for several books, `combinedBudget`. */
  budget: number;
  /**
   * Whether this request sends each placement's host: the preset's two
   * lorebook blocks, its example dialogue block, and the Author's Note (due
   * by its frequency, whatever its text), and its chat history. Absent
   * `history` keeps standalone activation callers' existing depth behavior.
   */
  blocks: {
    before: boolean;
    after: boolean;
    examples: boolean;
    authorsNote: boolean;
    history?: boolean;
  };
  /** The chat's timed state and how to read it; without it no sticky or cooldown effect applies. */
  timed?: TimedIdentity | null;
  /** Turns before `turns` folded into a memory: delay counts them (timed.ts). */
  folded?: number;
  /**
   * Uniform in [0, 1): the request's random source (the CSPRNG in
   * production), drawn once for each entry with a trigger chance that would
   * otherwise activate, and never for any other; and once for each event
   * pool more than one entry contends for in a pass, unless one is prioritized.
   */
  random: () => number;
}

/** A character's books together (combine.ts), each entry with its book's context. */
export interface CombinedActivationInput extends ActivationRequest {
  books: CombinedLorebooks;
}

export interface SentEntry {
  /** The entry's index in the combined list (for one book, its index in the book). */
  index: number;
  content: string;
}

/** Entries placed in the chat at one depth with one role. */
interface DepthGroup {
  depth: number;
  role: PromptRole;
  entries: SentEntry[];
}

/** Activated entry texts grouped by native placement and insertion order, for prompt assembly. */
export interface LorebookActivation {
  before: SentEntry[];
  after: SentEntry[];
  /** Deeper first, then by role code; assembly orders the messages itself. */
  depth: DepthGroup[];
  /** Around the Author's Note's text: above it and below it. */
  authorsNote: { top: SentEntry[]; bottom: SentEntry[] };
  /** Before and after the card's example dialogue. */
  examples: { before: SentEntry[]; after: SentEntry[] };
  /**
   * Resolves provisional activations against entry text actually delivered by
   * assembly and fitting: the timed state the next request carries (null
   * without a timed identity) and the report.
   */
  finalize: (
    sent: ReadonlySet<number>,
    rendered?: ReadonlySet<number>,
  ) => {
    state: LorebookState | null;
    report: LorebookReport;
  };
}

type ReportEntry = LorebookReport["entries"][number];
type Reason = NonNullable<ReportEntry["reason"]>;
type KeyReason = Pick<Extract<Reason, { kind: "key" }>, "key" | "matched">;
/** A reason an entry would go in by, the roll still to come. */
type RolledReason = Exclude<Reason, { kind: "sticky" }>;
type ReportedProblem = LorebookReport["keyProblems"][number]["problem"];
type PoolLoss = NonNullable<ReportEntry["pool"]>;

/** Statuses no later pass changes. */
const FINAL_STATUSES: ReadonlySet<LorebookStatus> = new Set([
  "off",
  "cooldown",
  "delayed",
  "chanceMissed",
  "poolLost",
]);
/** Statuses of entries that reached the budget fit. */
const FIT_STATUSES: ReadonlySet<LorebookStatus> = new Set(["sent", "doesNotFit", "afterCutoff"]);

interface Outcome {
  status: LorebookStatus;
  reason?: Reason;
  /** The pass that activated the entry: 0 for the chat, then one per recursive pass. */
  pass?: number;
  tokens?: number;
  content?: string;
  /** Messages left on cooldown. */
  left?: number;
  /** The chat length a delayed entry waits for. */
  until?: number;
  /** The event pool that dropped it (`poolLost`). */
  pool?: PoolLoss;
}

/** An entry a pass activates, before its pools are resolved and its chance rolled. */
interface Candidate {
  index: number;
  reason: RolledReason;
}

/** Keys of one entry made ready to match: macros filled, parsed, patterns compiled. */
type ReadyKey =
  | { key: string; kind: "plain"; text: string }
  | { key: string; kind: "pattern"; pattern: RE2JS };

const costs = LOREBOOK_RULES.scanCosts;

/** Keys prepared for matching, and those that can never match (reported as key problems). */
interface PreparedKeys {
  ready: ReadyKey[];
  refused: string[];
}

/** Where a key matched: its text, and the entry whose text it was (null for the chat). */
interface Found {
  matched: string;
  from: number | null;
}

/**
 * The secondary keys' verdict. When they applied and passed, `decided` lists
 * the keys that decided it: the matched ones for AND logics, the absent ones
 * (`matched` empty, `from` null) for NOT logics.
 */
interface SecondaryOutcome {
  pass: boolean;
  decided?: (KeyReason & { from: number | null })[];
}

/**
 * What one key has been tested against so far, so that across all passes
 * each key meets each text once: the chat (untested, no match or the
 * match), how many recursed texts, and the first recursed text it matched.
 */
interface KeyMemo {
  chat?: string | null;
  tested: number;
  hit?: { at: number; matched: string };
}

/** One entry's keys made ready, with what each has been tested against. */
interface EntryScan {
  primary: ReadyKey[];
  secondary: PreparedKeys;
  memos: Map<ReadyKey, KeyMemo>;
  /** Whether its key problems have been reported. */
  reported: boolean;
  problems: { key: string; problem: ReportedProblem }[];
}

/** An activated entry's text scanned in later passes, and the entry it came from. */
interface RecursedText {
  message: ScannedMessage;
  from: number;
}

/**
 * Scans messages for entry keys within one work bound, caching compiled
 * patterns. Each message is prepared once (its lowercase form and word
 * boundaries); an entry scans the last `depth` of them.
 */
class Scan {
  readonly meter = new WorkMeter(LOREBOOK_RULES.scanWork);
  private readonly entryMacroMeter = new WorkMeter(LOREBOOK_RULES.scanWork);
  private readonly patterns = new Map<string, RE2JS | KeyProblem>();

  readonly messages: ScannedMessage[];
  private readonly macros: ActivationRequest["macros"];
  readonly macroWork: MacroWorkBudget = (units) => {
    if (!this.meter.charge(units * costs.macroEvaluation)) throw new MacroLimitError();
  };
  readonly entryMacroWork: MacroWorkBudget = (units) => {
    if (!this.entryMacroMeter.charge(units * costs.macroEvaluation)) {
      this.meter.exhausted = true;
      throw new MacroLimitError();
    }
  };

  get macroExhausted(): boolean {
    return this.entryMacroMeter.exhausted;
  }

  constructor(messages: ScannedMessage[], macros: ActivationRequest["macros"]) {
    this.messages = messages;
    this.macros = macros;
  }

  /** Fills, parses and compiles keys; null when the work runs out. */
  prepare(
    keys: readonly string[],
    useRegex: boolean,
    problems: { key: string; problem: ReportedProblem }[],
  ): PreparedKeys | null {
    const ready: ReadyKey[] = [];
    const refused: string[] = [];
    const refuse = (key: string, problem: ReportedProblem) => {
      problems.push({ key, problem });
      refused.push(key);
    };
    for (const key of keys) {
      if (key.trim() === "") continue;
      if (!this.meter.charge(costs.key + key.length)) return null;
      const filled = this.fill(key);
      if (this.meter.exhausted) return null;
      if (filled === null) {
        refuse(key, "tooLong");
        continue;
      }
      const parsed = parseKey(filled, useRegex);
      if (parsed.kind === "blank") continue;
      if (parsed.kind === "plain") {
        ready.push({ key, kind: "plain", text: parsed.text });
      } else {
        const compiled = this.compile(parsed.source, parsed.flags);
        if (compiled === null) return null;
        if (typeof compiled === "string") refuse(key, compiled);
        else ready.push({ key, kind: "pattern", pattern: compiled });
      }
    }
    return { ready, refused };
  }

  /**
   * **Decided:** macros in keys, bounded to the key length limit. The macro
   * bound counts UTF-16 units and the limit code points, at most two units each.
   */
  private fill(key: string): string | null {
    try {
      const filled = this.macros(key, 2 * CARD_LIMITS.shortTextLength, this.macroWork);
      const limit = CARD_LIMITS.shortTextLength;
      return filled.length > limit && textLength(filled) > limit ? null : filled;
    } catch (error) {
      if (error instanceof AggregateMacroLimitError) throw error;
      if (error instanceof MacroLimitError) return null;
      throw error;
    }
  }

  private compile(source: string, flags: number): RE2JS | KeyProblem | null {
    const id = `${flags}/${source}`;
    const known = this.patterns.get(id);
    if (known !== undefined) return known;
    const compiled = compilePattern(source, flags);
    if (!this.meter.charge(compileCost(compiled))) return null;
    this.patterns.set(id, compiled);
    return compiled;
  }

  /**
   * **Decided**: the texts of entries activated so
   * far whose "prevent further recursion" is off, each its own message, in
   * scope whatever an entry's scan depth.
   */
  readonly texts: RecursedText[] = [];

  /**
   * Charges one visit to a key or one reason built, cached outcomes included:
   * every recursive pass repeats them, so each counts against the bound.
   */
  private step(): boolean {
    return this.meter.charge(costs.visit);
  }

  /** One key against one message using the entry's effective case and whole-word settings. */
  private test(ready: ReadyKey, settings: EntrySettings, message: ScannedMessage): KeyMatch {
    const modes = {
      caseSensitive: settings.effectiveCaseSensitive,
      wholeWords: settings.effectiveWholeWords,
    };
    return ready.kind === "plain"
      ? matchPlain(ready.text, modes, message, this.meter)
      : matchPattern(ready.pattern, message, this.meter);
  }

  /**
   * Where one key matches: the entry's last `depth` chat messages first,
   * then the first `scope` recursed texts in order. Every outcome is kept
   * in `memo`, so no key is tested against a text twice; each visit is still
   * charged.
   */
  private locate(
    ready: ReadyKey,
    memo: KeyMemo,
    settings: EntrySettings,
    depth: number,
    scope: number,
  ): Found | null | typeof EXHAUSTED {
    if (!this.step()) return EXHAUSTED;
    if (memo.chat === undefined) {
      let found: KeyMatch = null;
      for (let i = Math.max(0, this.messages.length - depth); i < this.messages.length; i += 1) {
        const message = this.messages[i];
        if (message === undefined) continue;
        found = this.test(ready, settings, message);
        if (found !== null) break;
      }
      if (found === EXHAUSTED) return EXHAUSTED;
      memo.chat = found;
    }
    if (memo.chat !== null) return { matched: memo.chat, from: null };
    while (memo.hit === undefined && memo.tested < scope) {
      const text = this.texts[memo.tested];
      if (text === undefined) break;
      const found = this.test(ready, settings, text.message);
      if (found === EXHAUSTED) return EXHAUSTED;
      if (found !== null) memo.hit = { at: memo.tested, matched: found };
      memo.tested += 1;
    }
    const hit = memo.hit;
    if (hit === undefined || hit.at >= scope) return null;
    return { matched: hit.matched, from: this.texts[hit.at]?.from ?? null };
  }

  /**
   * The first key, in key order, that matches the chat; else the first
   * that matches a recursed text within `scope`: the chat wins the reason.
   */
  match(
    entry: EntryScan,
    settings: EntrySettings,
    depth: number,
    scope: number,
  ): (KeyReason & { from: number | null }) | null | typeof EXHAUSTED {
    for (const within of scope === 0 ? [0] : [0, scope]) {
      for (const ready of entry.primary) {
        const found = this.locate(ready, memoOf(entry, ready), settings, depth, within);
        if (found === EXHAUSTED) return EXHAUSTED;
        if (found === null) continue;
        if (!this.step()) return EXHAUSTED;
        return { key: clip(ready.key), ...found };
      }
    }
    return null;
  }

  /** Secondary logic scans the chat and first scope recursed texts only as far as the verdict requires. Unmatchable keys count as present and unmatched; empty lists impose no filter. */
  secondary(
    logic: EntryLogic,
    entry: EntryScan,
    settings: EntrySettings,
    depth: number,
    scope: number,
  ): SecondaryOutcome | typeof EXHAUSTED {
    const keys = entry.secondary;
    if (keys.ready.length + keys.refused.length === 0) return { pass: true };
    const absent = (key: string) => ({ key: clip(key), matched: "", from: null });
    // NOT ALL passes and AND ALL fails as soon as one key is missing.
    const [refused] = keys.refused;
    if (refused !== undefined && logic === "notAll") {
      if (!this.step()) return EXHAUSTED;
      return { pass: true, decided: [absent(refused)] };
    }
    if (refused !== undefined && logic === "andAll") return { pass: false };
    const decided: (KeyReason & { from: number | null })[] = [];
    for (const ready of keys.ready) {
      const found = this.locate(ready, memoOf(entry, ready), settings, depth, scope);
      if (found === EXHAUSTED) return EXHAUSTED;
      if (found === null) {
        if (logic === "andAll") return { pass: false };
        if (logic === "andAny") continue;
        if (!this.step()) return EXHAUSTED;
        if (logic === "notAll") return { pass: true, decided: [absent(ready.key)] };
        decided.push(absent(ready.key));
        continue;
      }
      if (logic === "notAny") return { pass: false };
      if (!this.step()) return EXHAUSTED;
      const reason = { key: clip(ready.key), ...found };
      if (logic === "andAny") return { pass: true, decided: [reason] };
      decided.push(reason);
    }
    switch (logic) {
      case "andAny":
        return { pass: false };
      case "andAll":
        return { pass: true, decided };
      case "notAny":
        // Refused keys never match, so they are absent too.
        if (!this.meter.charge(keys.refused.length * costs.visit)) return EXHAUSTED;
        return { pass: true, decided: [...decided, ...keys.refused.map(absent)] };
      case "notAll":
        return { pass: false };
    }
  }
}

function memoOf(entry: EntryScan, ready: ReadyKey): KeyMemo {
  let memo = entry.memos.get(ready);
  if (memo === undefined) {
    memo = { tested: 0 };
    entry.memos.set(ready, memo);
  }
  return memo;
}

/** **Decided:** macros filled, leading decorators stripped; null when too long. */
function entryContent(
  entry: LorebookEntry,
  macros: ActivationRequest["macros"],
  limit: number,
  workBudget: MacroWorkBudget,
): string | null {
  try {
    return macros(entry.content, limit, workBudget);
  } catch (error) {
    if (error instanceof AggregateMacroLimitError) throw error;
    if (error instanceof MacroLimitError) return null;
    throw error;
  }
}

/** The deepest requested history suffix is scanned as speaker-attributed text without highlights. Each entry reads its own depth. Preset notes are not scan input. */
function scannedMessages(input: ActivationRequest, depth: number): ScannedMessage[] {
  const turns = depth === 0 ? [] : input.turns.slice(-depth);
  return turns.map(
    (turn) => new ScannedMessage(`${speakerOf(turn, input.names)}: ${scanTextOf(turn)}`),
  );
}

/** A whole number of messages, never negative. */
const messageCount = (value: number) => Math.max(0, Math.trunc(value));

/** Secondary keys apply unless selective is false; an empty list imposes no filter. */
export const usesSecondary = (entry: LorebookEntry, settings: EntrySettings) =>
  entry.selective !== false && settings.secondaryKeys.some((key) => key.trim() !== "");

/** A candidate draws once for an enabled trigger chance. A lost roll is final for the request and starts no recursion, budget use or timed effect. */
function rolled(
  reason: RolledReason,
  settings: EntrySettings,
  random: ActivationRequest["random"],
  pass: number,
): Outcome {
  const { chance } = settings;
  if (chance === null) return { status: "sent", reason, pass };
  const withChance: RolledReason = { ...reason, chance };
  return random() * 100 < chance
    ? { status: "sent", reason: withChance, pass }
    : { status: "chanceMissed", reason: withChance };
}

/**
 * Activates a character's books together for one request. Entries take part
 * in combined order up to `LOREBOOK_RULES.combinedEntries`; the rest are
 * reported unscanned. Insertion order, the fit and placement read the
 * combined list as one book; scan depth and chaining are each entry's book's.
 */
export function activateLorebooks(input: CombinedActivationInput): LorebookActivation {
  const { books } = input;
  const all = books.entries;
  const entries = all.map((at) => at.entry);
  const settings = entries.map(entrySettings);
  const taking = Math.min(all.length, LOREBOOK_RULES.combinedEntries);
  const depthOf = (index: number) =>
    settings[index]?.scanDepth ?? messageCount(all[index]?.scanDepth ?? 0);
  const bookDepth = messageCount(books.scanDepth);
  let deepest = bookDepth;
  for (let index = 0; index < taking; index += 1) deepest = Math.max(deepest, depthOf(index));
  const scan = new Scan(scannedMessages(input, deepest), input.macros);
  const outcomes: Outcome[] = [];
  const keyProblems: LorebookReport["keyProblems"] = [];
  const scans = new Map<number, EntryScan>();
  const problem = (index: number) => (key: string, found: ReportedProblem) => {
    if (keyProblems.length < LOREBOOK_RULES.reportKeyProblems) {
      keyProblems.push({ index, key: clip(key), problem: found });
    }
  };

  // Timed effects first (timed.ts): the length is the request's history, greeting included.
  const length = input.turns.length;
  const identity = input.timed ?? null;
  const timed = applyTimed(
    all.slice(0, taking),
    settings.slice(0, taking),
    length,
    identity,
    input.folded ?? 0,
  );

  const pools = new EventPools(settings, entries, input.random);
  // Always-on entries the first pass activates; they are rolled before its keyword matches.
  const first: Candidate[] = [];

  // Entries no pass evaluates; "sent" marks an activated entry until the fit.
  for (const [index, entry] of entries.entries()) {
    const entrySetting = settings[index];
    if (entrySetting === undefined) continue;
    if (index >= taking) {
      outcomes.push({ status: "unscanned" });
      continue;
    }
    const standing = timed.standings[index];
    if (standing === undefined) continue;
    if (!entry.enabled) outcomes.push({ status: "off" });
    // A sticky entry is activated without its keys, in the first pass, so its text may recurse.
    else if (standing.kind === "sticky") {
      const spared = entrySetting.chance === null ? {} : { chance: entrySetting.chance };
      outcomes.push({
        status: "sent",
        reason: { kind: "sticky", left: standing.left, ...spared },
        pass: 0,
      });
      // Held sticky, it is no candidate in its pools: it holds them.
      pools.hold(index);
    } else if (standing.kind === "cooldown") {
      outcomes.push({ status: "cooldown", left: standing.left });
    } else if (standing.kind === "delayed") {
      outcomes.push({ status: "delayed", until: standing.until });
    } else if (entrySetting.recursiveOnly !== false) {
      // Only a recursive pass evaluates it; this stays its status until one does.
      outcomes.push({ status: "chainOnly" });
    } else {
      outcomes.push({ status: "notMatched" });
      if (entry.constant === true) first.push({ index, reason: { kind: "constant" } });
    }
  }

  /** Recursive books evaluate remaining entries against chat and fitted chaining text. Excluded entries run only in the first pass; delayed entries start in a recursive pass. Scanning stops when nothing activates, budget runs out or the work bound is spent. */
  const chains = (index: number) => all[index]?.chains === true;
  const recursive = all.slice(0, taking).some((at) => at.chains);
  const fit = new Fit(input, entries, settings, outcomes, scan);
  let passes = 0;
  for (let pass = 0; ; pass += 1) {
    passes = pass + 1;
    const scope = scan.texts.length;
    const activated: number[] = [];
    const candidates: Candidate[] = pass === 0 ? [...first] : [];
    for (let index = 0; index < taking; index += 1) {
      const entry = entries[index];
      const outcome = outcomes[index];
      const entrySetting = settings[index];
      if (entry === undefined || outcome === undefined || entrySetting === undefined) continue;
      if (outcome.pass !== undefined) {
        if (pass === 0) activated.push(index);
        continue;
      }
      if (FINAL_STATUSES.has(outcome.status)) continue;
      const delayed = entrySetting.recursiveOnly !== false;
      if (pass === 0 ? delayed : entrySetting.excludeRecursion || !chains(index)) continue;
      // The first pass's always-on entries are candidates already.
      if (pass === 0 && entry.constant === true) continue;
      // Every evaluation counts, keyless entries included, so passes stay within the bound.
      if (!scan.meter.charge(LOREBOOK_RULES.scanCosts.check)) {
        outcome.status = "unscanned";
        continue;
      }
      // **Decided:** an always-on entry delayed until recursion goes in, without keys, in the
      /** Always-on delayed entries become candidates in a recursive pass. */
      if (entry.constant === true) {
        candidates.push({ index, reason: { kind: "constant" } });
        continue;
      }
      let prepared = scans.get(index);
      if (prepared === undefined) {
        const ready = prepare(scan, entry, entrySetting);
        if (ready === null) {
          outcome.status = "unscanned";
          continue;
        }
        prepared = ready;
        scans.set(index, prepared);
      }
      const result = activate(scan, prepared, entrySetting, depthOf(index), scope);
      if (!prepared.reported && result.status !== "unscanned") {
        prepared.reported = true;
        for (const found of prepared.problems) problem(index)(found.key, found.problem);
      }
      const reason = result.reason;
      if (result.status === "sent" && reason !== undefined && reason.kind !== "sticky") {
        candidates.push({ index, reason });
      } else Object.assign(outcome, result);
    }
    // Event pools first (pools.ts), then each remaining candidate's chance, in candidate order.
    const lost = pools.resolve(candidates.map((candidate) => candidate.index));
    for (const { index, reason } of candidates) {
      const outcome = outcomes[index];
      const entrySetting = settings[index];
      if (outcome === undefined || entrySetting === undefined) continue;
      const pool = lost.get(index);
      const decided: Outcome =
        pool === undefined
          ? rolled(reason, entrySetting, input.random, pass)
          : { status: "poolLost", reason, pool };
      Object.assign(outcome, decided);
      if (decided.status === "sent") activated.push(index);
    }
    for (const index of fit.add(activated, pass)) {
      const content = outcomes[index]?.content;
      if (content !== undefined && settings[index]?.preventRecursion === false && chains(index)) {
        scan.texts.push({ message: new ScannedMessage(withoutHighlights(content)), from: index });
      }
    }
    if (!recursive || fit.cut || scan.meter.exhausted || activated.length === 0) break;
  }
  // A bound, not the book, ended recursion: the passes that could still have
  // reached an unmatched entry of a chaining book never ran, so it is reported unscanned.
  if (recursive && (scan.meter.exhausted || fit.short)) {
    for (const [index, outcome] of outcomes.entries()) {
      const waiting = outcome.status === "notMatched" || outcome.status === "chainOnly";
      if (waiting && settings[index]?.excludeRecursion === false && chains(index)) {
        outcome.status = "unscanned";
      }
    }
  }

  return {
    ...placed(entries, settings, outcomes),
    finalize(delivered, rendered = delivered) {
      const final = outcomes.map(
        (outcome, index): Outcome =>
          outcome.status !== "sent" || delivered.has(index)
            ? outcome
            : { ...outcome, status: rendered.has(index) ? "doesNotFit" : "empty" },
      );
      const sent = final.flatMap((outcome, index) => (outcome.status === "sent" ? [index] : []));
      return {
        state: nextState(all, settings, timed, sent, length, identity),
        report: report(books, input.budget, final, settings, {
          turns: Math.min(bookDepth, input.turns.length),
          passes,
          used: sent.reduce((total, index) => total + (final[index]?.tokens ?? 0), 0),
          keyProblems,
        }),
      };
    },
  };
}

/** Fills, parses and compiles an entry's keys; null when the work runs out. */
function prepare(scan: Scan, entry: LorebookEntry, settings: EntrySettings): EntryScan | null {
  const problems: EntryScan["problems"] = [];
  const primary = scan.prepare(entry.keys, entry.useRegex, problems);
  // Secondary keys are prepared like primary ones, their problems reported alike.
  const secondary = usesSecondary(entry, settings)
    ? scan.prepare(settings.secondaryKeys, entry.useRegex, problems)
    : { ready: [], refused: [] };
  if (primary === null || secondary === null) return null;
  return { primary: primary.ready, secondary, memos: new Map(), reported: false, problems };
}

/**
 * One entry's keys against the chat and the first `scope` recursed texts:
 * sent with the reason, filtered, or not matched. An entry the chat alone
 * activates keeps the reason `key`; one that needs a recursed text is
 * `recursed`, from the entry whose text its primary key, else a secondary
 * key, matched.
 */
function activate(
  scan: Scan,
  entry: EntryScan,
  settings: EntrySettings,
  depth: number,
  scope: number,
): Outcome {
  let status: LorebookStatus = "notMatched";
  // More text can only add matches, so the AND logics try the chat alone first (its
  // reason is then `key`); a NOT logic must see every text a forbidden key could be in.
  const not = settings.logic === "notAny" || settings.logic === "notAll";
  const stages = scope === 0 ? [0] : not ? [scope] : [0, scope];
  for (const within of stages) {
    const primary = scan.match(entry, settings, depth, within);
    if (primary === EXHAUSTED) return { status: "unscanned" };
    if (primary === null) continue;
    const verdict = scan.secondary(settings.logic, entry, settings, depth, within);
    if (verdict === EXHAUSTED) return { status: "unscanned" };
    if (!verdict.pass) {
      status = "filtered";
      continue;
    }
    // Bounded like the report's other lists: at most as many as a card has tags.
    const secondary = verdict.decided
      ?.slice(0, CARD_LIMITS.tags)
      .map(({ key, matched }) => ({ key, matched }));
    const from = primary.from ?? verdict.decided?.find((found) => found.from !== null)?.from;
    const reason: Reason =
      from === undefined || from === null
        ? { kind: "key", key: primary.key, matched: primary.matched }
        : { kind: "recursed", key: primary.key, matched: primary.matched, from };
    return {
      status: "sent",
      reason: secondary === undefined ? reason : { ...reason, logic: settings.logic, secondary },
    };
  }
  return { status };
}

/** Sticky entries fit first, then earlier passes, higher insertion orders and book order. */
function fitOrder(
  entries: readonly LorebookEntry[],
  outcomes: readonly Outcome[],
): (a: number, b: number) => number {
  const sticky = (index: number) => (outcomes[index]?.reason?.kind === "sticky" ? 0 : 1);
  return (a, b) =>
    sticky(a) - sticky(b) ||
    (outcomes[a]?.pass ?? 0) - (outcomes[b]?.pass ?? 0) ||
    (entries[b]?.insertionOrder ?? 0) - (entries[a]?.insertionOrder ?? 0) ||
    a - b;
}

/**
 * The budget fit, one pass's activated entries at a time: fills and counts
 * them in fit order until the first that does not fit, which ends the fit
 * and the recursion. Text is filled one entry at a time, within the
 * request's allowance: a hostile book cannot make every entry expand.
 * Entries whose host this request does not send (a lorebook or example
 * block the preset switches off, an Author's Note not sent) stay outside the
 * budget.
 */
class Fit {
  used = 0;
  cut = false;
  /** Whether the request's entry-text allowance ran out, leaving an entry unfilled. */
  short = false;
  private text: number = LOREBOOK_RULES.entryText;
  private readonly input: ActivationRequest;
  private readonly entries: readonly LorebookEntry[];
  private readonly settings: readonly EntrySettings[];
  private readonly outcomes: Outcome[];
  private readonly order: (a: number, b: number) => number;
  private readonly scan: Scan;

  constructor(
    input: ActivationRequest,
    entries: readonly LorebookEntry[],
    settings: readonly EntrySettings[],
    outcomes: Outcome[],
    scan: Scan,
  ) {
    this.input = input;
    this.entries = entries;
    this.settings = settings;
    this.outcomes = outcomes;
    this.scan = scan;
    this.order = fitOrder(entries, outcomes);
  }

  /** Fits one pass's activated entries; returns those sent, in fit order. */
  add(activated: readonly number[], pass: number): number[] {
    const fitted: number[] = [];
    const queue: number[] = [];
    for (const index of activated) {
      const outcome = this.outcomes[index];
      if (outcome === undefined || outcome.pass !== pass) continue;
      const off = hostOff(this.settings[index]?.placement, this.input.blocks);
      if (off === null) queue.push(index);
      else outcome.status = off;
    }
    queue.sort(this.order);
    for (const index of queue) {
      const outcome = this.outcomes[index];
      const entry = this.entries[index];
      if (outcome === undefined || entry === undefined) continue;
      if (this.cut) {
        outcome.status = "afterCutoff";
        continue;
      }
      if (this.scan.macroExhausted) {
        outcome.status = "unscanned";
        this.short = true;
        continue;
      }
      const limit = Math.min(MAX_MACRO_OUTPUT, this.text - entry.content.length);
      if (limit <= 0) {
        outcome.status = "unscanned";
        this.short = true;
        continue;
      }
      const content = entryContent(entry, this.input.macros, limit, this.scan.entryMacroWork);
      if (this.scan.macroExhausted) {
        outcome.status = "unscanned";
        this.short = true;
        continue;
      }
      this.text -= entry.content.length + (content?.length ?? limit);
      if (content === null) {
        outcome.status = "tooLong";
        continue;
      }
      if (content.trim() === "") {
        outcome.status = "empty";
        continue;
      }
      const tokens = Math.max(0, Math.ceil(this.input.count(content)));
      outcome.tokens = tokens;
      if (this.used + tokens <= this.input.budget) {
        this.used += tokens;
        outcome.content = content;
        fitted.push(index);
      } else {
        outcome.status = "doesNotFit";
        this.cut = true;
      }
    }
    return fitted;
  }
}

/** A disabled source reports blockOff. Note placements report noteOff unless the note is due, including notes with empty text. */
function hostOff(
  placement: EntrySettings["placement"] | undefined,
  blocks: ActivationRequest["blocks"],
): "blockOff" | "noteOff" | null {
  switch (placement) {
    case "before":
    case "after":
      return blocks[placement] ? null : "blockOff";
    case "examplesTop":
    case "examplesBottom":
      return blocks.examples ? null : "blockOff";
    case "anTop":
    case "anBottom":
      return blocks.authorsNote ? null : "noteOff";
    case "depth":
      return blocks.history === false ? "blockOff" : null;
    default:
      return null;
  }
}

/** Sent lists use insertion order, with later activation and later book entries first at ties. */
function placed(
  entries: readonly LorebookEntry[],
  settings: readonly EntrySettings[],
  outcomes: readonly Outcome[],
): Omit<LorebookActivation, "finalize"> {
  const result: Omit<LorebookActivation, "finalize"> = {
    before: [],
    after: [],
    depth: [],
    authorsNote: { top: [], bottom: [] },
    examples: { before: [], after: [] },
  };
  const groups = new Map<string, DepthGroup>();
  const pass = (index: number) => outcomes[index]?.pass ?? 0;
  const order = insertionOrder(entries).sort(
    (a, b) =>
      (entries[a]?.insertionOrder ?? 0) - (entries[b]?.insertionOrder ?? 0) || pass(b) - pass(a),
  );
  for (const index of order) {
    const outcome = outcomes[index];
    const entry = settings[index];
    if (outcome?.status !== "sent" || entry === undefined || outcome.content === undefined)
      continue;
    const sent = { index, content: outcome.content };
    switch (entry.placement) {
      case "before":
      case "after":
        result[entry.placement].push(sent);
        break;
      case "anTop":
        result.authorsNote.top.push(sent);
        break;
      case "anBottom":
        result.authorsNote.bottom.push(sent);
        break;
      case "examplesTop":
        result.examples.before.push(sent);
        break;
      case "examplesBottom":
        result.examples.after.push(sent);
        break;
      case "depth": {
        const id = `${entry.depth}/${entry.role}`;
        const group = groups.get(id) ?? { depth: entry.depth, role: entry.role, entries: [] };
        groups.set(id, group);
        group.entries.push(sent);
        break;
      }
    }
  }
  result.depth = [...groups.values()].sort(
    (a, b) =>
      b.depth - a.depth ||
      ["system", "user", "assistant"].indexOf(a.role) -
        ["system", "user", "assistant"].indexOf(b.role),
  );
  return result;
}

/**
 * The report. Every entry index in it (an entry's, a recursed reason's
 * `from`, a key problem's) is the combined index; `sources` attributes it to
 * a book and its index there (`entryOrigin`).
 */
function report(
  books: CombinedLorebooks,
  budget: number,
  outcomes: Outcome[],
  settings: readonly EntrySettings[],
  scanned: {
    turns: number;
    passes: number;
    used: number;
    keyProblems: LorebookReport["keyProblems"];
  },
): LorebookReport {
  const counts = Object.fromEntries(LOREBOOK_STATUSES.map((status) => [status, 0])) as Record<
    LorebookStatus,
    number
  >;
  const depth = messageCount(books.scanDepth);
  const entries: LorebookReport["entries"] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const at = books.entries[index];
    const entrySetting = settings[index];
    if (at === undefined || entrySetting === undefined) continue;
    counts[outcome.status] += 1;
    if (counts[outcome.status] > LOREBOOK_RULES.reportEntries) continue;
    const inFit = FIT_STATUSES.has(outcome.status);
    const { placement, role } = entrySetting;
    // The depth it reads: its own, else its book's; named when it differs from the report's.
    const scanDepth = entrySetting.scanDepth ?? messageCount(at.scanDepth);
    entries.push({
      index,
      title: entryTitle(at.entry, at.index),
      placement,
      ...(placement === "depth" ? { depth: entrySetting.depth, role } : {}),
      ...(scanDepth !== depth ? { scanDepth } : {}),
      status: outcome.status,
      ...(outcome.pass === undefined ? {} : { pass: outcome.pass }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.left === undefined ? {} : { left: outcome.left }),
      ...(outcome.until === undefined ? {} : { until: outcome.until }),
      ...(outcome.pool === undefined
        ? {}
        : { pool: { ...outcome.pool, name: clip(outcome.pool.name) } }),
      ...(inFit && outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
    });
  }
  return {
    scanDepth: depth,
    scannedTurns: scanned.turns,
    passes: scanned.passes,
    budget: Math.max(0, Math.floor(budget)),
    used: scanned.used,
    sources: books.sources,
    entries,
    counts,
    keyProblems: scanned.keyProblems,
  };
}
