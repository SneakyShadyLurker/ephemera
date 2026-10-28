import type { ContrastShortfall, PaletteRole } from "@ephemera/core";
import { useId, useState } from "react";
import { CautionIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { followAgain, setColour } from "./draft.ts";
import { ROLE_LABELS } from "./roles.ts";

const HEX = /^#?([0-9a-f]{6})$/i;

/** Why a role misses its floor, in words, naming the ground it is hard to read on. */
export function shortfallText({ ground, ratio, floor }: ContrastShortfall): string {
  const on = ground.wash ? `its wash on ${ROLE_LABELS[ground.role]}` : ROLE_LABELS[ground.role];
  return `Hard to read on ${on}: ${ratio.toFixed(1)}:1, aim for ${floor}:1.`;
}

/**
 * One colour of the palette being edited: a round swatch opening the
 * system colour picker, and its hex, which may be typed. A colour that
 * follows a key colour says so; one set by hand can follow again. A colour
 * under its contrast floor says so beneath it, as advice: it saves anyway.
 */
export function ColourField({
  id,
  role,
  value,
  shortfall,
  follows,
}: {
  id: string;
  role: PaletteRole;
  value: string;
  shortfall: ContrastShortfall | undefined;
  /** For a role under All colours: the key colour it follows, and whether it is set by hand. */
  follows?: { key: string; handSet: boolean };
}) {
  const hexId = useId();
  const noteId = useId();
  const statusId = useId();
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  const [malformed, setMalformed] = useState(false);
  // A colour changed elsewhere (a key colour, Start over, the scheme) replaces the typed text.
  if (value !== shown) {
    setShown(value);
    setText(value);
    setMalformed(false);
  }
  const label = ROLE_LABELS[role];
  const described = [shortfall && noteId, malformed && `${noteId}-hex`, follows && statusId]
    .filter(Boolean)
    .join(" ");

  return (
    <div id={id} className="grid min-w-0 gap-1 scroll-mt-24">
      <div className="flex min-w-0 items-center gap-3">
        <input
          type="color"
          value={value}
          aria-label={label}
          aria-describedby={described || undefined}
          onChange={(event) => setColour(role, event.target.value.toLowerCase())}
          className="colour-swatch"
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <label htmlFor={hexId} className="truncate text-ink text-ui">
            {label}
          </label>
          {follows && (
            <span id={statusId} className="flex items-center gap-2 text-meta text-reed">
              {follows.handSet ? (
                <>
                  <span>Set by you</span>
                  <button
                    type="button"
                    onClick={() => followAgain(role)}
                    className="rounded-sm text-dusk-line underline-offset-2 outline-none hover:underline focus-visible:underline touch:py-2"
                  >
                    Follow {follows.key} again
                  </button>
                </>
              ) : (
                `Follows ${follows.key}`
              )}
            </span>
          )}
        </div>
        <input
          id={hexId}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={`${label}, hex`}
          aria-invalid={malformed || undefined}
          onChange={(event) => {
            const typed = event.target.value;
            setText(typed);
            const match = HEX.exec(typed.trim());
            if (match?.[1] !== undefined) {
              setMalformed(false);
              setColour(role, `#${match[1].toLowerCase()}`);
            }
          }}
          onBlur={() => setMalformed(!HEX.test(text.trim()))}
          className={cn(
            "h-8 w-[5.75rem] shrink-0 rounded-md border border-transparent bg-transparent px-2 font-mono text-meta text-ink uppercase outline-none transition-[border-color,background-color] duration-(--duration-quick) ease-fade hover:border-rush focus:border-dusk-line focus:bg-canvas touch:h-11",
            malformed && "border-ember",
          )}
        />
      </div>
      {malformed && (
        <p id={`${noteId}-hex`} className="pl-11 text-meta text-ember touch:pl-14">
          Use six hex digits, like #3a2f28. The colour stays as it was until then.
        </p>
      )}
      {shortfall && (
        <p id={noteId} className="flex items-start gap-1.5 pl-11 text-meta text-ember touch:pl-14">
          <CautionIcon size={16} className="mt-px shrink-0" />
          {shortfallText(shortfall)}
        </p>
      )}
    </div>
  );
}
