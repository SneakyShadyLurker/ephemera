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
 * State 1: three equal choices on aligned tracks from tablet up (a reserved
 * art place of one height, the label on one line, one sentence), each a row
 * on phones; Brainstorm a quieter row under them across the column. Open
 * on the canvas: hover and focus tint the surface (the lamplight rim means
 * work in progress). Arrow keys move between all four; choosing one carries
 * its label into the next state.
 */
export function Choose() {
  const kind = useCreator((state) => state.kind);
  const choose = useCreator((state) => state.choose);
  const openBrainstorm = useCreator((state) => state.openBrainstorm);
  const group = useRef<HTMLFieldSetElement>(null);

  // Back from Change, focus returns to the choice the owner came from.
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
        className="grid gap-1 tablet:grid-cols-3 tablet:gap-x-3 tablet:gap-y-0"
      >
        <legend className="sr-only">What to create</legend>
        {(Object.keys(KINDS) as CreatorKind[]).map((option) => (
          <KindChoice
            key={option}
            kind={option}
            onChoose={() => inTransition(() => choose(option))}
          />
        ))}
        {/* Under a rule, a quieter row across the column. */}
        <div className="mt-4 border-rush border-t pt-2 tablet:col-span-3 tablet:mt-6">
          <button
            type="button"
            data-stage="brainstorm"
            onClick={() => inTransition(openBrainstorm)}
            className={cn(CHOICE, "flex w-full items-center gap-3 px-3 py-3")}
          >
            <IdeasIcon size={20} className="shrink-0 text-reed" />
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span
                className="w-fit font-semibold text-ink text-ui"
                style={{ viewTransitionName: kindTransition("brainstorm") }}
              >
                Brainstorm
              </span>
              <span className="text-pretty text-note text-reed">
                Ten ideas from a mood or a few words, for any of the three.
              </span>
            </span>
          </button>
        </div>
      </fieldset>
    </div>
  );
}

/** A choice's ground at rest and its surface tints on hover, focus and press. */
const CHOICE =
  "press rounded-lg text-left hover:bg-surface-hover focus-visible:bg-surface-hover active:bg-surface-pressed";

/**
 * One of the three: its art's place (reserved, one height in all three),
 * its label (which travels on) on one line, and a sentence; from tablet the
 * three share the column's row tracks, so the labels sit on one line.
 */
function KindChoice({ kind, onChoose }: { kind: CreatorKind; onChoose: () => void }) {
  const { label, sentence, Icon } = KINDS[kind];
  return (
    <button
      type="button"
      data-kind={kind}
      onClick={onChoose}
      className={cn(
        CHOICE,
        "group grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 p-3 tablet:row-span-3 tablet:grid-cols-1 tablet:grid-rows-subgrid tablet:items-start tablet:gap-y-0",
      )}
    >
      {/* The art's place: a quiet field holding the kind's own icon. */}
      <span
        aria-hidden="true"
        data-art=""
        className="grid aspect-[2/3] place-items-center rounded-md bg-surface text-reed transition-colors duration-(--duration-tint) ease-fade group-hover:bg-surface-selected group-hover:text-ink group-focus-visible:bg-surface-selected group-focus-visible:text-ink max-tablet:row-span-2 tablet:aspect-auto tablet:h-44"
      >
        <Icon size={24} />
      </span>
      <span
        data-title=""
        className="w-fit font-semibold text-heading text-ink tablet:mt-4 tablet:whitespace-nowrap"
        style={{ viewTransitionName: kindTransition(kind) }}
      >
        {label}
      </span>
      <span className="text-pretty text-note text-reed tablet:mt-1.5">{sentence}</span>
    </button>
  );
}
