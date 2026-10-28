import { type ReactNode, type RefObject, type SVGProps, useEffect, useRef } from "react";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { cn } from "@/lib/cn";

/**
 * Ephemera's own icon set. Drawn on a 24-unit grid inside a 2-22 live area,
 * outlines with round caps and joins; Stop and More are the solid exceptions.
 * The stroke is compensated per display size so the drawn line stays optically
 * even: 1.5px at 16, 1.75px at 20 and 24, 2px at 32. Each size is set in rem
 * through its class, so icons grow with the text on large displays; the
 * width and height attributes are the fallback.
 */
type IconSize = 16 | 20 | 24 | 32;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "strokeWidth"> {
  size?: IconSize;
}

const STROKE_PX: Record<IconSize, number> = { 16: 1.5, 20: 1.75, 24: 1.75, 32: 2 };
const SIZE_CLASS: Record<IconSize, string> = {
  16: "size-4",
  20: "size-5",
  24: "size-6",
  32: "size-8",
};

function icon(name: string, paths: ReactNode) {
  function Icon({ size = 20, className, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={(STROKE_PX[size] * 24) / size}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        data-icon={name}
        className={cn(SIZE_CLASS[size], className)}
        {...props}
      >
        {paths}
      </svg>
    );
  }
  Icon.displayName = `${name}Icon`;
  return Icon;
}

/** An opening quotation mark: the story is dialogue. */
export const ChatIcon = icon(
  "Chat",
  <>
    <path d="M10 6.5C7 8 5.25 10.5 5.25 14" />
    <circle cx="7.75" cy="15.25" r="2.5" fill="currentColor" stroke="none" />
    <path d="M18.5 6.5c-3 1.5-4.75 4-4.75 7.5" />
    <circle cx="16.25" cy="15.25" r="2.5" fill="currentColor" stroke="none" />
  </>,
);

/** Two staggered portrait leaves; the front one holds a figure. */
export const CharactersIcon = icon(
  "Characters",
  <>
    <path d="M8.5 6.5v-1a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3" />
    <rect x="3.5" y="6.5" width="12" height="14" rx="2" />
    <circle cx="9.5" cy="11.5" r="2.25" />
    <path d="M6.25 17.75c.6-1.6 1.8-2.5 3.25-2.5s2.65.9 3.25 2.5" />
  </>,
);

/** One portrait leaf: who you are in the story. */
export const PersonaIcon = icon(
  "Persona",
  <>
    <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
    <circle cx="12" cy="10" r="2.5" />
    <path d="M8.5 16.75c.75-1.85 2-2.75 3.5-2.75s2.75.9 3.5 2.75" />
  </>,
);

/** An upright print of a scene: a low horizon with a sun-disc above it. */
export const SceneIcon = icon(
  "Scene",
  <>
    <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
    <circle cx="12" cy="10.25" r="2.25" />
    <path d="M5 16.25c2.25-1.5 4.6-2.25 7-2.25s4.75.75 7 2.25" />
  </>,
);

/** Ordered prompt blocks, the second indented to show order. */
export const PresetsIcon = icon(
  "Presets",
  <>
    <rect x="3.5" y="4" width="17" height="6" rx="2" />
    <rect x="7.5" y="14" width="13" height="6" rx="2" />
  </>,
);

/** Three adjustment tracks with their thumbs. */
export const SettingsIcon = icon(
  "Settings",
  <>
    <path d="M4 6h8.5M17.5 6H20M4 12h1.5M10.5 12H20M4 18h6M15 18h5" />
    <circle cx="15" cy="6" r="2.25" />
    <circle cx="8" cy="12" r="2.25" />
    <circle cx="12.5" cy="18" r="2.25" />
  </>,
);

