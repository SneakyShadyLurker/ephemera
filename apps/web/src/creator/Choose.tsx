import type { CreatorKind } from "@ephemera/core";
import { type ComponentType, type KeyboardEvent, useEffect, useRef } from "react";
import { DoorwayIcon, GroupIcon, type IconProps, ProfileIcon } from "@/components/icons";
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

/**
 * State 1: three panels, side by side from tablet up and filling the column,
 * padded so the longest label, Multiple Subjects, stays on one line.
 * Arrow keys move between them; choosing one carries its label into the
 * describe state.
 */
export function Choose() {
  const kind = useCreator((state) => state.kind);
  const choose = useCreator((state) => state.choose);
  const group = useRef<HTMLFieldSetElement>(null);

  // Back from Change, focus returns to the kind that was chosen.
  useEffect(() => {
    if (kind !== null) group.current?.querySelector<HTMLElement>(`[data-kind="${kind}"]`)?.focus();
  }, [kind]);

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (step === undefined) return;
    const panels = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-kind]")];
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
      </fieldset>
    </div>
  );
}

function KindPanel({ kind, onChoose }: { kind: CreatorKind; onChoose: () => void }) {
  const { label, sentence, Icon } = KINDS[kind];
  return (
    <button
      type="button"
      data-kind={kind}
      onClick={onChoose}
      className="group grid items-center gap-4 rounded-lg border border-rush bg-surface p-4 text-left transition-[translate,scale,border-color] duration-(--duration-arrive) ease-spring hover:-translate-y-(--rise) hover:border-dusk-line focus-visible:-translate-y-(--rise) focus-visible:border-dusk-line active:scale-(--press-scale) max-tablet:min-h-22 max-tablet:grid-cols-[3rem_minmax(0,1fr)] tablet:min-h-72 tablet:grid-rows-[minmax(0,1fr)_auto]"
    >
      <span className="relative grid place-items-center text-narration">
        {/* A faint lamp glow warms the drawing from below on hover and focus. */}
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-1/2 aspect-square w-24 -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--dusk)_30%,transparent),transparent)] opacity-0 transition-opacity duration-(--duration-panel-in) ease-fade group-hover:opacity-100 group-focus-visible:opacity-100 max-tablet:w-16"
        />
        <Icon size={32} className="relative" />
      </span>
      <span className="grid gap-1.5">
        <span
          className="w-fit font-semibold text-heading text-ink"
          style={{ viewTransitionName: kindTransition(kind) }}
        >
          {label}
        </span>
        <span className="text-pretty text-note text-reed">{sentence}</span>
      </span>
    </button>
  );
}
