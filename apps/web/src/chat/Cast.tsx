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
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { FADE, MotionScope } from "@/app/motion.tsx";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { BackIcon, CastIcon, CloseIcon, EditIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/text";
import { useContextWindow } from "../api.ts";
import { ageOf } from "../cast/age.ts";
import { useSettings } from "../settings/settings.ts";
import { currentRegister, keeperTargetUncovered, stale } from "./cast-slice.ts";
import {
  busyOf,
  CAST_TEXT_FIELDS,
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
import type { ChatState } from "./store.ts";

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

/** Field names: for assistive technology in reading mode, visible labels in edit mode. */
const LABELS: Record<TextField, string> = {
  age: "Age",
  ethnicity: "Ethnicity",
  skin: "Skin",
  face: "Face",
  experience: "Sexual experience",
  relationship: "Relationship",
  height: "Height",
  weight: "Weight",
  build: "Build",
  hair: "Hair",
  eyes: "Eyes",
  intimate: "Intimate body",
  personality: "Personality",
  fetishes: "Fetishes and taboos",
  outfit: "Outfit",
  disarray: "Clothing state",
  position: "Position",
  activity: "Activity",
  mood: "Mood",
  arousal: "Arousal",
  injuries: "Injuries",
  intoxication: "Intoxication",
};

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
const SECTION_LABEL = "font-medium font-sans text-meta text-reed";

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
 * How long the dusk wash lasts on what the newest snapshot changed: the
 * `--duration-wash` token (styles.css), which runs the animation.
 */
const WASH_MS = 1_200;

/**
 * The wash on a changed field, timed from when its snapshot landed, not from
 * when this element mounted: a field remounted (Presence moving to the next
 * reply, a record opened later) joins the fade where it is, or shows none
 * once it has run. Undefined for no wash.
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
  if (elapsed >= WASH_MS) return undefined;
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
  return stale(state) ? "As of the previous reply" : "";
}

/**
 * Fades in and out on `--duration-arrive`; reduced motion keeps the fade.
 * Each user brings its own MotionScope: the band, the float before the first
 * reply and the record surface sit outside the thread's.
 */
const FADING = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: FADE,
} as const;

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
  return (
    <span aria-live={live ? "polite" : undefined} className={cn(shown ? className : "sr-only")}>
      <MotionScope>
        <AnimatePresence initial={false}>
          {busy && (
            <m.span key="updating" data-cast-updating="" {...FADING}>
              Updating…
            </m.span>
          )}
        </AnimatePresence>
      </MotionScope>
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
            {...FADING}
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

/** A quiet sans line's control in dusk: Try again, Undo. */
const LINE_ACTION =
  "press relative text-dusk-line hover:text-ink after:absolute after:-inset-x-1 after:-inset-y-1.5 touch:after:-inset-y-3.5";

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

function Status({ className }: { className?: string }) {
  const waiting = useChat(sheetWaiting);
  const waitingText = useWaitingText();
  const statusText = useChat(castStatusText);
  // Nothing has been asked while it waits, so no other line can be newer.
  const text = waiting ? waitingText : statusText;
  const failed = useChat((state) => state.cast.status === "failed" && keeperTargetUncovered(state));
  const unread = useChat(sheetUnread);
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 font-sans text-meta", className)}>
      <p data-cast-status="" aria-live="polite" className="text-reed">
        {/* Keyed by its words, so each new line fades in; the live region itself stays. */}
        <span key={text} className="change-arrive">
          {text}
        </span>
      </p>
      {(failed || unread) && (
        <button
          type="button"
          aria-label={
            failed ? "Try again to update the cast" : "Try again to read the cast from the card"
          }
          onClick={retry}
          className={LINE_ACTION}
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** What Remove from cast leaves where the entry was: her name, removed, and Undo. */
function RemovalLine({ removal }: { removal: CastRemoval }) {
  return (
    <span
      data-cast-removed=""
      className="flex flex-wrap items-baseline gap-x-2 py-0.5 font-sans text-meta touch:min-h-11 touch:items-center"
    >
      <span aria-live="polite" className="text-reed">
        {removal.name} removed.
      </span>
      <button
        type="button"
        data-cast-undo=""
        aria-label={`Undo removing ${removal.name}`}
        onClick={undoCastRemoval}
        className={LINE_ACTION}
      >
        Undo
      </button>
    </span>
  );
}

/**
 * "Cast", "Updating…" beside it while the cast updates, and under it a faint
 * hairline a light passes along while no record is open. The
 * band's measured row says Updating without showing it, unless reduced
 * motion leaves the words alone to show it.
 */
function Heading({ passing, band }: { passing: boolean; band: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div className="grid gap-1">
      <p className="flex flex-wrap items-baseline gap-x-2 font-sans text-meta text-reed">
        Cast
        <Updating shown={!band || reduced} live />
      </p>
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
}: {
  entry: CastEntry;
  line: boolean;
  row: boolean;
  open: boolean;
  wash: { key: string; style: CSSProperties } | undefined;
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
        row ? "-mx-1 px-1 whitespace-nowrap" : "-mx-1.5 w-[calc(100%+0.75rem)] px-1.5",
      )}
    >
      {/* The open entry's hairline: in the float's margin, under the name in the band's row. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute rounded-full bg-dusk transition-opacity duration-(--duration-quick) ease-fade",
          row ? "inset-x-1 bottom-0 h-0.5 touch:bottom-1.5" : "inset-y-1 -left-1.5 w-0.5",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="break-words font-semibold text-ink text-ui">
        {entry.anchor.name}
        {age !== "" && <span className="font-normal text-reed"> ({age})</span>}
      </span>
      {text !== "" && (
        <span
          key={wash?.key ?? "still"}
          data-cast-changed={wash === undefined ? undefined : ""}
          style={wash?.style}
          className="line-clamp-2 @chat-roomy/chat:line-clamp-3 justify-self-start rounded-sm text-narration text-note transition-colors duration-(--duration-quick) ease-fade group-hover:text-ink"
        >
          {text}
        </span>
      )}
    </button>
  );
}

/** A wrapped summary keeps its chevron level with the first line. */
const SUMMARY =
  "flex w-fit cursor-default list-none items-start gap-1 py-0.5 text-note text-reed transition-colors duration-(--duration-quick) ease-fade hover:text-ink touch:min-h-11 touch:py-[0.8125rem] [&::-webkit-details-marker]:hidden";

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
export function CastPanel({ placement }: { placement: "float" | "band" }) {
  const visible = useCastVisible();
  const register = useChat(discoveredRegister);
  const busy = useChat(busyOf);
  const openId = useCastSurface((state) => (state.open ? state.entryId : null));
  const change = useChat(latestChange);
  const removal = useCastRemoval();
  const narrow = useFormFactor() === "tablet";
  const mountedAt = useMountedAt();
  if (!visible) return null;
  const listed = listedEntries(register);
  const { present, away } = split(listed);
  // While a record is open its surface's header carries the light instead.
  const passing = busy && !listed.some((entry) => entry.id === openId);
  const entry = (item: CastEntry, line: boolean, row = false) => (
    <Entry
      entry={item}
      line={line}
      row={row}
      open={item.id === openId}
      wash={washOf(change, item.id, ["activity", "mood"], mountedAt)}
    />
  );

  if (placement === "band") {
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
            className={cn(enter && "arrive")}
            style={enter ? { transitionDelay: `${index * 30}ms` } : undefined}
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
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The heading's width too: under reduced motion "Updating…" arrives and leaves in the row.
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
  const probe = `${present.map((item) => item.id).join()}|${away.length}|${removal?.entryId ?? ""}|${width}|${headingWidth}`;
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
                  className={"arrive max-w-full"}
                  style={{ transitionDelay: `${Math.min(index, ROSTER - 1) * 30}ms` }}
                >
                  {entry(item)}
                </li>
              ),
            )}
          </ul>
        )}
        {tail !== "" && (
          <button
            type="button"
            data-cast-tail=""
            aria-haspopup="dialog"
            aria-expanded={rosterOpen}
            onClick={(event) => openCast(null, event.currentTarget)}
            className="press -mx-1 whitespace-nowrap rounded-sm px-1 text-note text-reed hover:text-ink touch:min-h-11"
          >
            {tail}
          </button>
        )}
        {removal !== null && !removal.present && <RemovalLine removal={removal} />}
      </div>
      <Status />
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
      size="icon"
      aria-label="Show the cast"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => openCast(null, event.currentTarget)}
    >
      <CastIcon />
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
      ? "py-2.5 font-normal font-sans text-meta text-reed"
      : "py-1.5 font-semibold font-story text-ink text-lead",
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
    <DrawerClose render={<Button size="icon" aria-label="Close the cast" className="-mr-2" />}>
      <CloseIcon />
    </DrawerClose>
  );
}