/** A lantern: the one lamp lit for this sitting, wherever its panel opens. */
export const SessionIcon = icon(
  "Session",
  <>
    <circle cx="12" cy="4.25" r="1.5" />
    <path d="M7.5 7h9M6.75 19.5h10.5M8.5 7l-.75 12.5M15.5 7l.75 12.5" />
    <path d="M12 10.5c-1 1.15-1.5 2.1-1.5 2.9a1.5 1.5 0 0 0 3 0c0-.8-.5-1.75-1.5-2.9Z" />
  </>,
);

/** Lines of the prompt read through a lens: the prompt inspector. */
export const InspectIcon = icon(
  "Inspect",
  <>
    <path d="M3.5 5.5h11M3.5 10h5.5M3.5 14.5h4M3.5 19h6" />
    <circle cx="15.5" cy="14" r="4" />
    <path d="m18.5 17 2.75 2.75" />
  </>,
);

export const CloseIcon = icon("Close", <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);

export const MoreIcon = icon(
  "More",
  <g fill="currentColor" stroke="none">
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </g>,
);

export const ChevronDownIcon = icon("ChevronDown", <path d="M6.5 9.5 12 15l5.5-5.5" />);

export const ChevronUpIcon = icon("ChevronUp", <path d="M6.5 14.5 12 9l5.5 5.5" />);

export const CheckIcon = icon("Check", <path d="M5 12.75 9.5 17 19 7.25" />);

/** An edit on its way to being saved: an open ring, which the check replaces once it is. */
export const SavingIcon = icon("Saving", <circle cx="12" cy="12" r="6.25" />);

/** A colour that may be hard to read: advice, never an error. */
export const CautionIcon = icon(
  "Caution",
  <>
    <path d="M10.3 4.9a2 2 0 0 1 3.4 0l7.1 12.4a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3Z" />
    <path d="M12 9.75v4M12 17h.01" />
  </>,
);

/** Down to the newest line of the story. */
/** Down to the newest line, above the waterline. */
export const LatestIcon = icon("Latest", <path d="M6.5 9.5 12 15l5.5-5.5M5 19.5h14" />);

export const StopIcon = icon(
  "Stop",
  <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
);

/** A script leaf struck through: the whole chat goes. */
export const ClearIcon = icon(
  "Clear",
  <>
    <path d="M17.5 10.5V6a2.5 2.5 0 0 0-2.5-2.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h3.5" />
    <path d="M9 8h5.5M9 11.5h3M14.5 14.5l5 5M19.5 14.5l-5 5" />
  </>,
);

/** The theme icons share a waterline: sun, moon, or both halves of the sky. */
export const SunIcon = icon(
  "Sun",
  <>
    <circle cx="12" cy="11.5" r="3.5" />
    <path d="M12 3.5v1.5M6.2 5.7l1.05 1.05M17.8 5.7l-1.05 1.05M3.75 11.5h1.5M18.75 11.5h1.5M4 19.5h16" />
  </>,
);

export const MoonIcon = icon(
  "Moon",
  <path d="M16.75 13.25A6 6 0 1 1 10.75 5.5a4.75 4.75 0 0 0 6 7.75ZM4 19.5h16" />,
);

/** Half day, half night: follow the system. */
export const SystemIcon = icon(
  "System",
  <>
    <circle cx="12" cy="11" r="5.25" />
    <path d="M12 5.75a5.25 5.25 0 0 1 0 10.5Z" fill="currentColor" stroke="none" />
    <path d="M4 19.5h16" />
  </>,
);

interface MarkCut {
  /** The drawing box, in the mark's own units. */
  box: { x: number; y: number; size: number };
  crescent: string;
  lamp: { cx: number; cy: number; r: number };
  /** The crescent dissolving past the lamp, largest first. */
  trail: readonly { cx: number; cy: number; r: number }[];
}

/**
 * The favicon's small-size cut (`public/favicon.svg` draws the same shapes),
 * fitted to the set's 2-22 live area: a heavier crescent, a larger lamp and
 * one trailing dot, so the mark holds at interface sizes.
 */
