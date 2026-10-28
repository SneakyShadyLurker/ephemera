import { type ReactNode, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Drawer,
  DrawerClose,
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
  /** Unavailable to check; one already checked stays free to uncheck unless `pending`. */
  disabled?: boolean;
  /** A change on its way to the server: shown as asked, not yet answered. */
  pending?: boolean;
}

function ChoiceList({
  choices,
  findLabel,
  empty,
  noMatch,
  onToggle,
  notice,
  footer,
}: {
  choices: readonly Choice[];
  findLabel: string;
  empty: string;
  noMatch: string;
  onToggle: (choice: Choice, checked: boolean) => void;
  notice?: ReactNode;
  footer?: ReactNode;
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
        <p className="px-2.5 py-2 text-note text-reed">{choices.length === 0 ? empty : noMatch}</p>
      ) : (
        <ul className="min-h-0 overflow-y-auto overscroll-contain">
          {shown.map((choice) => (
            <li key={choice.id}>
              <label
                aria-busy={choice.pending || undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2.5 rounded-sm px-2.5 py-1 touch:min-h-12",
                  choice.disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-hover",
                )}
              >
                <Checkbox
                  checked={choice.checked}
                  disabled={choice.disabled === true || choice.pending === true}
                  onCheckedChange={(next) => onToggle(choice, next)}
                />
                {choice.leaf ?? <span aria-hidden="true" className="w-5" />}
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
              </label>
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
          variant="outline"
          disabled={disabled}
          aria-label={triggerLabel}
          onClick={() => setOpen(true)}
        >
          {trigger}
        </Button>
        <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{sheetTitle}</DrawerTitle>
              <DrawerClose render={<Button variant="outline" />}>Done</DrawerClose>
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
        render={<Button variant="outline" />}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent title={title}>
        <ChoiceList {...list} />
      </PopoverContent>
    </Popover>
  );
}
