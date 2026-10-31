import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { type ComponentProps, type ReactNode, type RefObject, useId } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "@/components/icons";
import { POPUP_EDGE } from "@/components/ui/positioner";
import { TRIGGER, TRIGGER_ICON } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";

/*
 * A searchable list: a select's trigger whose popup opens on a find field,
 * the results scrolling under it and an optional footer that stays put.
 * Callers filter (`filteredItems`), so they decide what the footer offers.
 */

const Combobox = ComboboxPrimitive.Root;

/** Looks like `SelectTrigger`; `children` is what it shows. */
function ComboboxTrigger({
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Trigger.Props, "children"> & { children: ReactNode }) {
  return (
    <ComboboxPrimitive.Trigger className={cn(TRIGGER, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ComboboxPrimitive.Icon className={TRIGGER_ICON}>
        <ChevronDownIcon size={16} />
      </ComboboxPrimitive.Icon>
    </ComboboxPrimitive.Trigger>
  );
}

/** Coarse pointers open on the list with the keyboard down; a tap on the field brings it up. */
const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * The popup: `label` names it, the find field (`find`) heads it, `status`
 * is the one line about the list (loading, failed, capped), the results
 * scroll in `children` and `footer` stays under them. `results` is the
 * scroller, for resetting it when the query changes.
 */
function ComboboxPopup({
  label,
  find,
  status,
  footer,
  after,
  results,
  finalFocus,
  children,
}: {
  label: string;
  find: { label: string; placeholder: string };
  status: ReactNode;
  /** Items kept below the results, outside their scroll. */
  footer?: ReactNode;
  /** A line under the list that is not an item. */
  after?: ReactNode;
  results: RefObject<HTMLDivElement | null>;
  /** Where focus goes when it closes; the trigger unless the host moves it itself. */
  finalFocus?: ComponentProps<typeof ComboboxPrimitive.Popup>["finalFocus"];
  children: ReactNode;
}) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align="start"
        sideOffset={6}
        collisionPadding={POPUP_EDGE}
        className="z-50 w-(--anchor-width) tablet:w-[max(var(--anchor-width),20rem)]"
        style={{ maxWidth: `calc(100vw - ${2 * POPUP_EDGE}px)` }}
      >
        <ComboboxPrimitive.Popup
          aria-label={label}
          initialFocus={() => (coarsePointer() ? (results.current?.parentElement ?? true) : true)}
          {...(finalFocus === undefined ? {} : { finalFocus })}
          className="pop flex max-h-[min(24rem,var(--available-height))] flex-col overflow-hidden rounded-lg border border-rush bg-surface shadow-overlay outline-none"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-rush border-b px-3 transition-[border-color] duration-(--duration-quick) ease-fade focus-within:border-dusk-line touch:h-12">
            <SearchIcon size={16} className="shrink-0 text-reed" />
            <ComboboxPrimitive.Input
              aria-label={find.label}
              placeholder={find.placeholder}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              onKeyDown={(event) => {
                // Enter confirms an IME composition; it never picks a row.
                if (event.key === "Enter" && isComposing(event)) event.preventBaseUIHandler();
              }}
              className="min-w-0 flex-1 bg-transparent text-ink text-ui outline-none placeholder:text-reed"
            />
          </div>
          <ComboboxPrimitive.Status className="shrink-0 text-meta">
            {status}
          </ComboboxPrimitive.Status>
          <ComboboxPrimitive.List className="flex min-h-0 flex-1 flex-col outline-none">
            <div
              ref={results}
              className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 empty:hidden"
            >
              {children}
            </div>
            {footer && <div className="shrink-0 border-rush border-t p-1">{footer}</div>}
          </ComboboxPrimitive.List>
          {after && <div className="shrink-0 border-rush border-t px-3 py-2.5">{after}</div>}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

/**
 * One row: its name wraps rather than truncates; `aside` sits right-aligned
 * in reed and `detail` under the name, both read as the row's description
 * (`describe`) through `aria-describedby`, never in its name.
 */
function ComboboxItem({
  value,
  index,
  children,
  aside,
  detail,
  describe,
  className,
}: {
  value: string;
  index: number;
  children: ReactNode;
  /** Shown beside the name, such as a count. */
  aside?: ReactNode | undefined;
  /** Shown under the name. */
  detail?: ReactNode | undefined;
  /** What assistive technology reads for `aside` or `detail`. */
  describe?: string | undefined;
  className?: string;
}) {
  const descriptionId = useId();
  return (
    <ComboboxPrimitive.Item
      value={value}
      index={index}
      aria-describedby={describe === undefined ? undefined : descriptionId}
      className={cn(
        "grid min-h-9 cursor-default select-none grid-cols-[minmax(0,1fr)_auto_1rem] items-start gap-x-3 rounded-sm py-2 pr-2 pl-3 text-ink outline-none data-highlighted:bg-surface-hover touch:min-h-11 touch:py-3",
        className,
      )}
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="text-ui leading-5 [overflow-wrap:anywhere]">{children}</span>
        {detail !== undefined && (
          <span aria-hidden="true" className="text-meta text-reed">
            {detail}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="min-w-[7ch] text-right text-meta text-reed tabular-nums leading-5"
      >
        {aside}
      </span>
      {describe !== undefined && (
        <span id={descriptionId} hidden>
          {describe}
        </span>
      )}
      <ComboboxPrimitive.ItemIndicator className="mt-0.5 text-ink">
        <CheckIcon size={16} />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

export { Combobox, ComboboxItem, ComboboxPopup, ComboboxTrigger };
