import type {
  EntryActivation,
  EntryLogic,
  EntryPlacement,
  EntrySettings,
  KeyProblem,
  LorebookEntry,
  PromptRole,
} from "@ephemera/core";
import { ROLE_NAMES } from "@/lib/roles";
import { countOf, formatCount, sentence } from "@/lib/text";

/** Why a key never matches. */
export const KEY_PROBLEM_TEXT: Record<KeyProblem | "tooLong", string> = {
  invalidPattern: "This pattern has a syntax error, so it never matches.",
  unsupportedPattern:
    "This pattern uses lookaround or a backreference, which Ephemera doesn't run, so it never matches.",
  repeatTooLarge:
    "This pattern repeats something more than 100 times, which Ephemera doesn't run, so it never matches.",
  tooLong: "Its macros make it longer than 200 characters, so it never matches.",
};

/** Why a secondary key never matches, as the second sentence after its consequence. */
export const KEY_PROBLEM_REASON: Record<KeyProblem, string> = {
  invalidPattern: "It has a syntax error.",
  unsupportedPattern: "It uses lookaround or a backreference, which Ephemera doesn't run.",
  repeatTooLarge: "It repeats something more than 100 times, which Ephemera doesn't run.",
};

const messages = (count: number) => countOf(count, "message");

/* The entry editor. */

/** How an entry goes in, as the editor's choice names it (book.ts reads and writes it). */
export const ACTIVATION_TEXT: Record<EntryActivation, string> = {
  always: "Always",
  keywords: "On keywords",
  chance: "By chance",
};

/** The budget help's last word: books read together share the largest allowance. */
export const SHARED_BUDGET =
  "When a character has several lorebooks, the largest allowance applies to all of them together.";

/** The library's counts of enabled entries by kind: "3 always", "31 on keywords", "8 by chance". */
export const ACTIVATION_COUNT_TEXT: Record<EntryActivation, string> = {
  always: "always",
  keywords: "on keywords",
  chance: "by chance",
};

/** A trigger chance as a percentage: "10%". */
export const percent = (chance: number) => `${formatCount(chance)}%`;

/** An entry that went in on its roll, in the inspector: "passed the 10% chance". */
export const chancePassedText = (chance: number) => `passed the ${percent(chance)} chance`;

/** An entry its roll left out, in the inspector: "chance did not pass (10%)". */
export const chanceMissedText = (chance: number) => `chance did not pass (${percent(chance)})`;

/** An entry with a chance held in by sticky timing, which is never rolled. */
export const stickySparedText = (chance: number) =>
  `kept by sticky without a roll (${percent(chance)} chance)`;

/** The help under an always-on entry's chance. */
export const chanceHelp = (chance: number) =>
  `Added to about ${percent(chance)} of replies, no keyword needed.`;

/** The keywords' help, following the entry's effective settings. */
export function keywordsHelp(
  settings: EntrySettings,
  constant: boolean,
  useRegex: boolean,
): string {
  if (constant) return ALWAYS_ON_HELP;
  const matching = settings.effectiveWholeWords
    ? "A single word matches whole words; a phrase matches anywhere in a message."
    : "A keyword matches anywhere in a message.";
  const patterns = useRegex
    ? "The card makes every keyword a regular expression."
    : "Write /pattern/ for a regular expression.";
  return `Enter or a comma adds one. ${matching} ${patterns}`;
}

export const ALWAYS_ON_HELP = "No keywords needed. Timing, pools and the budget still apply.";

/** The secondary condition's choices, read as the sentence "Goes in only if the messages … these:". */
export const LOGIC_TEXT: Record<EntryLogic, { label: string; description: string }> = {
  andAny: { label: "also have any of", description: "AND ANY: one or more of them" },
  andAll: { label: "also have all of", description: "AND ALL: every one of them" },
  notAny: { label: "have none of", description: "NOT ANY: not one of them" },
  notAll: {
    label: "don't have all of",
    description: "NOT ALL: goes in unless every one of them is there, so one, some or none will do",
  },
};

/**
 * What refused secondary keys do to the condition: `refused` of `total` never
 * match. Consequence first; the reason follows in the field.
 */
export function secondaryConsequence(logic: EntryLogic, refused: number, total: number): string {
  const one = refused === 1;
  const lead = one ? "This pattern never matches" : "These patterns never match";
  const quoted = `'${LOGIC_TEXT[logic].label}'`;
  switch (logic) {
    case "andAll":
      return `${lead}, so ${quoted} can never be met.`;
    case "andAny":
      return refused < total
        ? `${lead}; the other words still count.`
        : `${lead}, so ${quoted} can never be met.`;
    case "notAny":
      return `${lead}, so ${one ? "it never keeps" : "they never keep"} the entry out.`;
    case "notAll":
      return `${lead}, so ${quoted} is always met.`;
  }
}