const HEADER = "relative flex shrink-0 items-start gap-1 px-5 pt-3 pb-2";
const BODY = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5";

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
  return entryId === null ? (
    <RosterView heading={heading} drawer={drawer} />
  ) : (
    <RecordView key={entryId} entryId={entryId} heading={heading} drawer={drawer} />
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
          <span className="font-semibold text-ink text-ui">
            {entry.anchor.name}
            {age !== "" && <span className="font-normal text-reed"> ({age})</span>}
          </span>
          {line !== "" && (
            <span className="text-narration text-note transition-colors duration-(--duration-quick) ease-fade group-hover:text-ink">
              {line}
            </span>
          )}
        </button>
      </li>
    );
  };
  return (
    <>
      <header className={HEADER}>
        <Title drawer={drawer} heading={heading} quiet>
          Cast
        </Title>
        <SurfaceUpdating drawer={drawer} />
        {drawer && <CloseControl />}
      </header>
      <div className={cn(BODY, "grid content-start gap-3 font-story")}>
        {present.length > 0 && (
          <ul aria-label="Present" className="grid gap-1">
            {present.map(row)}
          </ul>
        )}
        {away.length > 0 && (
          <section aria-label="Away" className="grid gap-1">
            <p className="font-sans text-meta text-reed">Away</p>
            <ul className="grid gap-1">{away.map(row)}</ul>
          </section>
        )}
        <Status />
      </div>
    </>
  );
}

