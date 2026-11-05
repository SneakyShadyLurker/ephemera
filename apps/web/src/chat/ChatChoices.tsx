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
    // Two fixed touch rows on phones: arriving values never move the story.
    <div className="grid h-25 min-w-0 shrink-0 grid-rows-2 gap-3 pl-1 text-note tablet:flex tablet:h-11 tablet:items-center">
      <div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 tablet:flex tablet:flex-1">
        <span id={personaLabel} className={`shrink-0 ${COMPACT_LABEL}`}>
          Writing as
        </span>
        <PersonaSelect labelId={personaLabel} size="inline" />
      </div>
      <div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 tablet:flex tablet:flex-1">
        <span id={samplerLabel} className={`shrink-0 ${COMPACT_LABEL}`}>
          Sampler
        </span>
        <SamplerPresetSelect labelId={samplerLabel} />
      </div>
    </div>
  );
}
