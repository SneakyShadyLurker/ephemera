import type { CreatorKind } from "@ephemera/core";
import { type ComponentType, type KeyboardEvent, useEffect, useRef } from "react";
import { DoorwayIcon, GroupIcon, type IconProps, IdeasIcon, ProfileIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useCreator } from "./session.ts";
import { inTransition, kindTransition } from "./transition.ts";

/** The column the description field will occupy: the choice and the field share its left edge. */
export const COLUMN = "mx-auto w-full max-w-column px-5 tablet:px-6";

export const KINDS: Record<
  CreatorKind,
  { label: string; sentence: string; Icon: ComponentType<IconProps> }
> = {
  subject: {
    label: "Subject",
    sentence: "One person, with a history, a body, a mind and a voice.",
    Icon: ProfileIcon,
  },
  group: {
    label: "Multiple Subjects",
    sentence: "Two or three people, each with a history, a body, a mind and a voice.",
    Icon: GroupIcon,
  },
  scenario: {
    label: "Scenario",
    sentence: "A world to step into, with its people, its rules and its tone.",
    Icon: DoorwayIcon,
  },
};

/** Set by the brainstorm's Change, so the choice focuses the Brainstorm panel; presentation only. */
let fromBrainstorm = false;

/** The brainstorm's Change: back to the choice, focus on Brainstorm. */
export function leaveBrainstorm(change: () => void) {
  fromBrainstorm = true;
  inTransition(change);
}

/**
 * State 1: three panels, side by side from tablet up and filling the column,
 * padded so the longest label, Multiple Subjects, stays on one line, and
 * Brainstorm under them across the column in the panels' row form.
 * Arrow keys move between all four; choosing one carries its label into the
 * next state.
 */
export function Choose() {
  const kind = useCreator((state) => state.kind);
  const choose = useCreator((state) => state.choose);
  const openBrainstorm = useCreator((state) => state.openBrainstorm);
  const group = useRef<HTMLFieldSetElement>(null);

  // Back from Change, focus returns to the panel the owner came from.
  useEffect(() => {
    const target = fromBrainstorm ? '[data-stage="brainstorm"]' : `[data-kind="${kind}"]`;
    if (fromBrainstorm || kind !== null) group.current?.querySelector<HTMLElement>(target)?.focus();
    fromBrainstorm = false;
  }, [kind]);

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (step === undefined) return;
    const panels = [...event.currentTarget.querySelectorAll<HTMLElement>("button")];
    const active = document.activeElement;
    const at = active instanceof HTMLElement ? panels.indexOf(active) : -1;
    if (at === -1) return;
    event.preventDefault();
    panels[(at + step + panels.length) % panels.length]?.focus();
  };

  return (
    <div className={`${COLUMN} pt-6 pb-16 tablet:pt-10`}>
      <fieldset
        ref={group}
        onKeyDown={onKeyDown}
        className="grid gap-3 tablet:grid-cols-3 tablet:gap-5"
      >
        <legend className="sr-only">What to create</legend>
        {(Object.keys(KINDS) as CreatorKind[]).map((option) => (
          <KindPanel
            key={option}
            kind={option}
            onChoose={() => inTransition(() => choose(option))}
          />
        ))}
        <Panel
          label="Brainstorm"
          sentence="Ten ideas from a mood or a few words, for any of the three."
          Icon={IdeasIcon}
          transition={kindTransition("brainstorm")}
          data-stage="brainstorm"
          onClick={() => inTransition(openBrainstorm)}
          className="min-h-22 grid-cols-[3rem_minmax(0,1fr)] tablet:col-span-3"
          glow="w-16"
        />
      </fieldset>
    </div>
  );
}

function KindPanel({ kind, onChoose }: { kind: CreatorKind; onChoose: () => void }) {
  const { label, sentence, Icon } = KINDS[kind];
  return (
    <Panel
      label={label}
      sentence={sentence}
      Icon={Icon}
      transition={kindTransition(kind)}
      data-kind={kind}
      onClick={onChoose}
      className="max-tablet:min-h-22 max-tablet:grid-cols-[3rem_minmax(0,1fr)] tablet:min-h-72 tablet:grid-rows-[minmax(0,1fr)_auto]"
      glow="w-24 max-tablet:w-16"
    />
  );
}

/** One panel: its drawing over a faint glow, its label (which travels on), and a sentence. */
function Panel({
  label,
  sentence,
  Icon,
  transition,
  onClick,
  className,
  glow,
  ...data
}: {
  label: string;
  sentence: string;
  Icon: ComponentType<IconProps>;
  /** The label's shared-element name into the next state. */
  transition: string;
  onClick: () => void;
  /** The panel's form: a column from tablet up, or a row. */
  className: string;
  /** The glow's size, as the drawing's place allows. */
  glow: string;
  "data-kind"?: string;
  "data-stage"?: string;
}) {
  return (
    <button
      type="button"
      {...data}
      onClick={onClick}
      className={cn(
        "group grid items-center gap-4 rounded-lg border border-rush bg-surface p-4 text-left transition-[translate,scale,border-color] duration-(--duration-arrive) ease-spring hover:-translate-y-(--rise) hover:border-dusk-line focus-visible:-translate-y-(--rise) focus-visible:border-dusk-line active:scale-(--press-scale)",
        className,
      )}
    >
      <span className="relative grid place-items-center text-narration">
        {/* A faint lamp glow warms the drawing from below on hover and focus. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 left-1/2 aspect-square -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--dusk)_30%,transparent),transparent)] opacity-0 transition-opacity duration-(--duration-panel-in) ease-fade group-hover:opacity-100 group-focus-visible:opacity-100",
            glow,
          )}
        />
        <Icon size={32} className="relative" />
      </span>
      <span className="grid gap-1.5">
        <span
          className="w-fit font-semibold text-heading text-ink"
          style={{ viewTransitionName: transition }}
        >
          {label}
        </span>
        <span className="text-pretty text-note text-reed">{sentence}</span>
      </span>
    </button>
  );
}
