import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { CheckIcon } from "@/components/icons";
import { POPUP_EDGE } from "@/components/ui/positioner";
import { cn } from "@/lib/cn";

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;
const MenuRadioGroup = MenuPrimitive.RadioGroup;

/**
 * A menu surface under its trigger: rises 4px and fades, like every popup.
 * It is its own scroll owner, never taller than the room its positioner
 * finds, so every item stays reachable in a short window or at high zoom.
 */
function MenuContent({
  children,
  align = "end",
  label,
  finalFocus,
  className,
}: {
  children: ReactNode;
  align?: MenuPrimitive.Positioner.Props["align"];
  label?: string;
  /** Where focus goes when the menu closes; the trigger unless given. */
  finalFocus?: MenuPrimitive.Popup.Props["finalFocus"];
  /** A lower height cap, for a long menu. */
  className?: string;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        sideOffset={6}
        collisionPadding={POPUP_EDGE}
        align={align}
        className="z-50"
      >
        <MenuPrimitive.Popup
          aria-label={label}
          {...(finalFocus === undefined ? {} : { finalFocus })}
          className={cn(
            "pop max-h-(--available-height) min-w-48 max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-lg border border-rush bg-surface p-1 shadow-overlay outline-none",
            className,
          )}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

const ITEM =
  "flex h-9 cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 text-ink text-ui outline-none data-disabled:text-text-disabled data-highlighted:bg-surface-hover touch:h-11 [&_svg]:shrink-0 [&_svg]:text-reed";

function MenuItem({
  className,
  danger,
  ...props
}: MenuPrimitive.Item.Props & { danger?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(ITEM, danger && "text-ember [&_svg]:text-ember", className)}
      {...props}
    />
  );
}

/** A menu item that is a link (Base UI's LinkItem), styled like any item. */
function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return <MenuPrimitive.LinkItem className={cn(ITEM, className)} {...props} />;
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem className={cn(ITEM, className)} {...props}>
      <span className="flex-1">{children}</span>
      <MenuPrimitive.RadioItemIndicator>
        <CheckIcon size={16} />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-rush" />;
}

export {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
};
