import { ART_LOOK_IDS } from "@ephemera/core";
import { type CSSProperties, useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { oneOf } from "@/lib/one-of.ts";
import type { ArtLookChoice } from "./art-slice.ts";

/**
 * Each look's copy and its swatch: the colour rendition its capture brings,
 * a two-stop gradient in content colours, the same in every theme. Auto's
 * swatch is drawn from the others' first stops.
 */
const LOOKS: Record<
  ArtLookChoice,
  { name: string; description: string; swatch: readonly [string, string] | null }
> = {
  auto: { name: "Auto", description: "Fits the card's era and person", swatch: null },
  snapshot: {
    name: "Snapshot",
    description: "Amateur candid, raw and true to life",
    swatch: ["#E6DFD3", "#7F909E"],
  },
  selfie: {
    name: "Mirror selfie",
    description: "Her own phone, full length in the glass",
    swatch: ["#F0CDB8", "#6F83AE"],
  },
  film: {
    name: "Vintage film",
    description: "35mm colour film, 1950s to 1990s",
    swatch: ["#E3A646", "#3B7880"],
  },
  digital: {
    name: "2000s digital",
    description: "Early compact digital camera",
    swatch: ["#EEF6FF", "#2A72CC"],
  },
  monochrome: {
    name: "Black and white",
    description: "Black and white film, before the 1950s",
    swatch: ["#EFEFEF", "#3A3A3A"],
  },
};

const CHOICES: readonly ArtLookChoice[] = ["auto", ...ART_LOOK_IDS];

const isChoice = oneOf(CHOICES);

/** Auto: a conic of every look's first stop, one equal sector each. */
const SECTOR = 360 / ART_LOOK_IDS.length;
const AUTO_FILL = `conic-gradient(${ART_LOOK_IDS.map((id, index) => {
  const from = LOOKS[id].swatch?.[0] ?? "transparent";
  return `${from} ${index * SECTOR}deg ${(index + 1) * SECTOR}deg`;
}).join(", ")})`;

function fill(look: ArtLookChoice): CSSProperties {
  const swatch = LOOKS[look].swatch;
  return {
    backgroundImage:
      swatch === null ? AUTO_FILL : `linear-gradient(135deg, ${swatch[0]}, ${swatch[1]})`,
  };
}

function Swatch({ look, className }: { look: ArtLookChoice; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={fill(look)}
      className={cn(
        "size-3.5 shrink-0 rounded-[4px] ring-1 ring-rush ring-inset in-data-disabled:opacity-50",
        className,
      )}
    />
  );
}

/**
 * The look of the next batch, a quiet row shared by Describe, the showcase
 * and the saved-character studio; Auto lets the image prompt's model choose.
 */
export function LookChoice({
  value,
  onChange,
  disabled = false,
  labelClassName,
  className,
}: {
  value: ArtLookChoice;
  onChange: (value: ArtLookChoice) => void;
  disabled?: boolean;
  labelClassName: string;
  /** The trigger's width in its host. */
  className?: string;
}) {
  const label = useId();
  return (
    <>
      <span id={label} className={labelClassName}>
        Look
      </span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (isChoice(next)) onChange(next);
        }}
      >
        <SelectTrigger
          aria-labelledby={label}
          placeholder="Auto"
          className={cn("pl-2.5", className)}
        >
          <span
            key={value}
            className="flex min-w-0 flex-1 items-center gap-2 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            <Swatch look={value} />
            <span className="min-w-0 truncate">{LOOKS[value].name}</span>
          </span>
        </SelectTrigger>
        <SelectContent label="Looks" className="min-w-80">
          {CHOICES.map((choice) => (
            <SelectItem
              key={choice}
              value={choice}
              description={LOOKS[choice].description}
              className="relative pl-8.5"
            >
              <Swatch look={choice} className="absolute top-2.25 left-3" />
              {LOOKS[choice].name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