const SMALL_CUT: MarkCut = {
  box: { x: -242, y: -252.5, size: 505 },
  crescent: "M120.36 -159.73A200 200 0 1 0 184.1 78.15A166.11 166.11 0 1 1 120.36 -159.73Z",
  lamp: { cx: 170.79, cy: -88.81, r: 50 },
  trail: [{ cx: 195.68, cy: 16.86, r: 24 }],
};

/** The brand's own cut (`brand/logo.svg` draws the same shapes), for the mark shown large. */
const FULL_CUT: MarkCut = {
  box: { x: -232.88, y: -238.39, size: 476.79 },
  crescent: "M131.21 -150.94A200 200 0 1 0 189.1 65.11A177.71 177.71 0 1 1 131.21 -150.94Z",
  lamp: { cx: 161.72, cy: -108.24, r: 36 },
  trail: [
    { cx: 191.98, cy: -44.85, r: 19 },
    { cx: 198.03, cy: 3.15, r: 13 },
    { cx: 194.59, cy: 40.71, r: 8 },
  ],
};

/** The mark is solid, so it also draws above the set's sizes: 44 in the rail's lockup, 96 alone on an empty screen. */
type MarkSize = IconSize | 44 | 96;
const MARK_SIZE_CLASS: Record<MarkSize, string> = { ...SIZE_CLASS, 44: "size-11", 96: "size-24" };
/** From here up the full cut's thin crescent and smallest dot hold. */
const FULL_CUT_FROM = 96;
/** How far the breathing halo reaches, in lamp radii. */
const HALO_REACH = 2.4;
/** How much faster the lamp breathes while a reply is written: styles.css `--breath-rest` over `--breath-writing`. */
function writingRate(): number {
  const root = getComputedStyle(document.documentElement);
  const seconds = (name: string) => Number.parseFloat(root.getPropertyValue(name));
  return seconds("--breath-rest") / seconds("--breath-writing");
}

/**
 * Where the lamp is in its breath, from 0 to 1, so the portrait's glow can
 * start in step with it; undefined while it holds still.
 */
export function lampPhase(): number | undefined {
  const [animation] = document.querySelector(".lamp-halo")?.getAnimations() ?? [];
  const progress = animation?.effect?.getComputedTiming().progress;
  return progress ?? undefined;
}

/**
 * Starts the CSS animations under `element` in step with the lamp each time
 * they become `active`, while the lamp breathes at the same rate, so the two
 * never beat against each other. Reduced motion leaves them as CSS holds them.
 */
export function useLampStep(element: RefObject<HTMLElement | null>, active: boolean): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const phase = lampPhase();
    if (!active || reduced || phase === undefined) return;
    for (const animation of element.current?.getAnimations({ subtree: true }) ?? []) {
      if (!(animation instanceof CSSAnimation)) continue;
      const duration = Number(animation.effect?.getComputedTiming().duration);
      if (Number.isFinite(duration)) animation.currentTime = phase * duration;
    }
  }, [element, active, reduced]);
}

/**
 * Ephemera's mark: a crescent dissolving beside one amber lamp. Solid, unlike
 * the set, in the small-size cut at interface sizes and the brand's full cut
 * when shown large. The crescent takes the text color; the lamp is always
 * dusk. A `breathing` mark, the one at the top of the
 * interface, keeps a halo behind its lamp that rises and settles at rest. The
 * halo is an HTML layer under the drawing rather than part of it, so its loop
 * runs on the compositor and never repaints the page. While a reply is
 * `writing` the same loop runs faster (styles.css `--breath-writing`); the rate
 * changes in place, so the breath never restarts or jumps.
 */