/**
 * One entry's record: its name and age as the title, Edit record, the
 * anchor as prose, then the state, and Remove from cast, which closes the
 * surface and leaves Undo in the roster.
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
  const entry = useChat((state) => discoveredRegister(state).entries.find((e) => e.id === entryId));
  const fromRoster = useCastSurface((state) => state.fromRoster);
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement>(null);
  // Back from edit mode, focus goes to Edit record before the surface finds its focused field
  // gone and takes focus itself.
  const returning = useRef(false);
  useLayoutEffect(() => {
    if (editing || !returning.current) return;
    returning.current = false;
    edit.current?.focus();
  }, [editing]);
  // Gone (a Clear, a deletion's undo): back to the roster.
  if (entry === undefined) return <RosterView heading={heading} drawer={drawer} />;
  const age = ageOf(entry);
  const done = () => {
    returning.current = true;
    setEditing(false);
  };

  return (
    <>
      <header className={HEADER}>
        {fromRoster && (
          <Button
            size="icon"
            aria-label="Back to the cast"
            onClick={() => showCastEntry(null)}
            className="-ml-2"
          >
            <BackIcon />
          </Button>
        )}
        <Title drawer={drawer} heading={heading}>
          {entry.anchor.name}
          {age !== "" && <span className="font-normal text-reed"> ({age})</span>}
        </Title>
        <SurfaceUpdating drawer={drawer} />
        {!editing && (
          <Button
            ref={edit}
            variant="quiet"
            size={drawer ? "icon" : "default"}
            aria-label={drawer ? "Edit record" : undefined}
            onClick={() => setEditing(true)}
            className={cn(!drawer && "-mr-2 gap-1.5 px-2")}
          >
            <EditIcon size={16} />
            {!drawer && "Edit record"}
          </Button>
        )}
        {drawer && <CloseControl />}
      </header>
      {editing ? (
        <EditRecord entry={entry} onDone={done} />
      ) : (
        <div className={BODY}>
          <RecordText entry={entry} />
          <Button
            variant="quiet"
            onClick={() => removeFromCast(entry)}
            className="mt-4 -ml-2 px-2 hover:text-ember"
          >
            Remove from cast
          </Button>
        </div>
      )}
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
      <button
        type="button"
        onClick={() => chatStore.getState().revertCast(entry.id, field)}
        className="press flex items-center font-sans text-meta text-reed transition-colors duration-(--duration-quick) ease-fade hover:text-ink touch:min-h-11"
      >
        Revert {LABELS[field].toLowerCase()}
      </button>
    </div>
  );
}

/**
 * The record in reading mode: its sections, each under a quiet heading and
 * only when it holds something. Now (Last seen, once away) leads with the
 * activity, set apart on a hairline frame; every other field is a labelled
 * row, and a phone too narrow for two columns sets each label over its value.
 */
