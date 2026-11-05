import { type ReactNode, useRef, useState } from "react";
import { EmptyState } from "@/app/EmptyState.tsx";
import { useFormFactor } from "@/app/form-factor.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Drawer,
  DrawerClose,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/cn";
import { matches } from "@/lib/find";

/*
 * A searchable checklist under a trigger: a popover on desktop and tablet, a
 * bottom sheet with Done on phones. What a choice means (a persona going with
 * a character, a lorebook linked to one) is its owner's; the list, Find and
 * focus are shared here.
 */

export interface Choice {
  id: string;
  name: string;
  /** Beside the checkbox: a portrait leaf, or the same room left empty. */
  leaf?: ReactNode;
  checked: boolean;
  /** A quiet second line: who holds it now, or why it cannot be chosen. */
  note?: string;
  /** At the row's end, in reed: how many it applies to. */
  count?: number;
  /** Unavailable to check; one already checked stays free to uncheck unless `pending`. */
  disabled?: boolean;
  /** A change on its way to the server: shown as asked, not yet answered. */
  pending?: boolean;
}

/**
 * The checklist itself, with its Find. `compact` rows are a filter's (a
 * gallery's tags): one line each, no leaf, 36px, 44px on touch.
 */
export function ChoiceList({
  choices,
  findLabel,
  empty,
  noMatch,
  onToggle,
  notice,
  footer,
  compact = false,
  actions,
}: {
  choices: readonly Choice[];
  findLabel: string;
  empty: string;
  noMatch: string;
  onToggle: (choice: Choice, checked: boolean) => void;
  notice?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  /** Explicit single-add actions, used by the character's lorebook picker. */
  actions?: { add: string; linked: string; remove: string };
}) {
  const [find, setFind] = useState("");
  const shown = choices.filter((choice) => matches(find, choice.name));
  return (
    <>
      <div className="p-1.5">
        <SearchField
          label={findLabel}
          placeholder={findLabel}
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
      </div>
      {notice}
      {shown.length === 0 ? (
        <EmptyState
          compact
          title={choices.length === 0 ? empty : noMatch}
          className="px-2.5 py-2"
        />
      ) : (
        <ul className="min-h-0 overflow-y-auto overscroll-contain">
          {shown.map((choice) => (
            <li key={choice.id}>
              {actions ? (
                <div
                  aria-busy={choice.pending || undefined}
                  className="flex min-h-14 items-center gap-3 px-2.5 py-1"
                >
                  {choice.leaf}
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-ink text-ui">{choice.name}</span>
                    {choice.note && <span className="text-meta text-reed">{choice.note}</span>}
                    {choice.checked && (
                      <span className="text-meta text-reed">{actions.linked}</span>
                    )}
                  </span>
                  <Button
                    variant="outline"
                    aria-label={`${choice.checked ? actions.remove : actions.add} ${choice.name}`}
                    disabled={choice.pending || choice.disabled}
                    onClick={() => onToggle(choice, !choice.checked)}
                  >
                    {choice.checked ? actions.remove : actions.add}
                  </Button>
                </div>
              ) : (
                <label
                  aria-busy={choice.pending || undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-sm px-2.5",
                    compact ? "min-h-9 touch:min-h-11" : "min-h-11 py-1 touch:min-h-12",
                    choice.disabled ? "cursor-default" : "row cursor-pointer",
                  )}
                >
                  <Checkbox
                    checked={choice.checked}
                    disabled={choice.disabled === true || choice.pending === true}
                    onCheckedChange={(next) => onToggle(choice, next)}
                  />
                  {!compact && (choice.leaf ?? <span aria-hidden="true" className="w-5" />)}
                  <span className="grid min-w-0 flex-1">
                    <span
                      title={choice.name}
                      className={cn(
                        "truncate text-ui",
                        choice.disabled && !choice.checked ? "text-reed" : "text-ink",
                      )}
                    >
                      {choice.name}
                    </span>
                    {choice.note && (
                      <span className="truncate text-meta text-reed">{choice.note}</span>
                    )}
                  </span>
                  {choice.count !== undefined && (
                    <span className="text-meta text-reed tabular-nums">{choice.count}</span>
                  )}
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
      {footer}
    </>
  );
}

export function ChoicePicker({
  trigger,
  triggerLabel,
  disabled = false,
  title,
  sheetTitle,
  open: controlled,
  onOpenChange,
  ...list
}: {
  /** The trigger's content: an icon and its words. */
  trigger: ReactNode;
  /** The trigger's name when its words differ by width; its words otherwise. */
  triggerLabel?: string;
  disabled?: boolean;
  /** The popover's name, said to assistive technology. */
  title: string;
  /** The bottom sheet's visible title on phones. */
  sheetTitle: string;
  /** Open and close it from outside (after creating a choice, say); its own state otherwise. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} & Parameters<typeof ChoiceList>[0]) {
  const phone = useFormFactor() === "phone";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  if (phone) {
    return (
      <>
        <Button
          ref={triggerRef}
          variant="outline"
          disabled={disabled}
          aria-label={triggerLabel}
          onClick={() => setOpen(true)}
        >
          {trigger}
        </Button>
        <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
          <DrawerContent finalFocus={triggerRef}>
            <DrawerHeader>
              <DrawerTitle>{sheetTitle}</DrawerTitle>
              {list.actions ? (
                <DrawerCloseIcon label={`Close ${sheetTitle.toLowerCase()}`} />
              ) : (
                <DrawerClose render={<Button variant="outline" />}>Done</DrawerClose>
              )}
            </DrawerHeader>
            <div className="flex min-h-0 flex-col px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <ChoiceList {...list} />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={triggerLabel}
        render={<Button ref={triggerRef} variant="outline" />}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent title={title} finalFocus={triggerRef}>
        <ChoiceList {...list} />
      </PopoverContent>
    </Popover>
  );
}