export function MarkIcon({
  size = 20,
  className,
  breathing = false,
  writing = false,
  ...props
}: Omit<IconProps, "size"> & { size?: MarkSize; breathing?: boolean; writing?: boolean }) {
  const halo = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    // None under reduced motion: the halo holds still. When the preference
    // lifts mid-reply, the loop comes back at rate 1, so this runs again.
    if (reduced) return;
    const rate = writing ? writingRate() : 1;
    for (const animation of halo.current?.getAnimations() ?? []) {
      animation.updatePlaybackRate(rate);
    }
  }, [writing, reduced]);
  const { box, crescent, lamp, trail } = size >= FULL_CUT_FROM ? FULL_CUT : SMALL_CUT;
  const inBox = (length: number) => `${(length / box.size) * 100}%`;
  const mark = (
    <svg
      viewBox={`${box.x} ${box.y} ${box.size} ${box.size}`}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon="Mark"
      className={cn(MARK_SIZE_CLASS[size], className)}
      {...props}
    >
      <path d={crescent} />
      <circle {...lamp} className="fill-dusk" />
      {trail.map((dot) => (
        <circle key={dot.cy} {...dot} />
      ))}
    </svg>
  );
  if (!breathing) return mark;
  return (
    <span className="relative isolate inline-grid shrink-0">
      <span
        ref={halo}
        aria-hidden="true"
        className="lamp-halo"
        style={{
          left: inBox(lamp.cx - box.x),
          top: inBox(lamp.cy - box.y),
          width: inBox(2 * lamp.r * HALO_REACH),
        }}
      />
      {mark}
    </span>
  );
}

/** A small flame over its lamp: something coming alive. Create with AI. */
export const LampFlameIcon = icon(
  "LampFlame",
  <>
    <path d="M12 3.5c-2.65 3-4 5.4-4 7.5a4 4 0 0 0 8 0c0-2.1-1.35-4.5-4-7.5Z" />
    <path d="M12 15v2.5M6.5 17.5h11M8.25 17.5c.55 1.9 1.9 3 3.75 3s3.2-1.1 3.75-3" />
  </>,
);

/** A figure in profile above its shoulders: a Subject, someone to meet. */
export const ProfileIcon = icon(
  "Profile",
  <>
    <path d="M9 15.25c-2.1-1.2-3.5-3.3-3.5-5.75A6 6 0 0 1 11.5 3.5c3 0 5.25 2.25 5.25 5.25l1.5 3.25-1.5.5V14a1.5 1.5 0 0 1-1.5 1.5h-1.5V17M9 15.25V17" />
    <path d="M4 20.5c.65-2.15 2.4-3.5 4.6-3.5h5.8c2.2 0 3.95 1.35 4.6 3.5" />
  </>,
);

/** Two figures, one a step behind the other: Multiple Subjects, a small cast. */
export const GroupIcon = icon(
  "Group",
  <>
    <circle cx="9" cy="9" r="3.25" />
    <path d="M3 20.5c.55-2.85 2.95-4.75 6-4.75s5.45 1.9 6 4.75" />
    <circle cx="16" cy="7.5" r="2.75" />
    <path d="M14 13.6c.6-.2 1.3-.35 2-.35 2.6 0 4.6 1.8 5.25 4.5" />
  </>,
);

/** A figure beside a playbill's names: the people in the story now. */
export const CastIcon = icon(
  "Cast",
  <>
    <circle cx="7.5" cy="9" r="2.75" />
    <path d="M3 18.5c.6-2.5 2.3-4 4.5-4s3.9 1.5 4.5 4" />
    <path d="M15 8h6M15 12h6M15 16h4" />
  </>,
);

/** An arched doorway onto the horizon, the sun on it, over the waterline: a Scenario, somewhere to go. */
export const DoorwayIcon = icon(
  "Doorway",
  <>
    <path d="M6.5 20.5v-11a5.5 5.5 0 0 1 11 0v11" />
    <path d="M6.5 15h11M10.5 15a1.5 1.5 0 0 1 3 0M3.5 20.5h17" />
  </>,
);

/** A lens over the page. */
export const SearchIcon = icon(
  "Search",
  <>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </>,
);

export const PlusIcon = icon("Plus", <path d="M12 5v14M5 12h14" />);

export const MinusIcon = icon("Minus", <path d="M5 12h14" />);

/**
 * Short-stemmed arrows for Move earlier and Move later, so chevrons keep one
 * meaning: open and close.
 */