export function RecordText({ entry }: { entry: CastEntry }) {
  const correction = useChat((state) => state.cast.corrections[entry.id]);
  const change = useChat(latestChange);
  const mountedAt = useMountedAt();
  const corrections = new Set<TextField>([
    ...(Object.keys(correction?.anchor ?? {}) as TextField[]),
    ...(Object.keys(correction?.state ?? {}) as TextField[]),
  ]);
  // A corrected field shows even when cleared, for its Revert. The title carries a bare age; a
  // fuller one reads here too.
  const shows = (field: TextField) => {
    const text = castFieldText(entry, field);
    if (corrections.has(field)) return true;
    return text !== "" && (field !== "age" || text.trim() !== ageOf(entry));
  };
  const value = (field: TextField) => (
    <>
      <Field
        entry={entry}
        field={field}
        corrected={corrections.has(field)}
        wash={washOf(change, entry.id, [field], mountedAt)}
      />
      {corrections.has(field) && <Revert entry={entry} field={field} />}
    </>
  );
  const sections = SECTIONS.flatMap(([title, fields], index) => {
    const shown = fields.filter(shows);
    if (shown.length === 0) return [];
    const now = index === 0;
    const lead = now && shown[0] === "activity";
    const rows = lead ? shown.slice(1) : shown;
    return (
      <section
        key={title}
        className={cn(
          "grid gap-2",
          now && "-mx-[calc(--spacing(3)+1px)] rounded-md border border-rush p-3",
        )}
      >
        <h3 className={SECTION_LABEL}>{now && !entry.state.present ? "Last seen" : title}</h3>
        {lead && (
          <div className="text-ink text-lead">
            <span className="sr-only">Activity: </span>
            {value("activity")}
          </div>
        )}
        {rows.length > 0 && (
          <dl className="grid grid-cols-1 gap-y-2 @[20rem]:grid-cols-[6.5rem_minmax(0,1fr)] @[20rem]:gap-x-3">
            {rows.map((field) => (
              <div key={field} className="col-span-full grid grid-cols-subgrid items-baseline">
                <dt className="font-sans text-meta text-reed">{LABELS[field]}</dt>
                <dd className="min-w-0 break-words text-narration text-ui">{value(field)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    );
  });
  return (
    <div className="@container grid gap-5 font-story">
      {sections.length > 0 ? (
        sections
      ) : (
        <p className="font-sans text-note text-reed">No other details recorded yet.</p>
      )}
    </div>
  );
}

/** The edit mode's values: every text field, as the record held them on entry. */
type Values = Record<TextField, string>;

const valuesOf = (entry: CastEntry): Values =>
  Object.fromEntries(
    CAST_TEXT_FIELDS.map((field) => [field, castFieldText(entry, field)]),
  ) as Values;

/**
 * The record in edit mode: every field labelled under the reading mode's sections,
 * the empty ones too, read once on entry, so a snapshot landing meanwhile
 * leaves the edit alone and only says so. Escape cancels without closing
 * the surface; Save writes the fields changed as the owner's corrections.
 */
export function EditRecord({ entry, onDone }: { entry: CastEntry; onDone: () => void }) {
  const [initial] = useState(() => valuesOf(entry));
  const [draft, setDraft] = useState(initial);
  const behind = CAST_TEXT_FIELDS.some((field) => castFieldText(entry, field) !== initial[field]);
  const save = () => {
    const anchor: Partial<CastAnchor> = {};
    const state: Partial<CastState> = {};
    for (const field of CAST_TEXT_FIELDS) {
      const value = draft[field].trim();
      if (value === initial[field]) continue;
      if (isAnchorField(field)) anchor[field] = value;
      else state[field] = value;
    }
    if (Object.keys(anchor).length > 0 || Object.keys(state).length > 0) {
      chatStore.getState().correctCast(entry.id, { anchor, state });
    }
    onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      // Cancels the edit before the surface would close.
      event.preventDefault();
      event.stopPropagation();
      onDone();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save();
  };
  return (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <div className={cn(BODY, "grid content-start gap-6")}>
        <div className="grid gap-1 font-sans">
          <p className="text-note text-reed">
            Looks and character hold for this chat. Current state yields to the next update.
          </p>
          {behind && (
            <p role="status" className="text-dusk-line text-meta">
              Updated behind this edit
            </p>
          )}
        </div>
        {SECTIONS.map(([legend, fields], group) => (
          <fieldset key={legend} className="grid gap-4">
            <legend className={cn("mb-2", SECTION_LABEL)}>{legend}</legend>
            {fields.map((field, index) => (
              <label key={field} className="grid gap-1">
                <span className="font-sans text-meta text-reed">{LABELS[field]}</span>
                <textarea
                  // biome-ignore lint/a11y/noAutofocus: edit mode opens because Edit record was chosen.
                  autoFocus={group === 0 && index === 0}
                  data-cast-field={field}
                  value={draft[field]}
                  maxLength={CAST_LIMITS.field}
                  rows={1}
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                  className="cast-field resize-none bg-transparent pb-1 font-story text-ink text-lead [field-sizing:content]"
                />
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-rush border-t px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </footer>
    </form>
  );
}
