import { type ReactNode, useId } from "react";
import { Infotip } from "@/components/ui/infotip";
import { cn } from "@/lib/cn";

/*
 * The one row grammar of Settings: the label on the leading edge with its
 * infotip, a one-line hint under it, and the control placed by its kind,
 * hairlines between rows. A single control (a switch, a select, a number)
 * keeps the trailing edge, where every such row lines up; a group of
 * choices follows its label, so short label and wide group read as one;
 * a panel of choices takes the row's width under its label. Each row is a
 * container: below 30rem of its own width the control drops under the
 * label, so a narrow tablet panel and a phone share one rule.
 */

export const HINT = "text-pretty text-note text-reed";

/**
 * A Settings panel's actions (Save, Cancel), stuck to the bottom of the
 * scroller on phones above the home indicator, in the flow from tablets on.
 * The panel pads 1rem, which the footer spans.
 */
export const PANEL_FOOTER =
  "sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 rounded-b-xl border-rush border-t bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] tablet:static tablet:mx-0 tablet:mb-0 tablet:border-0 tablet:bg-transparent tablet:p-0";

/** Where a row's control sits: see the row grammar above. */
type RowControl = "single" | "choices" | "panel";

const ROW_GRID: Record<RowControl, string> = {
  single: "@min-[30rem]:grid-cols-[minmax(0,1fr)_auto] @min-[30rem]:items-center",
  choices:
    "@min-[30rem]:grid-cols-[auto_minmax(0,auto)] @min-[30rem]:items-center @min-[30rem]:justify-start @min-[30rem]:gap-x-8",
  panel: "",
};

/** A select or model picker in a row: one shared width, capped like every field. */
export const ROW_SELECT = "w-full max-w-sm @min-[30rem]:w-60";

/** A row's label line: the label itself, then its infotip when it has one. */
function LabelLine({
  label,
  about,
  children,
}: {
  label: string;
  about?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="block">
      {children}
      {about !== undefined && <Infotip label={label}>{about}</Infotip>}
    </span>
  );
}

/**
 * One setting. `label` names the control: through `labelId` (a select or a
 * combobox, `aria-labelledby`), `htmlFor` (a native input), or the control's
 * own label (a number field), shown here all the same. `hint` describes it
 * through `hintId`; `problem` turns it Ember. `control` names the control's
 * kind, which places it: a `single` control (the default), a group of
 * `choices` (the theme) or a `panel` of them at the row's width (the palette
 * tiles). `below` follows the row at full width (a window note, the palette
 * editor).
 */
export function SettingRow({
  label,
  labelId,
  htmlFor,
  about,
  hint,
  hintId,
  problem = false,
  live = false,
  control = "single",
  below,
  children,
}: {
  label: string;
  labelId?: string;
  htmlFor?: string;
  about?: ReactNode;
  hint?: ReactNode;
  hintId?: string;
  problem?: boolean;
  /** The hint is announced when it changes (a field's problem line). */
  live?: boolean;
  control?: RowControl;
  below?: ReactNode;
  children: ReactNode;
}) {
  const text = "font-medium text-ink text-ui";
  return (
    <div className="@container grid gap-2 py-3.5">
      <div className={cn("grid gap-x-6 gap-y-2", ROW_GRID[control])}>
        <div className="grid content-start gap-0.5">
          <LabelLine label={label} about={about}>
            {htmlFor === undefined ? (
              <span id={labelId} className={text}>
                {label}
              </span>
            ) : (
              <label id={labelId} htmlFor={htmlFor} className={text}>
                {label}
              </label>
            )}
          </LabelLine>
          {hint !== undefined && (
            <p
              id={hintId}
              aria-live={live ? "polite" : undefined}
              className={cn(HINT, problem && "text-ember")}
            >
              {hint}
            </p>
          )}
        </div>
        <div
          className={
            control === "panel" ? "grid min-w-0" : "flex min-w-0 flex-wrap items-center gap-2"
          }
        >
          {children}
        </div>
      </div>
      {below}
    </div>
  );
}

/**
 * A row of number field and unit: the unit keeps a fixed slot, so the
 * fields of a category line up whatever their units.
 */
export function WithUnit({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      {children}
      <span className="min-w-12 text-note text-reed">{unit}</span>
    </span>
  );
}

/**
 * A group of rows under an `h3` (left out when the category's title already
 * names it), with an optional one-line lead and infotip, the rows divided by
 * hairlines.
 */
export function SettingGroup({
  title,
  lead,
  about,
  children,
}: {
  title?: string;
  lead?: ReactNode;
  about?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={title === undefined ? undefined : headingId} className="grid gap-3">
      {(title !== undefined || lead !== undefined) && (
        <div className="grid gap-1">
          {title !== undefined && (
            <LabelLine label={title} about={about}>
              <h3 id={headingId} className="inline font-semibold text-ink text-lead">
                {title}
              </h3>
            </LabelLine>
          )}
          {lead !== undefined && <p className={HINT}>{lead}</p>}
        </div>
      )}
      <div className="grid divide-y divide-rush border-rush border-y">{children}</div>
    </section>
  );
}
