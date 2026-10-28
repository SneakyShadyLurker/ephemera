import {
  CONTEXT_WINDOW_RANGE,
  DEFAULT_CONTEXT_LIMIT,
  type EffectiveWindow,
  effectiveWindow,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { formatCount } from "@/lib/text";
import { modelsQuery } from "../api.ts";
import { useNumberDraft } from "./number-draft.ts";
import { useSettings, useUpdateSettings } from "./settings.ts";

const HELP = "text-pretty text-note text-reed";
/** Where Set starts: a common window, changed right away in the field. */
const SET_START = 32_768;

/**
 * How much of each model's window a prompt may use, the window itself for a
 * model CLIProxyAPI reports none for, and how history is trimmed to fit
 * (PRODUCT.md § Models). The window in use comes from `effectiveWindow` alone.
 */
export function ContextSize() {
  const models = useQuery(modelsQuery);
  const settings = useSettings();
  const { contextLimits, contextWindows, model } = settings;
  const updateSettings = useUpdateSettings();
  const addLabel = useId();
  // Rows added here stay listed while the screen is open, even at the default.
  const [added, setAdded] = useState<string[]>([]);
  const catalog = models.data;
  const reported = new Map((catalog ?? []).map((info) => [info.id, info.contextWindow]));
  const ids = models.isPending
    ? []
    : [
        ...new Set([
          ...(model === null ? [] : [model]),
          ...Object.keys(contextLimits),
          ...Object.keys(contextWindows),
          ...(catalog ?? []).filter((info) => info.contextWindow === null).map((info) => info.id),
          ...added,
        ]),
      ].sort();
  const offered = (catalog ?? []).map((info) => info.id).filter((id) => !ids.includes(id));

  const saveWindow = (id: string, value: number | null) => {
    const others = Object.fromEntries(Object.entries(contextWindows).filter(([key]) => key !== id));
    updateSettings({ contextWindows: value === null ? others : { ...others, [id]: value } });
  };
  const saveLimit = (id: string, value: number | null) => {
    const others = Object.fromEntries(Object.entries(contextLimits).filter(([key]) => key !== id));
    updateSettings({
      contextLimits:
        value === null || value === DEFAULT_CONTEXT_LIMIT ? others : { ...others, [id]: value },
    });
  };

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <p className={HELP}>
          How much of each model's context window a prompt may use,{" "}
          {formatCount(DEFAULT_CONTEXT_LIMIT)} tokens unless set here. A model CLIProxyAPI reports
          no window for needs one set before replies can be sent.
        </p>
        {models.isError && (
          <p className="text-ember text-note">
            The model list could not be loaded, so reported windows are unknown.
          </p>
        )}
        {ids.length > 0 && (
          <ul className="grid border-rush border-t">
            {ids.map((id) => (
              <ModelRow
                key={id}
                id={id}
                reported={reported.get(id) ?? null}
                fallback={
                  (Object.hasOwn(contextWindows, id) ? contextWindows[id] : undefined) ?? null
                }
                stored={(Object.hasOwn(contextLimits, id) ? contextLimits[id] : undefined) ?? null}
                window={effectiveWindow(id, catalog, settings)}
                onWindow={(value) => saveWindow(id, value)}
                onLimit={(value) => saveLimit(id, value)}
              />
            ))}
          </ul>
        )}
        {offered.length > 0 && (
          <div className="grid gap-1.5">
            <span id={addLabel} className="font-medium text-ink text-ui">
              Add a model
            </span>
            <ModelSelect
              label="Add a model's context limit"
              options={offered}
              value={null}
              onChange={(id) => setAdded([...added, id])}
              className="max-w-sm tablet:w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ModelRow({
  id,
  reported,
  fallback,
  stored,
  window,
  onWindow,
  onLimit,
}: {
  id: string;
  /** The catalog's window, null when it reports none. */
  reported: number | null;
  /** The window set here for a model the catalog reports none for. */
  fallback: number | null;
  /** The limit stored for this model, null when none is. */
  stored: number | null;
  window: EffectiveWindow | null;
  onWindow: (value: number | null) => void;
  onLimit: (value: number | null) => void;
}) {
  const windowLabel = `Context window for ${id}`;
  // A window below the smallest limit has nothing to limit: the whole of it is used.
  const limit =
    window === null || window.model < CONTEXT_WINDOW_RANGE.min ? null : (
      <LimitField id={id} window={window} limited={stored !== null} onChange={onLimit} />
    );
  return (
    <li className={`grid gap-2 border-rush border-b py-3 arrive`}>
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 touch:min-h-11">
        <span className="min-w-0 flex-1 truncate font-medium text-ink text-ui max-tablet:basis-full">
          {id}
        </span>
        {reported !== null ? (
          limit
        ) : fallback === null ? (
          <span className="flex items-center gap-2">
            <span className="text-ember text-note">Not set: replies can't be sent</span>
            <Button
              variant="outline"
              aria-label={`Set ${windowLabel}`}
              className="h-8 px-2.5 text-note touch:h-11"
              onClick={() => onWindow(SET_START)}
            >
              Set
            </Button>
          </span>
        ) : (
          <span className={`flex items-center gap-2 arrive`}>
            <NumberField
              defaultValue={fallback}
              min={CONTEXT_WINDOW_RANGE.min}
              max={CONTEXT_WINDOW_RANGE.max}
              step={CONTEXT_WINDOW_RANGE.step}
              largeStep={CONTEXT_WINDOW_RANGE.step * 8}
              label={windowLabel}
              className="w-40 touch:w-48"
              format={{ maximumFractionDigits: 0 }}
              onValueCommitted={(next) => {
                if (next !== null && next !== fallback) onWindow(next);
              }}
            />
            <span className="text-note text-reed">tokens</span>
            <Button
              aria-label={`Reset ${windowLabel}`}
              className="h-8 px-2 text-note touch:h-11"
              onClick={() => onWindow(null)}
            >
              Reset
            </Button>
          </span>
        )}
      </div>
      {reported !== null && fallback !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-note text-reed">
            Not used: CLIProxyAPI reports {formatCount(reported)}.
          </span>
          <Button
            aria-label={`Remove the window set for ${id}`}
            className="h-8 px-2 text-note touch:h-11"
            onClick={() => onWindow(null)}
          >
            Remove
          </Button>
        </div>
      )}
      {/* Without a window to limit, a stored limit is shown only to be removed. */}
      {stored !== null && limit === null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-note text-reed">
            Not used: a limit of {formatCount(stored)} tokens is stored.
          </span>
          <Button
            aria-label={`Remove the limit stored for ${id}`}
            className="h-8 px-2 text-note touch:h-11"
            onClick={() => onLimit(null)}
          >
            Remove
          </Button>
        </div>
      )}
      {reported === null && limit !== null && <div className="arrive">{limit}</div>}
      {window !== null && (
        <p className={HELP}>
          {window.model < CONTEXT_WINDOW_RANGE.min
            ? `Its whole window of ${formatCount(window.model)} tokens is used: too small to limit.`
            : reported === null
              ? `Up to ${formatCount(window.model)} tokens, the window set for it.`
              : `Up to ${formatCount(window.model)} tokens, the model's own window.`}
        </p>
      )}
    </li>
  );
}

