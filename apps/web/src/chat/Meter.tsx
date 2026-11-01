import { Meter } from "@base-ui/react/meter";
import { useState } from "react";
import { useShallow } from "zustand/shallow";
import { useUi } from "@/app/ui.ts";
import { InspectIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { countOf, formatCount } from "@/lib/text";
import { useSetting } from "../settings/settings.ts";
import { type Level, type MeterStage, meterStage } from "./meter-stage.ts";
import { openInspector } from "./open-inspector.ts";
import { useChat } from "./session.ts";
import { type ChatState, nextPrompt } from "./store.ts";

/*
 * The context meter. Its numbers have one owner, the inspected prompt: the
 * preview of the next request when there is one (it follows the chat and the
 * draft), else the prompt last sent. Per-chat numbers are chat content and
 * live only in the store. It stays out of sight until the window is nearly
 * full; the inspector always has the figures.
 */

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 0 });
/** The meter's id: every control that opens the inspector is described by it. */
export const METER_ID = "context-meter";

function level(state: ChatState): Level | null {
  const prompt = nextPrompt(state);
  if (!prompt) return null;
  return {
    estimate: prompt.estimate,
    window: prompt.window.tokens,
    reserve: prompt.reserve,
    trimmed: prompt.history.total - prompt.history.sent,
  };
}

/** The level, or none without a model (its window is unknown then). */
function useLevel(): Level | null {
  const value = useChat(useShallow(level));
  return useSetting((settings) => settings.model) === null ? null : value;
}

/** The level and its stage, which remembers the previous one for the hysteresis. */
function useMeter(): { value: Level | null; stage: MeterStage } {
  const value = useLevel();
  const [previous, setPrevious] = useState<MeterStage>("quiet");
  const stage = value === null ? "quiet" : meterStage(value, previous);
  if (stage !== previous) setPrevious(stage);
  return { value, stage };
}

function spoken({ estimate, window, reserve, trimmed }: Level): string {
  return trimmed > 0
    ? `Context window full: the ${countOf(trimmed, "oldest message")} ${trimmed === 1 ? "is" : "are"} left out`
    : `About ${formatCount(estimate)} of ${formatCount(window)} tokens, ${formatCount(reserve)} kept for the reply`;
}

/**
 * A level along the header's bottom edge: the next prompt's size against the
 * model's window. The track is the header's scroll hairline; the level is
 * drawn only once the window is nearly full.
 */
export function Waterline() {
  const { value, stage } = useMeter();
  if (value === null) return null;
  const full = stage === "full";
  const used = full ? value.window - value.reserve : Math.min(value.estimate, value.window);
  return (
    <Meter.Root
      id={METER_ID}
      value={used}
      max={value.window}
      aria-label="Context"
      getAriaValueText={() => spoken(value)}
      className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5"
    >
      {/* Drawn with transforms, so a changing level moves nothing in layout. */}
      <Meter.Track className="relative h-full w-full overflow-hidden">
        <span
          className={cn(
            "absolute inset-0 transition-opacity duration-(--duration-quick) ease-fade",
            stage === "quiet" && "opacity-0",
          )}
        >
          <span
            className={cn(
              "absolute inset-0 origin-left transition-transform duration-(--duration-panel-in) ease-spring",
              full ? "bg-ink" : "bg-dusk",
            )}
            style={{ transform: `scaleX(${used / value.window})` }}
          />
        </span>
      </Meter.Track>
    </Meter.Root>
  );
}

/**
 * The figures as the header shows them from tablet up, for the phone's chat
 * menu: the estimate against the window once it is nearly full, "Full" once
 * history is left out, and nothing before.
 */
export function useMeterFigures(): string | null {
  const { value, stage } = useMeter();
  if (value === null || stage === "quiet") return null;
  return stage === "full"
    ? "Full"
    : `${compact.format(value.estimate)} of ${compact.format(value.window)}`;
}

/** Opens the inspector; its tooltip always carries the meter's figures. */
export function PromptButton() {
  const { value } = useMeter();
  const unavailable = useUi((state) => state.inspectorUnavailable);
  const label = unavailable
    ? "The prompt inspector didn't load; a reload brings it back and ends the chat"
    : value === null
      ? "Prompt"
      : `Prompt: ${spoken(value)}`;
  return (
    <Tooltip label={label} side="bottom">
      <Button
        size="icon"
        aria-label="Prompt"
        aria-haspopup="dialog"
        aria-describedby={value === null ? undefined : METER_ID}
        onClick={() => void openInspector()}
      >
        <InspectIcon />
      </Button>
    </Tooltip>
  );
}

/**
 * From tablet up, the meter's figures once the window is nearly full and
 * "Full" once history is left out, before the header's actions and set
 * against them, so Clear, Prompt and Session stay one group. Their room is
 * kept while they are hidden, so the header never shifts. Phones leave the
 * figures to the waterline and the inspector. Said by the Prompt button.
 */
export function MeterFigures() {
  const { value, stage } = useMeter();
  if (value === null) return null;
  const shown = "visible opacity-100";
  const hidden = "invisible opacity-0";
  return (
    // The figures and "Full" share one cell, so each stage keeps the same width.
    <span aria-hidden="true" className="mr-1 grid text-note tabular-nums max-tablet:hidden">
      <span
        data-meter-figures=""
        className={cn(
          "col-start-1 row-start-1 text-right transition-[opacity,visibility] duration-(--duration-quick) ease-fade",
          stage === "near" ? shown : hidden,
        )}
      >
        {/* Room for the longest estimate ("999K"), so the cell keeps its width
            as the count gains digits while a reply streams. */}
        <span data-meter-count="" className="inline-block min-w-[4ch] text-right">
          {compact.format(value.estimate)}
        </span>
        <span className="text-reed"> of {compact.format(value.window)}</span>
      </span>
      <span
        className={cn(
          "col-start-1 row-start-1 text-right font-medium text-ink transition-[opacity,visibility] duration-(--duration-quick) ease-fade",
          stage === "full" ? shown : hidden,
        )}
      >
        Full
      </span>
    </span>
  );
}
