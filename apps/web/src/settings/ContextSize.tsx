import {
  CONTEXT_WINDOW_RANGE,
  DEFAULT_CONTEXT_LIMIT,
  type EffectiveWindow,
  effectiveWindow,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { formatCount } from "@/lib/text";
import { modelsQuery } from "../api.ts";
import { scrollBehavior } from "../app/reduced-motion.ts";
import { useNumberDraft } from "./number-draft.ts";
import { useSettings, useUpdateSettings } from "./settings.ts";

const HELP = "text-pretty text-note text-reed";

/**
 * How much of each model's window a prompt may use, the window itself for a
 * model the provider reports none for, and how history is trimmed to fit
 * (PRODUCT.md § Models). The window in use comes from `effectiveWindow` alone.
 * Listed: the reply model, models with a stored window or limit, models added
 * here, and `windowFor`, a model a link asked to set a window for, which is
 * scrolled to with its window editor focused; `onWindowShown` follows.
 */
export function ContextSize({
  windowFor,
  onWindowShown,
}: {
  windowFor: string | null;
  onWindowShown: () => void;
}) {
  const models = useQuery(modelsQuery);
  const settings = useSettings();
  const { contextLimits, contextWindows, model } = settings;
  const updateSettings = useUpdateSettings();
  const addLabel = useId();
  // Rows added here stay listed while the screen is open, even at the default.
  const [added, setAdded] = useState<string[]>([]);
  // The model a link asked for, and each ask counted, so asking again focuses again.
  const [asked, setAsked] = useState<{ id: string | null; count: number }>({ id: null, count: 0 });
  if (windowFor !== asked.id) {
    setAsked({ id: windowFor, count: asked.count + (windowFor === null ? 0 : 1) });
    if (windowFor !== null && !added.includes(windowFor)) setAdded([...added, windowFor]);
  }
  const catalog = models.data;
  const reported = new Map((catalog ?? []).map((info) => [info.id, info.contextWindow]));
  const ids = models.isPending
    ? []
    : [
        ...new Set([
          ...(model === null ? [] : [model]),
          ...Object.keys(contextLimits),
          ...Object.keys(contextWindows),
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
          {formatCount(DEFAULT_CONTEXT_LIMIT)} tokens unless set here. A model the provider reports
          no window for needs one set before replies can be sent.
        </p>
        {models.isError && catalog === undefined && (
          <p className="text-ember text-note">
            The model list didn't load. Reported windows are unknown until it does.
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
                focus={id === asked.id ? asked.count : 0}
                onFocused={onWindowShown}
              />
            ))}
          </ul>
        )}
        <div className="grid gap-1.5">
          <span id={addLabel} className="font-medium text-ink text-ui">
            Add a model
          </span>
          <ModelSelect
            label="Add a model's context limit"
            options={offered}
            value={null}
            onChange={(id) => {
              if (!ids.includes(id)) setAdded([...added, id]);
            }}
            className="max-w-sm tablet:w-full"
          />
        </div>
      </div>
    </div>
  );
}

/** The visible input of a row's window or limit field. */
const fieldIn = (row: HTMLElement | null, field: "window" | "limit") =>
  row?.querySelector<HTMLInputElement>(`[data-field="${field}"] input:not([aria-hidden])`);

function ModelRow({
  id,
  reported,
  fallback,
  stored,
  window,
  onWindow,
  onLimit,
  focus,
  onFocused,
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
  /** Counts each time a link asks to focus this row's window editor; 0 when none did. */
  focus: number;
  onFocused: () => void;
}) {
  const windowLabel = `Context window for ${id}`;
  const hintId = useId();
  const row = useRef<HTMLLIElement>(null);
  // Set opens an empty window field; nothing is saved until a value is committed.
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState(0);
  const unset = reported === null && fallback === null;
  if (focus !== focused) {
    setFocused(focus);
    if (focus > 0 && unset) setEditing(true);
  }
  const editor = reported === null && (fallback !== null || editing);
  // A link asked for this row: scroll to it and focus its window field, else its limit.
  useEffect(() => {
    if (focus === 0) return;
    row.current?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    (fieldIn(row.current, "window") ?? fieldIn(row.current, "limit"))?.focus({
      preventScroll: true,
    });
    onFocused();
  }, [focus, onFocused]);
  // Set moves focus to the field it opens.
  useEffect(() => {
    if (editing) fieldIn(row.current, "window")?.focus({ preventScroll: true });
  }, [editing]);

  // A window below the smallest limit has nothing to limit: the whole of it is used.
  const limit =
    window === null || window.model < CONTEXT_WINDOW_RANGE.min ? null : (
      <span data-field="limit" className="contents">
        <LimitField id={id} window={window} limited={stored !== null} onChange={onLimit} />
      </span>
    );
  return (
    <li ref={row} className="grid scroll-my-6 gap-2 border-rush border-b py-3 arrive">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 touch:min-h-11">
        <span className="min-w-0 flex-1 truncate font-medium text-ink text-ui max-tablet:basis-full">
          {id}
        </span>
        {reported !== null ? (
          limit
        ) : !editor ? (
          <span className="flex items-center gap-2">
            <span className="text-ember text-note">Not set: replies can't be sent</span>
            <Button
              variant="outline"
              aria-label={`Set ${windowLabel}`}
              className="h-8 px-2.5 text-note touch:h-11"
              onClick={() => setEditing(true)}
            >
              Set
            </Button>
          </span>
        ) : (
          <span data-field="window" className="flex items-center gap-2 arrive">
            <NumberField
              {...(fallback === null ? { describedBy: hintId } : { defaultValue: fallback })}
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
            {fallback === null ? (
              <Button
                aria-label={`Cancel ${windowLabel}`}
                className="h-8 px-2 text-note touch:h-11"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            ) : (
              <Button
                aria-label={`Reset ${windowLabel}`}
                className="h-8 px-2 text-note touch:h-11"
                onClick={() => {
                  setEditing(false);
                  onWindow(null);
                }}
              >
                Reset
              </Button>
            )}
          </span>
        )}
      </div>
      {editor && fallback === null && (
        <p id={hintId} className={`${HELP} arrive`}>
          Use the window your provider documents for this model.
        </p>
      )}
      {reported !== null && fallback !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-note text-reed">
            Not used: the provider reports {formatCount(reported)}.
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
