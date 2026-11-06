import {
  CAST_LIMITS,
  CAST_STATE_FIELDS,
  type CastAnchor,
  type CastAnchorField,
  type CastEntry,
  type CastState,
  castModelOf,
} from "@ephemera/core";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { fade, MotionScope } from "@/app/motion.tsx";
import { staggerStep } from "@/app/motion-tokens.ts";
import { InlineStatus } from "@/app/NoticeCard.tsx";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { BackIcon, CloseIcon, EditIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DisclosureChevron, SUMMARY_LINE } from "@/components/ui/disclosure";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { EditorBody, EditorFooter, EditorHeader } from "@/components/ui/editor-shell";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/text";
import { useContextWindow } from "../api.ts";
import { ageOf } from "../cast/age.ts";
import { useSettings } from "../settings/settings.ts";
import { COMPACT_LABEL, GROUP_HEADING, PROSE_FACE, PROSE_FIELD } from "../sheet/fields.ts";
import { InlineSave } from "../sheet/InlineSave.tsx";
import { baseBefore, currentRegister, keeperTargetUncovered, stale } from "./cast-slice.ts";
import {
  busyOf,
  CAST_FIELD_LABELS,
  type CastChange,
  type CastRemoval,
  type CastTextField,
  castFieldText,
  closeCast,
  discoveredRegister,
  latestChange,
  listedEntries,
  openCast,
  removeFromCast,
  sheetUnread,
  sheetWaiting,
  showCastEntry,
  toggleCast,
  undoCastRemoval,
  useCastRemoval,
  useCastSurface,
  useCastVisible,
} from "./cast-ui.ts";
import { chatStore, useChat } from "./session.ts";
import { type ChatState, shownReply } from "./store.ts";

/*
 * The cast panel: a compact roster under
 * the portrait, or across the phone's band, and each entry's record on a
 * surface of its own (a popover from tablet up, a drawer on phones), read
 * in labelled sections and corrected in an edit mode. Introduced women only, as
 * the owner chose, with discovered fields rather than hidden canon; the register
 * keeps everyone and their complete profiles for the narrator. Everything shown is chat
 * content read from the store; nothing here keeps a copy past its surface.
 */

type TextField = CastTextField;

/** Fields set in a tone, as the story's highlights are. */
const TONES: Partial<Record<TextField, "rose" | "sage" | "iris">> = {
  experience: "rose",
  fetishes: "rose",
  personality: "sage",
  intimate: "iris",
};

/**
 * The record's sections, in reading and edit mode alike: the state first, as
 * it changes with each reply (its activity the lead), then the anchor.
 */
const SECTIONS: readonly (readonly [string, readonly TextField[]])[] = [
  [
    "Now",
    ["activity", "mood", "outfit", "disarray", "position", "arousal", "injuries", "intoxication"],
  ],
  ["Looks", ["age", "ethnicity", "height", "weight", "build", "face", "skin", "hair", "eyes"]],
  ["Character", ["personality", "relationship"]],
  ["Intimate", ["experience", "intimate", "fetishes"]],
];

/** A section's quiet label: a heading in reading mode, a legend in edit mode. */
const SECTION_LABEL = cn(COMPACT_LABEL, "font-sans");

const isAnchorField = (field: TextField): field is CastAnchorField =>
  !(CAST_STATE_FIELDS as readonly string[]).includes(field);

/**
 * The roster's state line: how she feels, then what she is doing, so a line
 * cut short keeps the mood; where she was, once away.
 */
const stateLine = ({ state }: CastEntry): string => {
  if (!state.present) {
    const where = state.position || state.activity;
    return where === "" ? "" : `last seen: ${where}`;
  }
  return [state.mood, state.activity].filter((part) => part !== "").join(", ");
};

/** Present and away, in the register's order. */
function split(entries: CastEntry[]) {
  return {
    present: entries.filter((entry) => entry.state.present),
    away: entries.filter((entry) => !entry.state.present),
  };
}

/** "and Ana Pires away" or "and 3 away"; in a narrow column, "1 away". */
const awayText = (away: CastEntry[], narrow = false): string =>
  narrow
    ? `${formatCount(away.length)} away`
    : away.length === 1
      ? `and ${away[0]?.anchor.name} away`
      : `and ${formatCount(away.length)} away`;

/** At most this many present entries before "and 3 more". */
const ROSTER = 5;

// ---------------------------------------------------------------------------
// The changed signal.

/**
 * The wash on a changed field, timed from when its snapshot landed, not from
 * when this element mounted: a field remounted (Presence moving to the next
 * reply, a record opened later) joins the fade where it is, so one remounted
 * after the wash has run (styles.css `--duration-wash`) shows none.
 * Undefined for no wash.
 */
function washOf(
  change: CastChange | null,
  entryId: string,
  fields: readonly TextField[],
  mountedAt: number,
): { key: string; style: CSSProperties } | undefined {
  if (change === null) return undefined;
  const changed = change.fields.get(entryId);
  if (changed === undefined || !fields.some((field) => changed.has(field))) return undefined;
  const elapsed = Math.max(0, mountedAt - change.at);
  return { key: change.key, style: { animationDelay: `-${elapsed}ms` } };
}

/** When this element mounted: what a wash is timed against. */
const useMountedAt = (): number => useState(() => Date.now())[0];

// ---------------------------------------------------------------------------
// Status.

/** The status line's words; "" when there is nothing to say. An update says so beside "Cast". */
function castStatusText(state: ChatState): string {
  const { cast } = state;
  if (cast.status === "failed" && keeperTargetUncovered(state)) {
    if (cast.failure === "upstream_busy") return "Cast couldn't update: the cast model is busy.";
    return cast.failures >= 3 ? "Showing the last known cast." : "Cast couldn't update.";
  }
  if (cast.sheetStatus === "loading" && currentRegister(state).entries.length === 0) {
    return "Reading the card";
  }
  if (sheetUnread(state)) return "Couldn't read the cast from the card.";
  if (busyOf(state)) return "";
  return !state.generating && stale(state) ? "As of the previous reply" : "";
}

/**
 * A writing caption is justified only by the newest snapshot on the shown
 * branch, which baseBefore/registerAt use. Card/notebook seeds and hidden
 * alternates cannot establish scene freshness. Be conservative when the
 * displayed roster also contains entries not retained from that snapshot.
 */