export const MoveUpIcon = icon("MoveUp", <path d="M12 18.5v-12M7.25 11.25 12 6.5l4.75 4.75" />);

export const MoveDownIcon = icon("MoveDown", <path d="M12 5.5v12M7.25 12.75 12 17.5l4.75-4.75" />);

/** Two leaf corners hooked together: this persona goes with those characters. */
export const BindIcon = icon(
  "Bind",
  <>
    <path d="M10 7.5H7A3.5 3.5 0 0 0 3.5 11v2A3.5 3.5 0 0 0 7 16.5h3" />
    <path d="M14 7.5h3a3.5 3.5 0 0 1 3.5 3.5v2a3.5 3.5 0 0 1-3.5 3.5h-3" />
    <path d="M8.5 12h7" />
  </>,
);

/** A distribution over the waterline: how the next word is drawn. */
export const SamplerIcon = icon(
  "Sampler",
  <path d="M2.5 17c3.5 0 4.75-6 9.5-6s6 6 9.5 6M4 20.5h16" />,
);

/** An arrow enters a card leaf through its open top; distinct from Latest's waterline. */
export const ImportIcon = icon(
  "Import",
  <path d="M8.5 7H7.5A2 2 0 0 0 5.5 9v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1M12 2.5v11M8.75 10.25 12 13.5l3.25-3.25" />,
);

/** An arrow leaves a card leaf through its open top. */
export const ExportIcon = icon(
  "Export",
  <path d="M8.5 7H7.5A2 2 0 0 0 5.5 9v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1M12 13.5v-11M8.75 5.75 12 2.5l3.25 3.25" />,
);

/** A leaf and its copy behind it, lower right; the front one marked with a plus. */
export const DuplicateIcon = icon(
  "Duplicate",
  <>
    <path d="M15.5 7.5h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-1" />
    <rect x="4.5" y="3.5" width="11" height="14" rx="2" />
    <path d="M10 8v5M7.5 10.5h5" />
  </>,
);

export const DeleteIcon = icon(
  "Delete",
  <path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.85 12.1a2 2 0 0 0 2 1.9h5.3a2 2 0 0 0 2-1.9l.85-12.1M10 10.5v6M14 10.5v6" />,
);

export const TagIcon = icon(
  "Tag",
  <>
    <path d="M3.5 11.6V5.5a2 2 0 0 1 2-2h6.1a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8l-6.1 6.1a2 2 0 0 1-2.8 0L4.1 13a2 2 0 0 1-.6-1.4Z" />
    <circle cx="8.25" cy="8.25" r="1.5" />
  </>,
);

/** Three lines of falling length and the order they run in. */
export const SortIcon = icon(
  "Sort",
  <path d="M4 7h10M4 12h7M4 17h4M17.5 5v14M14.75 16.25 17.5 19l2.75-2.75" />,
);

/** Section marks down a page: the sheet's contents. */
export const SectionsIcon = icon(
  "Sections",
  <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01M8.5 6h11M8.5 12h8M8.5 18h10" />,
);

export const BackIcon = icon("Back", <path d="M14.5 6.5 9 12l5.5 5.5" />);

/** Chevrons step between alternates: one meaning, open and close aside, in each direction. */
export const PreviousIcon = icon("Previous", <path d="M14.5 6.5 9 12l5.5 5.5" />);

export const NextIcon = icon("Next", <path d="M9.5 6.5 15 12l-5.5 5.5" />);

/** The same line drawn again: a loop that lands back where it began. */
export const RegenerateIcon = icon(
  "Regenerate",
  <>
    <path d="M18.5 12a6.5 6.5 0 1 1-2.1-4.8" />
    <path d="M17 3.75v3.75h-3.75" />
  </>,
);

/** A quill nib over a line. */
export const EditIcon = icon(
  "Edit",
  <>
    <path d="M14.5 5.5 18.5 9.5 9.5 18.5H5.5v-4Z" />
    <path d="M12.5 7.5l4 4" />
  </>,
);