/** Placement choices in speaking order, each with its one-line description. */
export const PLACEMENT_TEXT: Record<EntryPlacement, { label: string; description: string }> = {
  before: {
    label: "Before the character",
    description: "Ahead of the description, personality and scenario",
  },
  after: {
    label: "After the character",
    description: "Right after the description, personality and scenario",
  },
  examplesTop: {
    label: "Before the example dialogue",
    description: "Read as example dialogue, so write it as {{user}}: and {{char}}: lines",
  },
  examplesBottom: {
    label: "After the example dialogue",
    description: "Read as example dialogue, so write it as {{user}}: and {{char}}: lines",
  },
  anTop: {
    label: "Above the Author's Note",
    description: "Joined into the Author's Note, above its text; sent only when the note is",
  },
  anBottom: {
    label: "Below the Author's Note",
    description: "Joined into the Author's Note, below its text; sent only when the note is",
  },
  depth: {
    label: "In the chat",
    description: "Among the messages, at the depth you choose",
  },
};

/** The menu's order: where the prompt speaks them. */
export const PLACEMENTS: readonly EntryPlacement[] = [
  "before",
  "after",
  "examplesTop",
  "examplesBottom",
  "anTop",
  "anBottom",
  "depth",
];

const roleWord = (role: PromptRole) => ROLE_NAMES[role].toLowerCase();

/** Where among the messages: "in the chat at depth 4", or after the last message at 0. */
export const inChatText = (depth: number) =>
  `in the chat ${depth === 0 ? "after the last message" : `at depth ${formatCount(depth)}`}`;

/**
 * Where an entry goes, as the editor and the inspector say it: the
 * placement's label, or for the chat its depth and role.
 */
export function placementText(placement: EntryPlacement, depth: number, role: PromptRole): string {
  return placement === "depth"
    ? `${sentence(inChatText(depth))} as ${roleWord(role)}`
    : PLACEMENT_TEXT[placement].label;
}

/** Where it goes, the row's answer. */
export function placementAnswer(settings: EntrySettings, order: number): string {
  const { placement, depth, role } = settings;
  return `${placementText(placement, depth, role)}, order ${formatCount(order)}`;
}

type Timing = Pick<EntrySettings, "sticky" | "cooldown" | "delay">;

/**
 * The timing sentence under the fields: delay first, then the sticky span and
 * the cooldown after it, never promising the entry is sent. An effect started
 * at a message count holds while the count is below that start plus its
 * length.
 */
export function timingSentence({ sticky, cooldown, delay }: Timing): string {
  const parts: string[] = [];
  if (delay > 0) parts.push(`Can't go in before the chat has ${messages(delay)}.`);
  if (sticky > 0 && cooldown > 0) {
    parts.push(
      `Once in, it stays in for ${countOf(sticky, "more message")}, then can't come back for ${formatCount(cooldown)}.`,
    );
  } else if (sticky > 0) {
    parts.push(`Once in, it stays in for ${countOf(sticky, "more message")}.`);
  } else if (cooldown > 0) {
    parts.push(`Once in, it can't come back for ${messages(cooldown)}.`);
  }
  return parts.length === 0 ? "No timing limits." : parts.join(" ");
}

/** How messages are counted, said once under the timing sentence. */
export const TIMING_COUNT =
  "Messages count one by one, not in pairs: your message and the reply are two.";

/**
 * When it goes in, the row's answer: the strongest restriction first. A
 * keyword entry's trigger chance, when it has one, leads.
 */
export function timingAnswer(
  { sticky, cooldown, delay }: Timing,
  chance: number | null = null,
): string {
  const parts: string[] = [];
  if (chance !== null) parts.push(`${percent(chance)} chance when it matches`);
  if (delay > 0) parts.push(`not before ${messages(delay)}`);
  if (sticky > 0) parts.push(`stays in for ${formatCount(sticky)} more`);
  if (cooldown > 0) {
    parts.push(
      sticky > 0
        ? `then rests for ${formatCount(cooldown)}`
        : `rests for ${messages(cooldown)} after going in`,
    );
  }
  if (parts.length === 0) return "No timing limits";
  return sentence(parts.join(", "));
}

/** What can bring the entry in: the two recursion flags as one choice. */
export type Source = "keywordsOrEntry" | "keywordsOnly" | "entryOnly";

export const SOURCE_TEXT: Record<Source, string> = {
  keywordsOrEntry: "Its keywords or another entry",
  keywordsOnly: "Its keywords only",
  entryOnly: "Another entry only",
};

/** The choice the flags make, or null when a card sets both and the entry can never go in. */
export function entrySource(settings: EntrySettings): Source | null {
  const delayed = settings.recursiveOnly;
  if (settings.excludeRecursion && delayed) return null;
  if (settings.excludeRecursion) return "keywordsOnly";
  return delayed ? "entryOnly" : "keywordsOrEntry";
}