function writingFromPreviousReply(state: ChatState): boolean {
  if (!state.generating || busyOf(state)) return false;
  const newest = state.messages.findLastIndex((message) => message.role === "assistant");
  for (let at = state.messages.length - 1; at >= 0; at--) {
    const message = state.messages[at];
    if (message?.role !== "assistant") continue;
    const snapshot = state.cast.snapshots[shownReply(message).id];
    if (snapshot === undefined) continue;
    if (at >= newest || snapshot.register !== baseBefore(state, state.messages.length))
      return false;
    const retained = new Set(
      snapshot.register.entries
        .filter((entry) => entry.introduced === true && !snapshot.seedOnly?.includes(entry.id))
        .map((entry) => entry.id),
    );
    const visible = listedEntries(discoveredRegister(state));
    return visible.length > 0 && visible.every((entry) => retained.has(entry.id));
  }
  return false;
}

/**
 * Fades in and out on `--duration-arrive`; reduced motion keeps the fade.
 * Each user brings its own MotionScope: the band, the float before the first
 * reply and the record surface sit outside the thread's.
 */
const fading = () => ({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: fade(),
});

/**
 * "Updating…" while the keeper works, polite to assistive technology where
 * `live`; said only, not shown, unless `shown`. Nothing without either.
 */
function Updating({
  shown,
  live,
  className,
}: {
  shown: boolean;
  live: boolean;
  className?: string;
}) {
  const busy = useChat(busyOf);
  if (!shown && !live) return null;
  const content = (
    <MotionScope>
      <AnimatePresence initial={false}>
        {busy && (
          <m.span key="updating" data-cast-updating="" {...fading()}>
            Updating…
          </m.span>
        )}
      </AnimatePresence>
    </MotionScope>
  );
  return shown ? (
    <InlineStatus
      as="span"
      role="presentation"
      aria-live={live ? "polite" : undefined}
      className={className}
    >
      {content}
    </InlineStatus>
  ) : (
    <span aria-live={live ? "polite" : undefined} className="sr-only">
      {content}
    </span>
  );
}

/**
 * The light that passes along the edge of what holds it while the keeper
 * works (styles.css `lamplight-edge`). Under reduced motion it is not drawn;
 * "Updating…" says it.
 */
function Pass({ on }: { on: boolean }) {
  return (
    <MotionScope>
      <AnimatePresence initial={false}>
        {on && (
          <m.span
            key="drift"
            aria-hidden="true"
            data-cast-drift=""
            {...fading()}
            className="pointer-events-none absolute inset-0"
          >
            <span className="lamplight-edge" />
          </m.span>
        )}
      </AnimatePresence>
    </MotionScope>
  );
}

const retry = () => chatStore.getState().retryCast();

function TryAgain({ failed, className }: { failed: boolean; className?: string }) {
  return (
    <Button
      variant="link"
      size="inline"
      aria-label={
        failed ? "Try again to update the cast" : "Try again to read the cast from the card"
      }
      onClick={retry}
      className={cn("text-meta", className)}
    >
      Try again
    </Button>
  );
}

function UndoRemoval({ removal, className }: { removal: CastRemoval; className?: string }) {
  return (
    <Button
      variant="link"
      size="inline"
      data-cast-undo=""
      aria-label={`Undo removing ${removal.name}`}
      onClick={undoCastRemoval}
      className={cn("text-meta", className)}
    >
      Undo
    </Button>
  );
}

/** The status line, polite to assistive technology, and Try again after a failure. */
/**
 * Why the card is not read yet, while the sheet waits (session.ts
 * `usableCastModel`): no cast model, its model list still coming, or a model
 * without a known context window.
 */
function useWaitingText(): string {
  const settings = useSettings();
  const model = castModelOf(settings);
  const window = useContextWindow(model, settings);
  if (model === null) return "Choose a model to load the cast.";
  if (window === "loading") return "Reading the card";
  return "Set a context window to load the cast.";
}

function Status({ className, live = true }: { className?: string; live?: boolean }) {
  const waiting = useChat(sheetWaiting);
  const waitingText = useWaitingText();
  const statusText = useChat(castStatusText);
  // Nothing has been asked while it waits, so no other line can be newer.
  const text = waiting ? waitingText : statusText;
  const failed = useChat((state) => state.cast.status === "failed" && keeperTargetUncovered(state));
  const unread = useChat(sheetUnread);
  return (
    <InlineStatus
      role="presentation"
      className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 font-sans text-meta", className)}
    >
      <p data-cast-status="" aria-live={live ? "polite" : undefined} className="text-reed">
        {text}
      </p>
      {(failed || unread) && <TryAgain failed={failed} />}
    </InlineStatus>
  );
}

/** What Remove from cast leaves where the entry was: her name, removed, and Undo. */
function RemovalLine({ removal }: { removal: CastRemoval }) {
  return (
    <InlineStatus
      as="span"
      role="presentation"
      data-cast-removed=""
      className="flex flex-wrap items-baseline gap-x-2 py-0.5 font-sans text-meta touch:min-h-11 touch:items-center"
    >
      <span aria-live="polite" className="text-reed">
        {removal.name} removed.
      </span>
      <UndoRemoval removal={removal} />
    </InlineStatus>
  );
}

/**
 * "Cast", "Updating…" beside it while the cast updates, and under it a faint
 * hairline a light passes along while no record is open. The
 * band's measured row says Updating without showing it, unless reduced
 * motion leaves the words alone to show it.
 */