/** The quill writes on your side of the page: the model drafts your next line. */
export const WriteForMeIcon = icon(
  "WriteForMe",
  <>
    <path d="M20 4c-5.5.5-9.5 4.5-11 10.5l1.5 1.5C16.5 14.5 19.5 10 20 4Z" />
    <path d="M9 14.5 5.5 18M3.5 20.5h8" />
  </>,
);

export const UndoIcon = icon(
  "Undo",
  <>
    <path d="M9 7.5 5 11.5l4 4" />
    <path d="M5 11.5h9.5a4.5 4.5 0 0 1 0 9H12" />
  </>,
);

/** An open book with a ribbon: the character's lorebook. */
export const LorebookIcon = icon(
  "Lorebook",
  <>
    <path d="M12 6.75C10 5.25 7.5 4.5 4 4.5v13.25c3.5 0 6 .75 8 2.25 2-1.5 4.5-2.25 8-2.25V4.5c-3.5 0-6 .75-8 2.25Z" />
    <path d="M12 6.75V20" />
    <path d="M15.5 4.9v5.35l1.5-1.1 1.5 1.1V4.6" />
  </>,
);

/** A page with its corner turned down, as a reader keeps a place: the character's memory. */
export const MemoryIcon = icon(
  "Memory",
  <>
    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10" />
    <path d="M14 3.5 19 8.5h-4a1 1 0 0 1-1-1Z" />
    <path d="M8.5 12.5h7M8.5 16h4.5" />
  </>,
);

/*
 * Activation marks: how a lorebook entry goes in, one sign wherever it shows
 * (the entry list, the editor's choice, the library's counts). Shape carries
 * the meaning, never colour: they take the text's ink or reed, never the
 * amber lamp, and always stand beside their words or number, so they are
 * decorative to assistive technology.
 */

/** A filled dot: always in. */
export const AlwaysMarkIcon = icon(
  "AlwaysMark",
  <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />,
);

/** A small key: in when its keywords match. */
export const KeywordsMarkIcon = icon(
  "KeywordsMark",
  <>
    <circle cx="8" cy="12" r="3.75" />
    <path d="M11.75 12h8.75M17.5 12v3M20.5 12v2.25" />
  </>,
);

/** A broken ring: in by chance. A fixed sign; the percentage is always written beside it. */
export const ChanceMarkIcon = icon("ChanceMark", <path d="M12 4.5a7.5 7.5 0 1 1-7.5 7.5" />);

/** The chance arc's stroke at its one size, 28px: the set's 1.75px compensated to 2px. */
const ARC_STROKE = (2 * 24) / 28;

/**
 * A trigger chance drawn to scale, 28px beside the percent field it
 * supplements: an ink arc from the top, clockwise, over a rush track that
 * carries no meaning (forced colors leave the track out). `lively` lets it
 * glide on the spring to a new length after the owner's own edit; mounting,
 * loading or another entry never animates it, and under reduced motion the
 * length changes at once.
 */
export function ChanceArc({
  chance,
  lively,
  className,
}: {
  chance: number;
  lively: boolean;
  className?: string;
}) {
  const length = Math.max(0, Math.min(100, chance));
  return (
    <svg
      viewBox="0 0 24 24"
      width={28}
      height={28}
      fill="none"
      stroke="currentColor"
      strokeWidth={ARC_STROKE}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      data-icon="ChanceArc"
      className={cn("size-7 shrink-0 -rotate-90", className)}
    >
      <circle cx="12" cy="12" r="8.5" className="text-rush forced-colors:hidden" />
      <circle
        cx="12"
        cy="12"
        r="8.5"
        pathLength={100}
        strokeDasharray="100 100"
        strokeDashoffset={100 - length}
        className={cn(
          "text-ink",
          lively &&
            "transition-[stroke-dashoffset] duration-(--duration-panel-in) ease-spring motion-reduce:transition-none",
        )}
      />
    </svg>
  );
}
