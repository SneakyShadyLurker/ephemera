import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { type ReactNode, useId } from "react";
import { cn } from "@/lib/cn";

/**
 * On or off. On is Ink, never Dusk (Dusk is the screen's one primary action);
 * the thumb travels on the spring. `sm` sits in dense rows such as prompt
 * blocks. The hit area reaches 44px on touch at either size.
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & { size?: "default" | "sm" }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "group/switch relative inline-flex shrink-0 items-center rounded-full border border-control-edge bg-surface-hover p-0.5 transition-[background-color,border-color] duration-(--duration-quick) ease-fade after:absolute after:-inset-x-2 after:-inset-y-3 data-checked:border-ink data-checked:bg-ink data-disabled:cursor-default data-disabled:border-rush data-disabled:bg-rush touch:after:-inset-3.5",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-control-edge transition-[translate,background-color] duration-(--duration-arrive) ease-spring motion-reduce:transition-[background-color] data-checked:bg-canvas group-data-disabled/switch:bg-text-disabled",
          size === "sm"
            ? "size-2.5 data-checked:translate-x-3"
            : "size-3.5 data-checked:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/**
 * A switch with its short label and help text beside it. The switch is named
 * by the label alone and described by the help, and a click anywhere on
 * either toggles it. `trailing` puts the switch on the row's trailing edge
 * (a settings row), where a click on the label toggles it; `about` (an
 * infotip) then follows the label, outside the `<label>`, so pressing it
 * never toggles the switch.
 */
function SwitchField({
  label,
  description,
  trailing = false,
  about,
  className,
  ...props
}: Omit<SwitchPrimitive.Root.Props, "aria-labelledby" | "aria-describedby" | "id" | "about"> & {
  label: ReactNode;
  description: ReactNode;
  trailing?: boolean;
  about?: ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const inputId = useId();
  if (trailing) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6">
        <div className="grid gap-0.5">
          <span className="block">
            <label id={labelId} htmlFor={inputId} className="font-medium text-ink text-ui">
              {label}
            </label>
            {about}
          </span>
          <span id={descriptionId} className="text-pretty text-note text-reed">
            {description}
          </span>
        </div>
        <Switch
          id={inputId}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className={cn("mt-0.5", className)}
          {...props}
        />
      </div>
    );
  }
  return (
    <label className="flex items-start gap-3">
      <Switch
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className={cn("mt-0.5", className)}
        {...props}
      />
      <span className="grid gap-0.5">
        <span id={labelId} className="font-medium text-ink text-ui">
          {label}
        </span>
        <span id={descriptionId} className="text-pretty text-note text-reed">
          {description}
        </span>
      </span>
    </label>
  );
}

export { Switch, SwitchField };