function Heading({
  passing,
  band,
  statusSlot = false,
}: {
  passing: boolean;
  band: boolean;
  statusSlot?: boolean;
}) {
  const reduced = useReducedMotion();
  const surfaceOpen = useCastSurface((state) => state.open);
  const phone = useFormFactor() === "phone";
  const live = !(phone && surfaceOpen);
  return (
    <div className={cn("grid gap-1", band && reduced && !statusSlot && "touch:min-h-11")}>
      <p className="flex flex-wrap items-baseline gap-x-2 font-sans text-meta text-reed">
        Cast
        {!statusSlot && !(band && reduced) && <Updating shown={!band} live={live} />}
      </p>
      {band && reduced && !statusSlot && (
        <span className="grid">
          <span inert aria-hidden="true" className="invisible text-note [grid-area:1/1]">
            Updating…
          </span>
          <Updating shown live={live} className="[grid-area:1/1]" />
        </span>
      )}
      <span aria-hidden="true" className="relative h-px">
        <span
          className={cn(
            "absolute inset-0 bg-dusk/30 transition-opacity duration-(--duration-quick) ease-fade",
            !passing && "opacity-0",
          )}
        />
        <Pass on={passing} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The roster on the page.

/**
 * A roster entry: the name with the age aside and, in a roomy float, the
 * state line. In the band it sits in a row, its open hairline under the name.
 */
function Entry({
  entry,
  line,
  row,
  open,
  wash,
  stack = false,
}: {
  entry: CastEntry;
  line: boolean;
  row: boolean;
  open: boolean;
  wash: { key: string; style: CSSProperties } | undefined;
  stack?: boolean;
}) {
  const age = ageOf(entry);
  const text = line ? stateLine(entry) : "";
  return (
    <button
      type="button"
      data-cast-entry=""
      data-present={entry.state.present ? "true" : "false"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => toggleCast(entry.id, event.currentTarget)}
      className={cn(
        "group press relative grid rounded-sm py-0.5 text-left touch:min-h-11",
        // Room around the glyphs, so the focus ring never touches them; the names stay put.
        stack
          ? "w-full min-w-0 content-center px-1.5 touch:h-11"
          : row
            ? "-mx-1 px-1 whitespace-nowrap"
            : "-mx-1.5 w-[calc(100%+0.75rem)] px-1.5",
      )}
    >
      {/* The open entry's hairline: in the float's margin, under the name in the band's row. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute rounded-full bg-dusk transition-opacity duration-(--duration-quick) ease-fade",
          row
            ? "inset-x-1 bottom-0 h-0.5 touch:bottom-1.5"
            : stack
              ? "inset-y-1 left-0 w-0.5"
              : "inset-y-1 -left-1.5 w-0.5",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <span className={cn(GROUP_HEADING, "break-words", stack && "line-clamp-2")}>
        <span
          className={cn(
            "underline underline-offset-4",
            open
              ? "decoration-transparent"
              : "decoration-control-edge group-hover:decoration-current group-focus-visible:decoration-current",
          )}
        >
          {entry.anchor.name}
        </span>
        {age !== "" && <span className="font-normal text-reed"> ({age})</span>}
      </span>
      {text !== "" && (
        <span
          key={wash?.key ?? "still"}
          data-cast-changed={wash === undefined ? undefined : ""}
          style={wash?.style}
          className="line-clamp-2 @chat-roomy/chat:line-clamp-3 justify-self-start rounded-sm text-narration text-note transition-colors duration-(--duration-tint-quick) ease-fade group-hover:text-ink"
        >
          {text}
        </span>
      )}
    </button>
  );
}

/** A wrapped summary keeps its chevron level with the first line. */
const SUMMARY = cn(SUMMARY_LINE, "cursor-default items-start py-0.5 touch:py-[0.8125rem]");

/** A native disclosure under the roster: the rest of the present, or the away. */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary className={SUMMARY}>
        {summary}
        <DisclosureChevron className="mt-px" />
      </summary>
      {children}
    </details>
  );
}

/** Items with the removal line set where the removed entry was. */
function withRemoval<T>(
  items: T[],
  removal: CastRemoval | null,
  present: boolean,
): (T | CastRemoval)[] {
  if (removal === null || removal.present !== present) return items;
  const at = Math.min(removal.index, items.length);
  return [...items.slice(0, at), removal, ...items.slice(at)];
}

const isRemoval = (item: CastEntry | CastRemoval): item is CastRemoval => "name" in item;

/**
 * The roster on the page. In the float: "Cast", at most five present
 * entries (with their state lines where the column has room), the rest and
 * the away in disclosures, and the status line. On the phone's band: the
 * names wrapped over at most two lines, then "and 2 more" or "and 3 away".
 */
export function CastPanel({
  placement,
  portraitColumn,
}: {
  placement: "float" | "band";
  portraitColumn?: RefObject<HTMLDivElement | null>;
}) {
  const visible = useCastVisible();
  const register = useChat(discoveredRegister);
  const busy = useChat(busyOf);
  const openId = useCastSurface((state) => (state.open ? state.entryId : null));
  const surfaceOpen = useCastSurface((state) => state.open);
  const change = useChat(latestChange);
  const removal = useCastRemoval();
  const narrow = useFormFactor() === "tablet";
  const mountedAt = useMountedAt();
  if (!visible) return null;
  const listed = listedEntries(register);
  const { present, away } = split(listed);
  // The open surface carries this operation's one light, including at the full roster.
  const passing = busy && !surfaceOpen;
  const entry = (item: CastEntry, line: boolean, row = false, stack = false) => (
    <Entry
      entry={item}
      line={line}
      row={row}
      stack={stack}
      open={item.id === openId}
      wash={washOf(change, item.id, ["activity", "mood"], mountedAt)}
    />
  );

  if (placement === "band") {
    if (portraitColumn !== undefined) {
      return (
        <StackRoster
          present={present}
          away={away}
          removal={removal}
          passing={passing}
          portraitColumn={portraitColumn}
          entry={(item) => entry(item, false, false, true)}
        />
      );
    }
    return (
      <BandRoster
        present={present}
        away={away}
        removal={removal}
        passing={passing}
        entry={(item) => entry(item, false, true)}
      />
    );
  }

  const line = !narrow;
  const first = present.slice(0, ROSTER);
  const more = present.slice(ROSTER);
  const list = (items: (CastEntry | CastRemoval)[], label: string, enter: boolean) => (
    <ul aria-label={label} className="grid gap-1">
      {items.map((item, index) =>
        isRemoval(item) ? (
          <li key="removed">
            <RemovalLine removal={item} />
          </li>
        ) : (
          <li
            key={item.id}
            className={cn(enter && "arrive stagger")}
            style={enter ? staggerStep(index) : undefined}
          >
            {entry(item, line)}
          </li>
        ),
      )}
    </ul>
  );
  const shownFirst = withRemoval(first, removal, true);
  return (
    <div data-cast="" className="mt-4 grid gap-1.5 font-story">
      <Heading passing={passing} band={false} />
      {shownFirst.length > 0 && list(shownFirst, "Cast", true)}
      {more.length > 0 && (
        <Disclosure summary={`and ${formatCount(more.length)} more`}>
          {list(more, "More of the cast", false)}
        </Disclosure>
      )}
      {away.length > 0 && (
        <Disclosure summary={awayText(away, narrow)}>{list(away, "Away", false)}</Disclosure>
      )}
      {removal !== null && !removal.present && <RemovalLine removal={removal} />}
      <Status />
    </div>
  );
}

/** Names beside the reply portrait, fitted before paint to its measured column. */
function StackRoster({
  present,
  away,
  removal,
  passing,
  portraitColumn,
  entry,
}: {
  present: CastEntry[];
  away: CastEntry[];
  removal: CastRemoval | null;
  passing: boolean;
  portraitColumn: RefObject<HTMLDivElement | null>;
  entry: (item: CastEntry) => ReactNode;
}) {
  const rosterOpen = useCastSurface((state) => state.open && state.entryId === null);
  const failed = useChat((state) => state.cast.status === "failed" && keeperTargetUncovered(state));
  const unread = useChat(sheetUnread);
  const busy = useChat(busyOf);
  const waiting = useChat(sheetWaiting);
  const waitingText = useWaitingText();
  const statusText = useChat(castStatusText);
  const previousWhileWriting = useChat(writingFromPreviousReply);
  const reduced = useReducedMotion();
  const explanation = failed || unread ? statusText : waiting ? waitingText : statusText;
  const compact =
    explanation === "Cast couldn't update: the cast model is busy."
      ? "Cast model busy."
      : explanation === "Showing the last known cast."
        ? "Last known cast."
        : explanation === "Cast couldn't update."
          ? "Couldn't update."
          : explanation;
  const text =
    removal !== null
      ? `${removal.name} removed.`
      : failed || unread || waiting || explanation === "Reading the card"
        ? compact
        : busy
          ? "Updating…"
          : previousWhileWriting
            ? "As of the previous reply"
            : compact;
  const announcement =
    removal === null
      ? failed || unread
        ? explanation
        : previousWhileWriting && !waiting && !busy && removal === null
          ? ""
          : text
      : `${text}${failed || unread ? ` ${explanation}` : ""}`;
  const row = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const awayProbe = useRef<HTMLSpanElement>(null);
  const [dimensions, setDimensions] = useState("");
  useLayoutEffect(() => {
    const column = portraitColumn.current;
    const element = row.current;
    if (column === null || element === null) return;
    let fonts = 0;
    const measure = () => {
      setDimensions(
        `${column.getBoundingClientRect().height}|${element.getBoundingClientRect().width}|${fonts}`,
      );
    };
    const fontLoaded = () => {
      fonts = fonts + 1;
      measure();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", fontLoaded);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", fontLoaded);
    };
  }, [portraitColumn]);
  const tailOf = (count: number) =>
    present.length > count
      ? count === 0
        ? `Show all ${formatCount(present.length + away.length)}`
        : `and ${formatCount(present.length - count + away.length)} more`
      : away.length > 0
        ? awayText(away, true)
        : "";
  // Include every input to the fixed rows, as well as the clamped name rows.
  const probe = `${dimensions}|clamp:2|${present.map((item) => `${item.id}:${item.anchor.name}:${ageOf(item)}`).join()}|${away.map((item) => `${item.id}:${item.anchor.name}`).join()}|${tailOf(0)}|${tailOf(present.length)}|retry:${failed}:${unread}|undo:${removal?.entryId ?? ""}:${removal?.name ?? ""}|${text}`;
  const [fit, setFit] = useState({ probe: "", count: present.length, namedAway: false });
  const measuring = fit.probe !== probe;
  const count = measuring ? present.length : fit.count;
  // During the pre-paint measurement, also lay out the possible tail action.
  const tail =
    (!measuring && fit.namedAway ? awayText(away) : tailOf(count)) || (measuring ? tailOf(0) : "");
  useLayoutEffect(() => {
    if (!measuring) return;
    const element = row.current;
    const column = portraitColumn.current;
    if (element === null || column === null) return;
    const names = [...element.querySelectorAll<HTMLElement>("[data-cast-name]")];
    const budget = column.getBoundingClientRect().height;
    const gap = Number.parseFloat(getComputedStyle(element).rowGap) || 0;
    const heading = element.firstElementChild?.getBoundingClientRect().height ?? 0;
    const statusHeight = status.current?.getBoundingClientRect().height ?? 0;
    const actionHeight = actions.current?.getBoundingClientRect().height ?? 0;
    // Fixed parts first. Check each candidate with its own tail requirement,
    // including the all-names candidate that can dispense with the action row.
    let fitted = 0;
    let namesHeight = 0;
    for (let candidate = 1; candidate <= names.length; candidate++) {
      namesHeight += (names[candidate - 1]?.getBoundingClientRect().height ?? 0) + gap;
      const hasActions =
        candidate < present.length || away.length > 0 || failed || unread || removal !== null;
      if (
        heading + gap + statusHeight + namesHeight + (hasActions ? actionHeight + gap : 0) <=
        budget
      ) {
        fitted = candidate;
      }
    }
    // Fit names first. The away identity only uses the fixed action row's
    // remaining width, never a name slot or an additional line of height.
    let namedAway = false;
    const measureAway = awayProbe.current;
    const actionRow = actions.current;
    if (fitted === present.length && away.length === 1 && measureAway && actionRow) {
      const siblings = [...actionRow.children].filter(
        (child) => child instanceof HTMLElement && !child.hasAttribute("data-cast-tail"),
      );
      const spacing = Number.parseFloat(getComputedStyle(actionRow).columnGap) || 0;
      const available =
        actionRow.getBoundingClientRect().width -
        siblings.reduce((width, child) => width + child.getBoundingClientRect().width, 0) -
        spacing * siblings.length;
      measureAway.style.width = `${Math.max(0, available)}px`;
      const line = Number.parseFloat(getComputedStyle(measureAway).lineHeight);
      namedAway =
        available > 0 &&
        measureAway.scrollWidth <= available + 0.5 &&
        measureAway.getBoundingClientRect().height <= Math.min(2 * line, actionHeight) + 0.5;
    }
    setFit({ probe, count: fitted, namedAway });
  }, [measuring, probe, present.length, away.length, failed, unread, removal, portraitColumn]);
  const action =
    "self-stretch justify-start border-0 touch:min-w-8.5 after:inset-y-0 touch:after:inset-y-0 first:after:left-0 touch:first:after:left-0 scale-100! active:opacity-70 transition-opacity duration-(--duration-quick) ease-fade";
  return (
    <div
      ref={row}
      data-cast=""
      data-cast-stack=""
      className="relative grid content-start gap-1 font-story"
    >
      <Heading passing={passing} band statusSlot />
      <span
        ref={awayProbe}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden whitespace-normal text-note"
      >
        {awayText(away)}
      </span>
      {count > 0 && (
        <ul aria-label="Cast" className="grid gap-1">
          {present.slice(0, count).map((item, index) => (
            <li
              key={item.id}
              data-cast-name=""
              className="arrive stagger min-w-0"
              style={staggerStep(Math.min(index, ROSTER - 1))}
            >
              {entry(item)}
            </li>
          ))}
        </ul>
      )}
      {(tail !== "" || failed || unread || removal !== null) && (
        <div ref={actions} className="flex min-h-6 items-stretch gap-x-6 touch:h-11">
          {tail !== "" && (
            <Button
              variant="link"
              size="inline"
              data-cast-tail=""
              aria-haspopup="dialog"
              aria-expanded={rosterOpen}
              onClick={(event) => openCast(null, event.currentTarget)}
              className={cn(
                action,
                "min-w-0 shrink whitespace-normal text-left font-story text-note",
              )}
            >
              <span className="line-clamp-2">{tail}</span>
            </Button>
          )}
          {(failed || unread) && (
            <TryAgain
              failed={failed}
              className={cn(action, "shrink-0 whitespace-nowrap font-sans")}
            />
          )}
          {removal !== null && (
            <UndoRemoval
              removal={removal}
              className={cn(action, "shrink-0 whitespace-nowrap font-sans")}
            />
          )}
        </div>
      )}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      <div
        ref={status}
        aria-hidden="true"
        className={cn("min-w-0 font-sans text-meta text-reed", count > 0 ? "h-5" : "min-h-5")}
      >
        <MotionScope>
          <AnimatePresence initial={false} mode="wait">
            <m.p
              key={text}
              data-cast-status=""
              data-cast-updating={text === "Updating…" ? "" : undefined}
              data-cast-removed={removal !== null ? "" : undefined}
              {...fading()}
              transition={fade(reduced ? "--duration-quick" : "--duration-arrive")}
              className={cn(count > 0 ? "truncate" : "line-clamp-2", removal !== null && "flex")}
            >
              {removal !== null ? (
                <>
                  <span className="min-w-0 truncate">{removal.name}</span>
                  <span className="shrink-0 whitespace-pre"> removed.</span>
                </>
              ) : (
                text
              )}
            </m.p>
          </AnimatePresence>
        </MotionScope>
      </div>
    </div>
  );
}

/**
 * The band's roster: "Cast", then the names with their ages wrapped over at
 * most two lines, then "and 2 more" (those that would need a third, and the
 * away) or "and 3 away", which open the roster. Laid out in full, measured,
 * then cut; again whenever the names or the band's width change.
 */
function BandRoster({
  present,
  away,
  removal,
  passing,
  entry,
}: {
  present: CastEntry[];
  away: CastEntry[];
  removal: CastRemoval | null;
  passing: boolean;
  entry: (item: CastEntry) => ReactNode;
}) {
  const rosterOpen = useCastSurface((state) => state.open && state.entryId === null);
  const surfaceOpen = useCastSurface((state) => state.open);
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The heading's width too: reduced motion reserves the room for "Updating…".
  const [headingWidth, setHeadingWidth] = useState(0);
  useEffect(() => {
    const element = row.current;
    const heading = element?.firstElementChild;
    if (element == null || heading == null) return;
    const observer = new ResizeObserver((found) => {
      for (const { target, contentRect } of found) {
        (target === element ? setWidth : setHeadingWidth)(Math.round(contentRect.width));
      }
    });
    observer.observe(element);
    observer.observe(heading);
    return () => observer.disconnect();
  }, []);
  const probe = `${present.map((item) => `${item.id}:${item.anchor.name}:${ageOf(item)}`).join()}|${away.map((item) => item.anchor.name).join()}|${removal?.entryId ?? ""}:${removal?.name ?? ""}|${width}|${headingWidth}`;
  const [fit, setFit] = useState({ probe: "", count: present.length });
  const measuring = fit.probe !== probe;
  const count = measuring ? present.length : fit.count;
  useLayoutEffect(() => {
    if (!measuring) return;
    const element = row.current;
    if (element === null) return;
    const names = [...element.querySelectorAll<HTMLElement>("[data-cast-name]")];
    const tops = [...new Set(names.map((name) => name.offsetTop))].sort((a, b) => a - b);
    const second = tops[1] ?? tops[0] ?? 0;
    const tail = element.querySelector<HTMLElement>("[data-cast-tail]");
    const fits = tops.length <= 2 && (tail === null || tail.offsetTop <= second);
    if (fits) return setFit({ probe, count: present.length });
    // The most names that leave room for "and 2 more" on the second line.
    const room = Math.max(tail?.offsetWidth ?? 0, 80) + 16;
    const right = element.getBoundingClientRect().right;
    let count = names.filter((name) => name.offsetTop <= second).length;
    while (count > 1) {
      const last = names[count - 1];
      if (last === undefined || last.offsetTop < second) break;
      if (right - last.getBoundingClientRect().right >= room) break;
      count--;
    }
    setFit({ probe, count: Math.max(1, count) });
  }, [measuring, probe, present.length]);

  const hidden = present.length - count;
  const tail =
    hidden > 0
      ? `and ${formatCount(hidden + away.length)} more`
      : away.length > 0
        ? awayText(away)
        : "";
  const items = withRemoval(present.slice(0, count), removal, true);
  return (
    <div data-cast="" className="mt-3 grid">
      <div ref={row} className="flex flex-wrap items-baseline gap-x-4 font-story">
        <Heading passing={passing} band />
        {items.length > 0 && (
          <ul aria-label="Cast" className="contents">
            {items.map((item, index) =>
              isRemoval(item) ? (
                <li key="removed">
                  <RemovalLine removal={item} />
                </li>
              ) : (
                <li
                  key={item.id}
                  data-cast-name=""
                  className="arrive stagger max-w-full"
                  style={staggerStep(Math.min(index, ROSTER - 1))}
                >
                  {entry(item)}
                </li>
              ),
            )}
          </ul>
        )}
        {tail !== "" && (
          <Button
            variant="link"
            size="inline"
            data-cast-tail=""
            aria-haspopup="dialog"
            aria-expanded={rosterOpen}
            onClick={(event) => openCast(null, event.currentTarget)}
          >
            {tail}
          </Button>
        )}
        {removal !== null && !removal.present && <RemovalLine removal={removal} />}
      </div>
      <Status live={!surfaceOpen} />
    </div>
  );
}

/**
 * The phone header's quiet control: the record surface at the roster. It
 * holds still while the cast updates: the hairline under the roster's
 * heading carries that.
 */
export function CastHeaderControl() {
  const visible = useCastVisible();
  const open = useCastSurface((state) => state.open && state.entryId === null);
  if (!visible) return null;
  return (
    <Button
      aria-label="Show the cast"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => openCast(null, event.currentTarget)}
      className="gap-1 px-2 touch:px-2"
    >
      Cast
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The record surface.

/** Focus after the surface closes: Undo on a removal's line, else what opened it. */
function focusAfterClose(anchor: HTMLElement | null): HTMLElement | false {
  const undo = [...document.querySelectorAll<HTMLElement>("[data-cast] [data-cast-undo]")].find(
    (control) => control.checkVisibility(),
  );
  if (undo !== undefined) return undo;
  return anchor?.isConnected === true ? anchor : false;
}

/**
 * The one record surface of the chat: on tablet and desktop a non-modal
 * popover beside the roster entry that opened it (never over the portrait),
 * or above the control that opened it; the keyboard-aware drawer on phones.
 * Opening focuses its heading, never a field; closing returns focus to what
 * opened it. A Clear closes it.
 */
export function CastSurface() {
  const phone = useFormFactor() === "phone";
  const open = useCastSurface((state) => state.open);
  const anchor = useCastSurface((state) => state.anchor);
  const side = useCastSurface((state) => state.side);
  const heading = useRef<HTMLHeadingElement>(null);
  const finalFocus = () => focusAfterClose(anchor);

  if (phone) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) closeCast();
        }}
        keyboardAware
        showSwipeHandle
      >
        <DrawerContent initialFocus={heading} finalFocus={finalFocus}>
          <SurfaceBody heading={heading} drawer />
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        // A press on the control that opened it toggles it there instead.
        const target = details.event.target;
        if (
          details.reason === "outside-press" &&
          target instanceof Node &&
          anchor?.contains(target)
        ) {
          return;
        }
        closeCast();
      }}
    >
      <PopoverContent
        anchor={anchor}
        // Beside a roster entry, from its top; beside a menu's control, rising from its foot, so
        // neither covers the portrait or the roster above it. Else below, else above.
        side="inline-end"
        align={side === "inline-end" ? "start" : "end"}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
        // Its values are controls now, laid over the composer's: a layer of its own.
        positionMethod="fixed"
        initialFocus={heading}
        finalFocus={finalFocus}
        className="max-h-[min(40rem,80dvh,var(--available-height))] w-[26rem] max-w-[calc(100vw-2rem)] p-0"
      >
        <SurfaceBody heading={heading} drawer={false} />
      </PopoverContent>
    </Popover>
  );
}

