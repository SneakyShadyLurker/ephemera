import { entryOrigin, type LorebookStatus, type LorebookReport as Report } from "@ephemera/core";
import { useState } from "react";
import { ChevronDownIcon, LorebookIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { andList, countOf, formatCount, orList } from "@/lib/text";
import {
  CHAIN_ONLY_TEXT,
  chanceMissedText,
  chancePassedText,
  KEY_PROBLEM_TEXT,
  placementText,
  poolLostText,
  stickySparedText,
} from "../lorebook/copy.ts";
import { EntryLink } from "../lorebook/EntryLink.tsx";

/*
 * The inspector's lorebook section: which entries went in and on which
 * words, which the budget left out, and why the rest did not go in. Chat
 * content from the in-memory prompt; nothing here is kept or sent.
 */

type Entry = Report["entries"][number];

/** Sent entries shown before "Show all". */
const FIRST = 12;

const OVER: LorebookStatus[] = ["doesNotFit", "afterCutoff"];
const messages = (count: number) => countOf(count, "message");
/** A timed effect's remaining span: "2 more messages". */
const moreMessages = (count: number) => countOf(count, "more message");

/** The trigger chance an entry was rolled against, if any; a sticky one was never rolled. */
const chanceOf = (entry: Entry) =>
  entry.reason === undefined || entry.reason.kind === "sticky" ? undefined : entry.reason.chance;

/** Where an entry of the combined books came from: its book's name and where to edit it. */
interface Origin {
  name: string;
  book: string | null;
  index: number;
}

/** The title of the entry at `index`, as the report lists it. */
type TitleOf = (index: number) => string;

/**
 * The rest, in the words of the disclosure line and its list, with what an
 * entry waits for or what kept it out.
 */
const OTHER: [
  LorebookStatus,
  string,
  string,
  ((entry: Entry, titleOf: TitleOf) => string | null)?,
][] = [
  [
    "cooldown",
    "resting after going in",
    "Resting after going in",
    (entry) => (entry.left === undefined ? null : moreMessages(entry.left)),
  ],
  [
    "delayed",
    "waiting for a longer chat",
    "Waiting for a longer chat",
    (entry) => (entry.until === undefined ? null : `until ${messages(entry.until)}`),
  ],
  ["chainOnly", CHAIN_ONLY_TEXT.word, CHAIN_ONLY_TEXT.label],
  ["filtered", "ruled out by its other words", "Ruled out by its other words"],
  [
    "chanceMissed",
    "left out by chance",
    "Left out by chance this time",
    (entry) => {
      const chance = chanceOf(entry);
      return chance === undefined ? null : chanceMissedText(chance);
    },
  ],
  [
    "poolLost",
    "left out by an event pool",
    "Left out for another entry of the same event pool",
    (entry, titleOf) =>
      entry.pool === undefined
        ? null
        : poolLostText(
            entry.pool.name,
            entry.pool.holder === undefined ? null : titleOf(entry.pool.holder),
          ),
  ],
  ["notMatched", "not matched", "No keyword in the scanned messages"],
  ["off", "off", "Switched off"],
  [
    "noteOff",
    "not sent without the Author's Note",
    "Not sent: the preset's Author's Note is off or not due",
  ],
  ["empty", "empty", "No text to send"],
  ["tooLong", "too long", "Its text is too long once macros are filled"],
  ["unscanned", "not scanned", "Not scanned: the book is too large to scan in one request"],
];

/** Where the entry goes, in the editor's words. */
const placement = (entry: Entry) =>
  placementText(entry.placement, entry.depth ?? 0, entry.role ?? "system");

type Keyed = Extract<NonNullable<Entry["reason"]>, { kind: "key" | "recursed" }>;

/** The word a key found, underlined as the text it matched. */
const Word = ({ children }: { children: string }) => (
  <span className="text-ink underline decoration-control-edge decoration-dotted underline-offset-3">
    {children}
  </span>
);

/** What the secondary keys added, under their logic: the keys that decided it. */
function secondaryText(reason: Keyed): string {
  const words = (reason.secondary ?? []).map(({ key, matched }) =>
    matched === "" ? key : matched,
  );
  switch (reason.logic) {
    case "andAny":
    case "andAll":
      return words.length === 0 ? "" : `, with ${andList(words)}`;
    case "notAny":
      return words.length === 0 ? "" : `, without ${orList(words)}`;
    case "notAll":
      return ", and not all of its other words were there";
    default:
      return "";
  }
}

function why(entry: Entry, titleOf: TitleOf) {
  const cut =
    entry.status === "doesNotFit"
      ? ", doesn't fit"
      : entry.status === "afterCutoff"
        ? ", after the cutoff"
        : "";
  // An entry that passed its trigger chance's roll says so after what brought it in.
  const chance = chanceOf(entry);
  const byChance = chance !== undefined && (
    <>
      , <span className="text-ink">{chancePassedText(chance)}</span>
    </>
  );
  const reason = entry.reason;
  switch (reason?.kind) {
    case "recursed":
      return (
        <>
          {placement(entry)}, brought in by <span className="text-ink">{titleOf(reason.from)}</span>
          , matched <Word>{reason.matched === "" ? reason.key : reason.matched}</Word>
          {secondaryText(reason)}
          {byChance}
          {cut}
        </>
      );
    case "key":
      return (
        <>
          {placement(entry)}, matched{" "}
          <Word>{reason.matched === "" ? reason.key : reason.matched}</Word>
          {secondaryText(reason)}
          {byChance}
          {cut}
        </>
      );
    case "sticky":
      return (
        <>
          {placement(entry)}, <span className="text-ink">stays in</span>,{" "}
          {moreMessages(reason.left)}
          {reason.chance !== undefined && `, ${stickySparedText(reason.chance)}`}
          {cut}
        </>
      );
    default:
      return chance === undefined ? (
        <>
          {placement(entry)}, <span className="text-ink">always on</span>
          {cut}
        </>
      ) : (
        <>
          {placement(entry)}
          {byChance}
          {cut}
        </>
      );
  }
}

/** The report lists up to 200 entries per status; the rest are counted, not named. */
function Unlisted({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="text-note text-reed">And {formatCount(count)} more, counted but not listed.</p>
  );
}

function Row({
  entry,
  titleOf,
  muted = false,
  origin,
  characterId,
}: {
  entry: Entry;
  titleOf: TitleOf;
  muted?: boolean;
  /** Its book, named when the request read several. */
  origin: Origin | null;
  characterId: string | null;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-rush border-b py-2 last:border-b-0">
      <span className="grid min-w-0">
        <span className="flex min-w-0 items-baseline gap-x-2">
          <span className={cn("min-w-0 truncate text-ui", muted ? "text-reed" : "text-ink")}>
            {entry.title}
          </span>
          {origin !== null &&
            (characterId === null ? (
              <span className="min-w-0 max-w-[60%] shrink truncate text-meta text-reed">
                {origin.name}
              </span>
            ) : (
              <EntryLink
                characterId={characterId}
                book={origin.book}
                index={origin.index}
                title={entry.title}
                // The visible words lead the name, so speech input finds the link by them.
                label={`${origin.name}: edit ${entry.title}`}
                className="min-w-0 max-w-[60%] shrink truncate rounded-sm text-meta text-reed underline decoration-control-edge underline-offset-3 hover:text-ink"
              >
                {origin.name}
              </EntryLink>
            ))}
        </span>
        <span className="text-pretty break-words text-meta text-reed">{why(entry, titleOf)}</span>
      </span>
      {entry.tokens !== undefined && (
        <span className="text-meta text-reed tabular-nums">{formatCount(entry.tokens)}</span>
      )}
    </li>
  );
}

export function LorebookReport({
  report,
  name,
  characterId = null,
  draft,
}: {
  report: Report;
  /** The character whose books these are. */
  name: string;
  /** Its id, for the links to each entry's editor; none while it is unknown. */
  characterId?: string | null;
  /** Whether the scanned messages include the composer's draft (a preview). */
  draft: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const [rest, setRest] = useState(false);
  const { counts } = report;
  const sent = report.entries.filter((entry) => entry.status === "sent");
  const over = report.entries.filter((entry) => OVER.includes(entry.status));
  const blockOff = report.entries.filter((entry) => entry.status === "blockOff");
  const others = OTHER.filter(([status]) => counts[status] > 0);
  const overCount = counts.doesNotFit + counts.afterCutoff;
  const otherCounts = others
    .map(([status, word]) => `${formatCount(counts[status])} ${word}`)
    .join(", ");
  const shownSent = all ? sent : sent.slice(0, FIRST);
  const titleOf: TitleOf = (index) =>
    report.entries.find((entry) => entry.index === index)?.title ??
    `Entry ${formatCount(index + 1)}`;
  const { sources } = report;
  const bookName = (source: Report["sources"][number]) =>
    source.id === null ? `${name}'s lorebook` : source.name.trim() || "Untitled lorebook";
  // With several books read together, each line names its own and links to it there.
  const originOf = (index: number): Origin | null => {
    if (sources.length < 2) return null;
    const at = entryOrigin(sources, index);
    const source = at === null ? undefined : sources[at.source];
    if (at === null || source === undefined) return null;
    return { name: bookName(source), book: source.id, index: at.index };
  };
  const [only] = sources;
  const books =
    sources.length > 1
      ? `${name}'s ${formatCount(sources.length)} lorebooks, read together`
      : only === undefined
        ? `${name}'s lorebook`
        : bookName(only);

  const turns = report.scannedTurns;
  const scanned =
    turns === 0
      ? "no messages"
      : `the last ${turns === 1 ? "message" : messages(turns)}${draft ? " (your draft among them)" : ""}`;
  // Entries may set their own scan depth; the listed ones say whether any reads further.
  const further = report.entries.some((entry) => (entry.scanDepth ?? 0) > report.scanDepth)
    ? ", further for entries that ask for it"
    : "";
  const reread = report.passes - 1;

  return (
    <section aria-label="Lorebook" className="border-rush border-t">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="press flex min-h-14 w-full items-center gap-3 px-5 text-left hover:bg-surface-hover"
      >
        <LorebookIcon size={16} className="shrink-0 text-reed" />
        <span className="grid min-w-0 flex-1">
          <span className="font-medium text-ink text-ui">Lorebook</span>
          <span className="truncate text-meta text-reed">
            {countOf(counts.sent, "entry", "entries")} went in
            {overCount > 0 && `, ${formatCount(overCount)} over the budget`}
          </span>
        </span>
        <span className="text-meta text-reed tabular-nums">
          {formatCount(report.used)} of {formatCount(report.budget)}
        </span>
        <ChevronDownIcon
          size={16}
          className={cn(
            "shrink-0 text-reed transition-[rotate] duration-(--duration-arrive) ease-spring motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        className={cn(
          "overflow-hidden transition-[height,opacity] duration-(--duration-panel-in) ease-spring [interpolate-size:allow-keywords] motion-reduce:transition-opacity motion-reduce:duration-(--duration-quick)",
          open ? "h-auto opacity-100" : "h-0 opacity-0",
        )}
        inert={!open}
      >
        <div className="grid gap-3 px-5 pb-5">
          <p className="text-pretty text-note text-reed">
            {books}, read against {scanned}
            {further}.{" "}
            {reread > 0 &&
              `Entries' text was read ${countOf(reread, "more time")} for entries it brings in. `}
            Entries staying in from earlier messages come first, then the highest orders, entries
            other entries brought in last, until one doesn't fit; the figures are entry text in
            tokens.
          </p>
          {sent.length > 0 && (
            <ol aria-label="Lorebook entries sent" className="grid">
              {shownSent.map((entry) => (
                <Row
                  key={entry.index}
                  entry={entry}
                  titleOf={titleOf}
                  origin={originOf(entry.index)}
                  characterId={characterId}
                />
              ))}
            </ol>
          )}
          {sent.length > FIRST && !all && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="justify-self-start rounded-sm text-meta text-reed underline decoration-control-edge underline-offset-4 hover:text-ink touch:min-h-11"
            >
              Show all {formatCount(sent.length)}
            </button>
          )}
          {(all || sent.length <= FIRST) && <Unlisted count={counts.sent - sent.length} />}
          {over.length > 0 && (
            <div className="grid gap-1">
              <h4 className="text-ember text-note">Left out: over the budget</h4>
              <ol aria-label="Lorebook entries over the budget" className="grid">
                {over.map((entry) => (
                  <Row
                    key={entry.index}
                    entry={entry}
                    titleOf={titleOf}
                    origin={originOf(entry.index)}
                    characterId={characterId}
                    muted
                  />
                ))}
              </ol>
              <Unlisted count={overCount - over.length} />
            </div>
          )}
          {blockOff.length > 0 && (
            <p className="text-pretty text-note text-reed">
              Left out by the prompt preset, which switches their lorebook block off:{" "}
              {blockOff.map((entry) => entry.title).join(", ")}.
            </p>
          )}
          {report.keyProblems.length > 0 && (
            <p className="text-pretty text-ember text-note">
              {report.keyProblems.length === 1
                ? `1 keyword never matches: ${report.keyProblems[0]?.key}. ${KEY_PROBLEM_TEXT[report.keyProblems[0]?.problem ?? "invalidPattern"]}`
                : `${formatCount(report.keyProblems.length)} keywords never match: ${report.keyProblems.map((problem) => problem.key).join(", ")}.`}
            </p>
          )}
          {others.length > 0 && (
            <div className="grid">
              <button
                type="button"
                aria-expanded={rest}
                // The label and its counts stack visually; the name reads them as one line.
                aria-label={`Other entries: ${otherCounts}`}
                onClick={() => setRest(!rest)}
                className="flex min-h-9 items-center justify-between gap-2 rounded-sm py-1 text-left text-note text-reed hover:text-ink touch:min-h-11"
              >
                <span className="grid min-w-0">
                  <span className="text-ink">Other entries</span>
                  <span className="text-pretty text-meta">{otherCounts}</span>
                </span>
                <ChevronDownIcon
                  size={16}
                  className={cn(
                    "shrink-0 transition-[rotate] duration-(--duration-arrive) ease-spring motion-reduce:transition-none",
                    rest && "rotate-180",
                  )}
                />
              </button>
              {rest && (
                <dl className="grid gap-2 pt-1 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0">
                  {others.map(([status, , label, detail]) => {
                    const listed = report.entries.filter((entry) => entry.status === status);
                    const more = counts[status] - listed.length;
                    // An entry that waits says for how long; the others are named only.
                    const named = listed.map((entry) => {
                      const wait = detail?.(entry, titleOf) ?? null;
                      return wait === null ? entry.title : `${entry.title}, ${wait}`;
                    });
                    return (
                      <div key={status} className="grid gap-0.5">
                        <dt className="text-meta text-reed">{label}</dt>
                        <dd className="text-pretty text-ink text-note">
                          {named.join(detail === undefined ? ", " : "; ")}
                          {more > 0 &&
                            `${detail === undefined ? "," : ";"} and ${formatCount(more)} more`}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
