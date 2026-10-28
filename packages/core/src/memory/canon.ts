import type { CharacterCard } from "../card/schema.ts";
import type { ChatTurn, SpeakerNames } from "../chat.ts";
import { activateLorebooks, type SentEntry } from "../lorebook/activate.ts";
import { combineLorebooks, type LorebookSource } from "../lorebook/combine.ts";
import { withEntrySettings } from "../lorebook/settings.ts";
import { MAX_MACRO_OUTPUT, MacroLimitError } from "../prompt/macros.ts";

/*
 * Canon for the memory and chapter calls: what the model that tells the
 * story already receives with every reply, so a memory never spends its
 * room restating it. The card's description, personality and scenario, the
 * persona's description, and the entries of its lorebooks that are constant or whose keys the scanned
 * text matches, found by the lorebook's own activation without chance or
 * timed effects. With no turns to scan, as for the opening call, only the
 * constant entries go in. Chat content once assembled: built for one call,
 * never stored, kept or logged.
 */

/** `{{char}}` and `{{user}}`, and their legacy forms, as the two names; nothing else is filled. */
const NAMES = /\{\{\s*(char|user)\s*\}\}|<(bot|char|user)>/gi;

function fillNames(text: string, names: SpeakerNames, limit = MAX_MACRO_OUTPUT): string {
  const filled = text.replace(NAMES, (_, braced: string | undefined, legacy: string | undefined) =>
    (braced ?? legacy ?? "").toLowerCase() === "user" ? names.user : names.char,
  );
  if (filled.length > limit) throw new MacroLimitError();
  return filled;
}

interface CanonInput {
  card: Pick<CharacterCard, "description" | "personality" | "scenario" | "lorebook">;
  names: SpeakerNames;
  /** The description of the persona the user plays, when there is one. */
  persona?: string;
  /** The library books linked to the character, in link order. */
  linked: readonly LorebookSource[];
  /** The text keys are matched against: the span, or the memories a chapter merges; none keys none. */
  turns: readonly Pick<ChatTurn, "role" | "content" | "name" | "scanText">[];
  /** The call's context window: the lorebook budget is its share. */
  window: number;
  /** Tokens of a text, as the call counts them. */
  count: (text: string) => number;
}

/**
 * The card's description, personality and scenario and the persona's
 * description, names filled, each under its label; blank ones left out, ""
 * when all are. The field part of every canon (`memoryCanon`, `castCanon`).
 */
export function canonFields({
  card,
  names,
  persona = "",
}: {
  card: Pick<CharacterCard, "description" | "personality" | "scenario">;
  names: SpeakerNames;
  persona?: string;
}): string {
  return (
    [
      ["Description", card.description],
      ["Personality", card.personality],
      ["Scenario", card.scenario],
      [`Persona (${names.user})`, persona],
    ] as const
  )
    .map(([label, text]) => [label, fillNames(text, names).trim()] as const)
    .filter(([, text]) => text !== "")
    .map(([label, text]) => `${label}:\n${text}`)
    .join("\n\n");
}

/**
 * The canon text for one call, or null when there is none. The card's
 * fields go in whole; the entries share the lorebook budget for `window`
 * (`combineLorebooks`) less what the fields take. Every entry reads the
 * whole of `turns`, chance and sticky, cooldown and delay set aside, so the
 * same input always gives the same canon.
 */
export function memoryCanon({
  card,
  names,
  persona = "",
  linked,
  turns,
  window,
  count,
}: CanonInput): string | null {
  const fields = canonFields({ card, names, persona });

  const book = card.lorebook;
  const sources: LorebookSource[] = [
    ...(book === undefined ? [] : [{ id: null, name: book.name ?? "", book }]),
    ...linked,
  ];
  let entries: string[] = [];
  if (sources.length > 0) {
    const { books, budget } = combineLorebooks(sources, window);
    const depth = turns.length;
    // No turns, no keys: only constant entries take part, keeping their places in the books.
    const constantOnly = turns.length === 0;
    const steady = {
      ...books,
      scanDepth: depth,
      entries: books.entries.map((at) => ({
        ...at,
        scanDepth: depth,
        entry: withEntrySettings(
          constantOnly
            ? { ...at.entry, enabled: at.entry.enabled && at.entry.constant === true }
            : at.entry,
          {
            scanDepth: null,
            useProbability: false,
            sticky: 0,
            cooldown: 0,
            delay: 0,
          },
        ),
      })),
    };
    const sent = activateLorebooks({
      books: steady,
      turns: [...turns],
      names,
      macros: (text, limit) => fillNames(text, names, limit),
      count,
      budget: Math.max(0, budget - (fields === "" ? 0 : count(fields))),
      blocks: { before: true, after: true, examples: true, authorsNote: true },
      timed: null,
      random: () => 0,
    });
    const all: SentEntry[] = [
      ...sent.before,
      ...sent.after,
      ...sent.depth.flatMap((group) => group.entries),
      ...sent.authorsNote.top,
      ...sent.authorsNote.bottom,
      ...sent.examples.before,
      ...sent.examples.after,
    ];
    entries = all
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.content.trim())
      .filter((content) => content !== "");
  }

  const sections = [
    fields === "" ? null : fields,
    entries.length === 0 ? null : `Lorebook:\n${entries.join("\n\n")}`,
  ].filter((section) => section !== null);
  return sections.length === 0 ? null : sections.join("\n\n");
}