/** The surface's title, as its primitive names it: the popover's or the drawer's. */
function Title({
  drawer,
  heading,
  quiet = false,
  children,
}: {
  drawer: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  /** The roster's "Cast", in the float label's quiet voice; a record's title is the name. */
  quiet?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    "min-w-0 flex-1 break-words outline-none",
    quiet
      ? "font-semibold font-sans text-ink text-lead"
      : "font-semibold font-story text-ink text-lead",
  );
  return drawer ? (
    <DrawerTitle ref={heading} tabIndex={-1} className={className}>
      {children}
    </DrawerTitle>
  ) : (
    <PopoverTitle ref={heading} tabIndex={-1} className={className}>
      {children}
    </PopoverTitle>
  );
}

function CloseControl() {
  return (
    <DrawerClose render={<Button size="icon" aria-label="Close the cast" />}>
      <CloseIcon />
    </DrawerClose>
  );
}

/**
 * The surface header's part while the cast updates: "Updating…" after the
 * title, and the light passing along the header's lower edge. The drawer, modal,
 * says it; beside the popover the panel already does.
 */
function SurfaceUpdating({ drawer }: { drawer: boolean }) {
  const busy = useChat(busyOf);
  return (
    <>
      <Updating
        shown
        live={drawer}
        className="self-center whitespace-nowrap px-1 font-sans text-meta text-reed"
      />
      <Pass on={busy} />
    </>
  );
}

