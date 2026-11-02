import type { CreatorArtComposition } from "@ephemera/core";
import { useId } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** A quiet row shared by Describe, the showcase and the saved-character studio. */
export function CompositionChoice({
  value,
  onChange,
  disabled = false,
  labelClassName,
}: {
  value: CreatorArtComposition;
  onChange: (value: CreatorArtComposition) => void;
  disabled?: boolean;
  labelClassName: string;
}) {
  const label = useId();
  return (
    <>
      <span id={label} className={labelClassName}>
        Composition
      </span>
      <ToggleGroup
        aria-labelledby={label}
        value={[value]}
        disabled={disabled}
        className="w-fit"
        onValueChange={(values) => {
          const next = values[0];
          if (next === "regular" || next === "diptych") onChange(next);
        }}
      >
        <ToggleGroupItem value="regular" labelled>
          Regular
        </ToggleGroupItem>
        <ToggleGroupItem value="diptych" labelled>
          Diptych
        </ToggleGroupItem>
      </ToggleGroup>
    </>
  );
}
