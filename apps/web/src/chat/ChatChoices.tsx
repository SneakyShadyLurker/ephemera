import { useId } from "react";
import { PersonaSelect } from "../personas/PersonaSelect.tsx";
import { COMPACT_LABEL } from "../sheet/fields.ts";
import { SamplerPresetSelect } from "./SessionPanel.tsx";

/**
 * Under the composer, the chat's persona and sampler preset as two quiet
 * labelled choices: each opens the list Session offers and saves through
 * the same setting, so a switch is the choice and the option. Session keeps
 * both, with their notes. The label is in reed, the value in ink; a long
 * value truncates before the line wraps.
 */
export function ChatChoices() {
  const personaLabel = useId();
  const samplerLabel = useId();
  return (
    // One fixed row reserves both hit plates before their values arrive.
    <div className="grid h-11 min-w-0 shrink-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 pl-1 text-note tablet:grid-cols-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span id={personaLabel} className={`max-tablet:sr-only shrink-0 ${COMPACT_LABEL}`}>
          Writing as
        </span>
        <PersonaSelect labelId={personaLabel} size="inline" />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span id={samplerLabel} className={`max-tablet:sr-only shrink-0 ${COMPACT_LABEL}`}>
          Sampler
        </span>
        <SamplerPresetSelect labelId={samplerLabel} />
      </div>
    </div>
  );
}
