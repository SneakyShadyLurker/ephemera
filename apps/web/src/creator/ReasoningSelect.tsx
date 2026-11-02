import { effortFor, offeredEfforts, REASONING_EFFORTS, type ReasoningEffort } from "@ephemera/core";
import { staggerStep } from "@/app/motion-tokens.ts";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { useModelInfo } from "../api.ts";
import { REASONING_LABELS } from "../presets/queries.ts";

/** Bars lit for each effort, on a scale of six; the model default lights none of its own. */
const LIT: Record<ReasoningEffort, number> = {
  "provider-default": 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};
const BARS = [0, 1, 2, 3, 4, 5] as const;

/**
 * The efforts `model` offers, and the one to send: the owner's pick when the
 * model offers it, else the model default, as an unlisted model follows the
 * saved one.
 */
export function useEffortChoice(model: string | null, chosen: ReasoningEffort) {
  const info = useModelInfo(model);
  const offered = offeredEfforts(info);
  const efforts = REASONING_EFFORTS.filter((effort) => offered.includes(effort));
  return { efforts, effort: effortFor(info, chosen) };
}

/**
 * Six rising bars in the lamp's amber, lit up to the effort; changing it
 * lights or dims them one after another. The model default leaves the
 * scale unlit in a softer ink than Off, since the model decides.
 */
function EffortGauge({ effort }: { effort: ReasoningEffort }) {
  const lit = LIT[effort];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="size-4 shrink-0">
      {BARS.map((bar) => (
        <rect
          key={bar}
          x={1.5 + bar * 3.5}
          y={16 - bar * 2.8}
          width={3}
          height={4 + bar * 2.8}
          rx={1}
          style={staggerStep(bar < lit ? bar : 5 - bar)}
          className={cn(
            "stagger transition-[fill,opacity] duration-(--duration-arrive) ease-fade",
            effort === "provider-default"
              ? "fill-reed opacity-35"
              : bar < lit
                ? "fill-dusk"
                : "fill-rush",
          )}
        />
      ))}
    </svg>
  );
}

/** The value of the `follow` option; never an effort. */
const FOLLOW = "";

/**
 * How long the chosen model thinks before writing, narrowed to the efforts it
 * offers. With `follow`, a first option leaves the effort to another setting;
 * `effort` is then the one it resolves to, which the gauge shows.
 */
export function ReasoningSelect({
  labelId,
  efforts,
  effort,
  onChange,
  follow,
  disabled = false,
  className,
}: {
  labelId: string;
  efforts: ReasoningEffort[];
  effort: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  follow?: { label: string; chosen: boolean; onChoose: () => void };
  /** Held by the host beyond a single level (a run painting). */
  disabled?: boolean;
  className?: string;
}) {
  const following = follow?.chosen === true;
  return (
    <Select
      // A new list of levels mounts a new Select: one that drops its value reports a
      // replacement as a change, which would overwrite the pick kept for other models.
      key={efforts.join()}
      value={following ? FOLLOW : effort}
      items={
        follow === undefined ? REASONING_LABELS : { ...REASONING_LABELS, [FOLLOW]: follow.label }
      }
      disabled={disabled || efforts.length + (follow === undefined ? 0 : 1) < 2}
      onValueChange={(value) => {
        if (value === FOLLOW && follow !== undefined) {
          follow.onChoose();
          return;
        }
        const chosen = efforts.find((option) => option === value);
        if (chosen) onChange(chosen);
      }}
    >
      <SelectTrigger
        aria-labelledby={labelId}
        placeholder="Model default"
        className={cn("w-full max-w-72 tablet:w-64", className)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <EffortGauge effort={effort} />
          <span
            key={following ? FOLLOW : effort}
            className="truncate transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
          >
            {following ? follow.label : REASONING_LABELS[effort]}
          </span>
        </span>
      </SelectTrigger>
      <SelectContent label="Reasoning effort" className="min-w-56">
        {follow === undefined ? null : (
          <SelectItem value={FOLLOW}>
            <span className="flex items-center gap-2.5">
              <EffortGauge effort={effort} />
              {follow.label}
            </span>
          </SelectItem>
        )}
        {efforts.map((option) => (
          <SelectItem key={option} value={option}>
            <span className="flex items-center gap-2.5">
              <EffortGauge effort={option} />
              {REASONING_LABELS[option]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