function SurfaceBody({
  heading,
  drawer,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  drawer: boolean;
}) {
  const entryId = useCastSurface((state) => state.entryId);
  return (
    <>
      {entryId === null ? (
        <RosterView heading={heading} drawer={drawer} />
      ) : (
        <RecordView key={entryId} entryId={entryId} heading={heading} drawer={drawer} />
      )}
    </>
  );
}

/** The surface at the roster: everyone listed, present then away, each opening her record. */
function RosterView({
  heading,
  drawer,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  drawer: boolean;
}) {
  const register = useChat(discoveredRegister);
  const { present, away } = split(listedEntries(register));
  const row = (entry: CastEntry) => {
    const age = ageOf(entry);
    const line = stateLine(entry);
    return (
      <li key={entry.id}>
        <button
          type="button"
          onClick={() => showCastEntry(entry.id)}
          className="group press -mx-1.5 grid w-[calc(100%+0.75rem)] rounded-sm px-1.5 py-1 text-left touch:min-h-11"
        >
          <span className={GROUP_HEADING}>
            {entry.anchor.name}
            {age !== "" && <span className="font-normal text-reed"> ({age})</span>}
          </span>
          {line !== "" && (
            <span className="text-narration text-note transition-colors duration-(--duration-tint-quick) ease-fade group-hover:text-ink">
              {line}
            </span>
          )}
        </button>
      </li>
    );
  };
  return (
    <>
      <EditorHeader
        title={
          <Title drawer={drawer} heading={heading} quiet>
            Cast
          </Title>
        }
        actions={<SurfaceUpdating drawer={drawer} />}
        close={
          drawer ? (
            <CloseControl />
          ) : (
            <Button size="icon" aria-label="Close the cast" onClick={closeCast}>
              <CloseIcon />
            </Button>
          )
        }
      />
      <EditorBody className="grid content-start gap-3 font-story pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {present.length > 0 && (
          <ul aria-label="Present" className="grid gap-1">
            {present.map((entry) =>
              drawer ? (
                <li key={entry.id} className="grid gap-3 border-rush border-b pb-4">
                  <h3 className={GROUP_HEADING}>
                    {entry.anchor.name}
                    {ageOf(entry) !== "" && (
                      <span className="font-normal text-reed"> ({ageOf(entry)})</span>
                    )}
                  </h3>
                  <RecordText entry={entry} />
                  <Button
                    variant="link"
                    className="justify-self-start"
                    onClick={() => removeFromCast(entry)}
                  >
                    Remove from cast
                  </Button>
                </li>
              ) : (
                row(entry)
              ),
            )}
          </ul>
        )}
        {away.length > 0 && (
          <section aria-label="Away" className="grid gap-1">
            <p className="font-sans text-meta text-reed">Away</p>
            <ul className="grid gap-1">
              {away.map((entry) =>
                drawer ? (
                  <li key={entry.id}>
                    <details className="disclosure">
                      <summary className={SUMMARY_LINE}>
                        {entry.anchor.name}
                        <DisclosureChevron />
                      </summary>
                      <div className="grid gap-3 pt-3">
                        <RecordText entry={entry} />
                        <Button
                          variant="link"
                          className="justify-self-start"
                          onClick={() => removeFromCast(entry)}
                        >
                          Remove from cast
                        </Button>
                      </div>
                    </details>
                  </li>
                ) : (
                  row(entry)
                ),
              )}
            </ul>
          </section>
        )}
        <Status />
      </EditorBody>
    </>
  );
}