const CHAINING_OFF = "The book doesn't chain entries";
export const SOURCE_CONFLICT = "These settings keep it from ever going in.";

/**
 * The note above the choices while the book doesn't chain: an entry only
 * another entry brings in is kept out (core evaluates it in recursive passes
 * only), the others' chaining settings do nothing.
 */
export function chainingOffNote(settings: EntrySettings): string {
  return entrySource(settings) === "entryOnly"
    ? `${CHAINING_OFF}, so this entry stays out until it does or you choose another way in.`
    : `${CHAINING_OFF}, so these have no effect here.`;
}

/** An entry only another entry brings in, which no recursive pass reached, in the inspector. */
export const CHAIN_ONLY_TEXT = {
  word: "waiting for another entry",
  label: "Waiting for another entry to bring it in",
};

/** The event pool row's help, said once above its fields. */
export const POOL_HELP =
  "At most one entry of a pool is sent per reply. The chosen entry must still pass its chance and fit the budget. A pool with the same name in another of the character's lorebooks is the same pool.";

/** Its event pools, the row's answer: "Weather; weight 100", or "None". */
export function poolAnswer(settings: EntrySettings): string {
  if (settings.poolNames.length === 0) return "None";
  const how = settings.poolPrioritized ? "prioritized, weight" : "weight";
  return `${settings.poolNames.join(", ")}; ${how} ${formatCount(settings.poolWeight)}`;
}

/** Its event pools as a list row names them: "pool Weather", "pools Weather, Night". */
export const poolsText = (names: readonly string[]) =>
  `${names.length === 1 ? "pool" : "pools"} ${names.join(", ")}`;

/**
 * Why the inspector left an entry out for its event pool, after its title:
 * the pool's holder by title, or none when every entry that took it was
 * left out by another pool.
 */
export const poolLostText = (pool: string, holder: string | null) =>
  holder === null ? `pool ${pool} was already taken` : `pool ${pool} went to ${holder}`;

/** What brings it in, the row's answer. */
export function chainingAnswer(settings: EntrySettings, bookChains: boolean): string {
  if (!bookChains) {
    return entrySource(settings) === "entryOnly"
      ? "Never goes in while the book doesn't chain entries"
      : CHAINING_OFF;
  }
  const source = entrySource(settings);
  if (source === null) return "Never goes in: its settings rule each other out";
  const text = settings.preventRecursion
    ? "its text brings in no other entry"
    : "its text can bring in others";
  return `${SOURCE_TEXT[source]}, and ${text}`;
}

/** What it matches, the row's answer: the entry's own settings named first. */
export function matchingAnswer(settings: EntrySettings, bookDepth: number): string {
  const depth =
    settings.scanDepth === null
      ? { own: false, text: `book's ${messages(bookDepth)}` }
      : { own: true, text: `last ${messages(settings.scanDepth)}` };
  const matchCase = {
    own: settings.caseSensitive !== null,
    text: settings.effectiveCaseSensitive ? "matching case" : "any case",
  };
  const words = {
    own: settings.wholeWords !== null,
    text: settings.effectiveWholeWords ? "whole words" : "inside words too",
  };
  const parts = [depth, matchCase, words];
  const ordered = [...parts.filter((part) => part.own), ...parts.filter((part) => !part.own)];
  return sentence(ordered.map((part) => part.text).join(", "));
}

/**
 * The words a list row shows before its keywords, most consequential first,
 * so truncation eats keywords, not these. `ink` cues read in full ink.
 */
export function entryCues(
  entry: LorebookEntry,
  settings: EntrySettings,
): { text: string; ink: boolean }[] {
  const cues: { text: string; ink: boolean }[] = [];
  if (!entry.enabled) cues.push({ text: "Off", ink: true });
  switch (settings.placement) {
    case "depth":
      cues.push({ text: `Depth ${formatCount(settings.depth)}`, ink: false });
      cues.push({ text: roleWord(settings.role), ink: false });
      break;
    case "examplesTop":
    case "anTop":
      cues.push({ text: settings.placement === "anTop" ? "Above" : "Before", ink: false });
      break;
    case "examplesBottom":
    case "anBottom":
      cues.push({ text: settings.placement === "anBottom" ? "Below" : "After", ink: false });
      break;
    default:
      break;
  }
  const source = entrySource(settings);
  if (source === null) cues.push({ text: "never goes in", ink: true });
  if (source === "entryOnly") cues.push({ text: "chained only", ink: false });
  if (settings.sticky > 0 || settings.cooldown > 0 || settings.delay > 0) {
    cues.push({ text: "timing set", ink: false });
  }
  // An always-on entry's chance stands beside "By chance" in the row instead.
  if (settings.chance !== null && entry.constant !== true) {
    cues.push({ text: `${percent(settings.chance)} chance`, ink: false });
  }
  return cues;
}