/** The limit, typed in tokens; above the model's window it clamps to it. */
function LimitField({
  id,
  window,
  limited,
  onChange,
}: {
  id: string;
  window: EffectiveWindow;
  limited: boolean;
  onChange: (value: number | null) => void;
}) {
  const label = `Context limit for ${id}`;
  const max = Math.min(window.model, CONTEXT_WINDOW_RANGE.max);
  const draft = useNumberDraft(window.tokens, (next) => onChange(Math.min(next, max)));
  return (
    <span className="flex flex-wrap items-center gap-2">
      <NumberField
        {...draft}
        min={CONTEXT_WINDOW_RANGE.min}
        max={max}
        step={CONTEXT_WINDOW_RANGE.step}
        largeStep={CONTEXT_WINDOW_RANGE.step * 8}
        label={label}
        className="w-40 touch:w-48"
        format={{ maximumFractionDigits: 0 }}
      />
      <span className="text-note text-reed tabular-nums">of {formatCount(window.model)}</span>
      {/* Reset's place is kept, so the field stands where it did when Reset comes and goes. */}
      <span className="flex w-14 justify-end">
        {limited && (
          <Button
            aria-label={`Reset ${label}`}
            className="h-8 px-2 text-note touch:h-11"
            onClick={() => onChange(null)}
          >
            Reset
          </Button>
        )}
      </span>
    </span>
  );
}