/**
 * One entry's record: its name and age as the title, the record itself,
 * each detail corrected where it stands, then Remove from cast, which
 * closes the surface and leaves Undo in the roster.
 */
function RecordView({
  entryId,
  heading,
  drawer,
}: {
  entryId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  drawer: boolean;
}) {
  const live = useChat((state) => discoveredRegister(state).entries.find((e) => e.id === entryId));
  const open = useCastSurface((state) => state.open);
  // The primitive retains this component during its exit. Keep the last record
  // for that exit too; the live roster and Undo still update immediately.
  const [last, setLast] = useState(live);
  if (live !== undefined && live !== last) setLast(live);
  const entry = live ?? (open ? undefined : last);
  const fromRoster = useCastSurface((state) => state.fromRoster);
  // Gone (a Clear, a deletion's undo): back to the roster.
  if (entry === undefined) return <RosterView heading={heading} drawer={drawer} />;
  const age = ageOf(entry);

  return (
    <>
      <EditorHeader
        back={
          fromRoster && (
            <Button
              size="icon"
              aria-label="Back to the cast"
              onClick={() => showCastEntry(null)}
              className="-ml-2"
            >
              <BackIcon />
            </Button>
          )
        }
        title={
          <Title drawer={drawer} heading={heading}>
            {entry.anchor.name}
            {age !== "" && <span className="font-normal text-reed"> ({age})</span>}
          </Title>
        }
        actions={<SurfaceUpdating drawer={drawer} />}
        close={
          drawer ? (
            <CloseControl />
          ) : (
            <Button size="icon" aria-label="Close the cast" onClick={closeCast}>
              <CloseIcon />
            </Button>
          )
        }
      />
      <EditorBody>
        <RecordText entry={entry} />
      </EditorBody>
      <EditorFooter>
        <Button
          variant="quiet"
          onClick={() => removeFromCast(entry)}
          className="-ml-2 justify-self-start px-2 hover:text-ember"
        >
          Remove from cast
        </Button>
      </EditorFooter>
    </>
  );
}

