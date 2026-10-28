import { Select as SelectPrimitive } from "@base-ui/react/select";
import { type ReactNode, useId } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { POPUP_EDGE } from "@/components/ui/positioner";
import { cn } from "@/lib/cn";

const Select = SelectPrimitive.Root;

/**
 * Shows the selected item's text, or `children` when given (such as a portrait
 * beside the name). Disabled, it takes the disabled controls' Rush outline and
 * text, as buttons do.
 */
function SelectTrigger({
  className,
  placeholder,
  children,
  ...props
}: SelectPrimitive.Trigger.Props & { placeholder: string }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "press flex h-9 w-full items-center justify-between gap-2 rounded-md border border-control-edge bg-surface pr-2 pl-3 text-left text-ink text-ui hover:bg-surface-hover data-popup-open:bg-surface-hover data-disabled:cursor-default data-disabled:border-rush data-disabled:bg-surface data-disabled:text-text-disabled touch:h-11",
        className,
      )}
      {...props}
    >
      {children ?? (
        <SelectPrimitive.Value
          placeholder={placeholder}
          className="min-w-0 flex-1 truncate data-placeholder:text-reed"
        />
      )}
      <SelectPrimitive.Icon className="text-reed in-data-disabled:text-text-disabled transition-[rotate] duration-(--duration-arrive) ease-spring in-data-popup-open:rotate-180 motion-reduce:transition-none">
        <ChevronDownIcon size={16} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/**
 * A trigger led by a portrait (`Leaf` sized `LEAF_TRIGGER.leaf`): as tall as
 * every other trigger, the leaf nearer its edge.
 */
const LEAF_TRIGGER = { trigger: "pl-1.5", leaf: "w-5" } as const;

/** The list; `className` sizes it, such as a popup wider than a compact trigger. */
function SelectContent({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={6}
        collisionPadding={POPUP_EDGE}
        alignItemWithTrigger={false}
        className={cn("z-50 w-(--anchor-width)", className)}
      >
        <SelectPrimitive.Popup className="pop max-h-[min(24rem,var(--available-height))] overflow-y-auto overscroll-contain rounded-lg border border-rush bg-surface p-1 shadow-overlay outline-none">
          <SelectPrimitive.List aria-label={label}>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/**
 * One option. A `description` adds a wrapping second line in reed; the
 * option stays named by its text alone and is described by that line
 * through `aria-describedby`, which reads a referenced element even though
 * it is hidden from the option's name.
 */
function SelectItem({
  className,
  children,
  description,
  ...props
}: SelectPrimitive.Item.Props & { description?: string }) {
  const descriptionId = useId();
  if (description === undefined) {
    return (
      <SelectPrimitive.Item
        className={cn(
          "flex h-9 cursor-default select-none items-center gap-2 rounded-sm pr-2 pl-3 text-ink text-ui outline-none data-highlighted:bg-surface-hover touch:h-11",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
          {children}
        </SelectPrimitive.ItemText>
        <SelectPrimitive.ItemIndicator className="text-ink">
          <CheckIcon size={16} />
        </SelectPrimitive.ItemIndicator>
      </SelectPrimitive.Item>
    );
  }
  return (
    <SelectPrimitive.Item
      aria-describedby={descriptionId}
      className={cn(
        "grid min-h-9 cursor-default select-none grid-cols-[minmax(0,1fr)_1rem] items-start gap-x-2 rounded-sm py-1.5 pr-2 pl-3 text-ink outline-none data-highlighted:bg-surface-hover touch:min-h-11",
        className,
      )}
      {...props}
    >
      <span className="grid min-w-0 gap-0.5">
        <SelectPrimitive.ItemText className="text-ui">{children}</SelectPrimitive.ItemText>
        <span id={descriptionId} aria-hidden="true" className="text-pretty text-meta text-reed">
          {description}
        </span>
      </span>
      <SelectPrimitive.ItemIndicator className="pt-0.5 text-ink">
        <CheckIcon size={16} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { LEAF_TRIGGER, Select, SelectContent, SelectItem, SelectTrigger };