/**
 * Personality keywords, each its own highlight, when the field reads as a
 * short list (two to eight pieces of at most three words, none led by a
 * conjunction: "shy, but warms up" or "loyal, if guarded" is a phrase); else
 * null, and it reads as written.
 */
function keywordsOf(text: string): string[] | null {
  const parts = text
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const listed = parts.every(
    (part) =>
      part.split(/\s+/).length <= 3 &&
      !/^(and|or|but|yet|so|if|when|unless|though|although|except)\b/i.test(part),
  );
  return parts.length >= 2 && parts.length <= 8 && listed ? parts : null;
}

/** One field in reading mode: its tone, its correction's hairline, its wash. */
function Field({
  entry,
  field,
  corrected,
  wash,
}: {
  entry: CastEntry;
  field: TextField;
  corrected: boolean;
  wash: { key: string; style: CSSProperties } | undefined;
}) {
  const tone = TONES[field];
  const text = castFieldText(entry, field);
  const keywords = field === "personality" ? keywordsOf(text) : null;
  const marks = {
    "data-cast-field": field,
    "data-cast-corrected": corrected ? "" : undefined,
    "data-cast-changed": wash === undefined ? undefined : "",
  };
  return keywords === null ? (
    <span
      key={wash?.key ?? "still"}
      {...marks}
      data-tone={tone}
      style={wash?.style}
      className={cn(tone !== undefined && "tone-wash")}
    >
      {text}
    </span>
  ) : (
    <span
      key={wash?.key ?? "still"}
      {...marks}
      style={wash?.style}
      className="flex flex-wrap gap-x-2 gap-y-1"
    >
      {keywords.map((word, at) => {
        // Keyed by the word and its occurrence (a list may repeat one), as sheet/TokenField.tsx
        // does; the hidden comma keeps the words apart when read aloud or copied.
        const occurrence = keywords.slice(0, at).filter((other) => other === word).length;
        return (
          <span key={`${occurrence}:${word}`} data-tone={tone} className="tone-wash">
            {at > 0 && <span className="sr-only">, </span>}
            {word}
          </span>
        );
      })}
    </span>
  );
}

/** Revert, under the corrected field: a quiet line taking it back to the recorded value. */
function Revert({ entry, field }: { entry: CastEntry; field: TextField }) {
  return (
    <div className="mt-1 grid justify-items-start">
      <Button
        variant="link"
        size="inline"
        onClick={() => chatStore.getState().revertCast(entry.id, field)}
        className="font-sans text-meta"
      >
        Revert {CAST_FIELD_LABELS[field].toLowerCase()}
      </Button>
    </div>
  );
}

/**
 * The record: its sections, each under a quiet heading and only when it
 * holds something. Now (Last seen, once away) leads with the activity, set
 * apart on a hairline frame; every other field is a labelled row, and a
 * phone too narrow for two columns sets each label over its value. Every
 * value is corrected where it stands (EditableValue); the details not
 * recorded wait under "More details", to be written there.
 */
export function RecordText({ entry }: { entry: CastEntry }) {
  const record = useRef<HTMLFieldSetElement>(null);
  const [editing, setEditing] = useState<{ field: TextField; recorded: boolean } | null>(null);
  const [saved, setSaved] = useState<TextField | null>(null);
  const refocus = useRef<TextField | null>(null);
  useLayoutEffect(() => {
    const field = refocus.current;
    if (field === null) return;
    refocus.current = null;
    const button = record.current?.querySelector<HTMLButtonElement>(`[data-cast-edit="${field}"]`);
    // A previously empty detail may now belong to a folded section.
    for (let parent = button?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      if (parent === record.current) break;
    }
    button?.focus({ preventScroll: true });
  });
  const correction = useChat((state) => state.cast.corrections[entry.id]);
  const change = useChat(latestChange);
  const mountedAt = useMountedAt();
  const corrections = new Set<TextField>([
    ...(Object.keys(correction?.anchor ?? {}) as TextField[]),
    ...(Object.keys(correction?.state ?? {}) as TextField[]),
  ]);
  // A corrected field shows even when cleared, for its Revert. The title carries a bare age; a
  // fuller one reads here too.
  const recorded = (field: TextField) => {
    const text = castFieldText(entry, field);
    if (corrections.has(field)) return true;
    return text !== "" && (field !== "age" || text.trim() !== ageOf(entry));
  };
  // Keep a field in its current section while its draft is open, even if a keeper update lands.
  const shows = (field: TextField) =>
    editing?.field === field ? editing.recorded : recorded(field);
  const editor = (field: TextField, children: ReactNode) => (
    <EditableValue
      entry={entry}
      field={field}
      saved={saved === field}
      onStart={() => {
        setSaved(null);
        setEditing({ field, recorded: recorded(field) });
      }}
      onFinish={(changed, keepFocus) => {
        setSaved(changed ? field : null);
        refocus.current = keepFocus ? field : null;
        setEditing(null);
      }}
    >
      {children}
    </EditableValue>
  );
  const value = (field: TextField) => (
    <>
      {editor(
        field,
        <Field
          entry={entry}
          field={field}
          corrected={corrections.has(field)}
          wash={washOf(change, entry.id, [field], mountedAt)}
        />,
      )}
      {corrections.has(field) && <Revert entry={entry} field={field} />}
    </>
  );
  const sections = SECTIONS.flatMap(([title, fields], index) => {
    const shown = fields.filter(shows);
    if (shown.length === 0) return [];
    const now = index === 0;
    const lead = now && shown[0] === "activity";
    const rows = lead ? shown.slice(1) : shown;
    const content = (
      <section
        key={title}
        className={cn(
          "grid gap-2",
          now && "-mx-[calc(--spacing(3)+1px)] rounded-md border border-rush p-3",
        )}
      >
        <h3 className={SECTION_LABEL}>{now && !entry.state.present ? "Last seen" : title}</h3>
        {lead && <div className="text-ink text-lead">{value("activity")}</div>}
        {rows.length > 0 && (
          <dl className="grid grid-cols-1 gap-y-1 @[20rem]:grid-cols-[5.5rem_minmax(0,1fr)] @[20rem]:gap-x-2">
            {rows.map((field) => (
              <div
                key={field}
                className={cn(
                  "col-span-full grid grid-cols-subgrid items-baseline",
                  editing?.field === field && "@max-[28rem]:grid-cols-1",
                )}
              >
                <dt className="font-sans text-meta text-reed">{CAST_FIELD_LABELS[field]}</dt>
                <dd className="min-w-0 break-words text-narration text-ui">{value(field)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    );
    return title === "Looks" || title === "Intimate" ? (
      <details key={title} className="disclosure">
        <summary className={cn(SUMMARY_LINE, "font-sans")}>
          {title}
          <DisclosureChevron />
        </summary>
        <div className="pt-2">{content}</div>
      </details>
    ) : (
      content
    );
  });
  const unrecorded = SECTIONS.flatMap(([, fields]) => fields.filter((field) => !shows(field)));
  return (
    <fieldset
      ref={record}
      aria-label={`${entry.anchor.name} record`}
      className="@container grid min-w-0 gap-3 font-story"
    >
      {sections.length > 0 ? (
        sections
      ) : (
        <p className="font-sans text-note text-reed">No other details recorded yet.</p>
      )}
      {unrecorded.length > 0 && (
        <details className="disclosure font-sans">
          <summary className={SUMMARY_LINE}>
            More details
            <DisclosureChevron />
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-y-2 font-story @[20rem]:grid-cols-[6.5rem_minmax(0,1fr)] @[20rem]:gap-x-3">
            {unrecorded.map((field) => (
              <div
                key={field}
                className={cn(
                  "col-span-full grid grid-cols-subgrid items-baseline",
                  editing?.field === field && "@max-[28rem]:grid-cols-1",
                )}
              >
                <dt className="font-sans text-meta text-reed">{CAST_FIELD_LABELS[field]}</dt>
                <dd className="min-w-0 break-words text-narration text-ui">
                  {editor(field, <span className="font-sans text-note text-reed">Add</span>)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <p className="font-sans text-note text-reed">
        Corrections to looks and character hold for this chat; the current state yields to the next
        update.
      </p>
    </fieldset>
  );
}

/**
 * A recorded value, corrected where it stands: at rest the value as the
 * record shows it, on the open prose face (a wash and edge under a pointer,
 * a hairline on touch); pressed, the same words in a field. Enter or
 * leaving the field saves a change as the owner's correction (its Revert
 * takes it back); Escape keeps the record as it was, without closing the
 * surface. A snapshot landing meanwhile leaves the edit alone and says so.
 */
function EditableValue({
  entry,
  field,
  saved,
  onStart,
  onFinish,
  children,
}: {
  entry: CastEntry;
  field: TextField;
  saved: boolean;
  onStart: () => void;
  onFinish: (changed: boolean, keepFocus: boolean) => void;
  children: ReactNode;
}) {
  const label = CAST_FIELD_LABELS[field];
  const current = castFieldText(entry, field);
  const [draft, setDraft] = useState<{ initial: string; text: string } | null>(null);
  const settled = useRef(false);

  if (draft === null) {
    return (
      <>
        <button
          type="button"
          data-cast-edit={field}
          onClick={() => {
            settled.current = false;
            onStart();
            setDraft({ initial: current, text: current });
          }}
          className={EDITABLE_AT_REST}
        >
          <EditIcon size={16} className="pointer-events-none absolute top-2 right-2 text-reed" />
          <span className="sr-only">Correct {label.toLowerCase()}: </span>
          {children}
        </button>
        {saved && <InlineSave status={{ kind: "saved" }} noun="cast record" />}
      </>
    );
  }

  const finish = (save: boolean, keepFocus: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const value = draft.text.trim();
    const changed = save && value !== draft.initial;
    if (changed) {
      chatStore
        .getState()
        .correctCast(
          entry.id,
          isAnchorField(field)
            ? { anchor: { [field]: value } as Partial<CastAnchor> }
            : { state: { [field]: value } as Partial<CastState> },
        );
    }
    setDraft(null);
    onFinish(changed, keepFocus);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      finish(true, true);
    } else if (event.key === "Escape") {
      // Cancels the correction before the surface would close.
      event.preventDefault();
      event.stopPropagation();
      finish(false, true);
    }
  };
  return (
    <span className="grid gap-1">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the field opens because its value was pressed.
        autoFocus
        aria-label={label}
        data-cast-field={field}
        value={draft.text}
        maxLength={CAST_LIMITS.field}
        rows={1}
        autoComplete="off"
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onBlur={() => finish(true, false)}
        onKeyDown={onKeyDown}
        className={cn(PROSE_FIELD, "-mx-2 w-[calc(100%+1rem)] text-ink")}
      />
      <Button
        variant="outline"
        className="hidden justify-self-start font-sans touch:inline-flex"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => finish(true, true)}
      >
        Done
      </Button>
      {current !== draft.initial && (
        <InlineStatus as="span" role="status" className="font-sans text-meta">
          Updated behind this edit
        </InlineStatus>
      )}
    </span>
  );
}

/** A value at rest: the prose field's open face, so it reads as something to correct. */
const EDITABLE_AT_REST = cn(
  PROSE_FACE,
  "relative -mx-2 block w-[calc(100%+1rem)] pr-8 text-left touch:min-h-11",
);
