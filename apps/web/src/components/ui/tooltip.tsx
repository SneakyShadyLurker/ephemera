import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { KeyHint } from "@/components/ui/key-hint";

function TooltipProvider(props: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={400} {...props} />;
}

/**
 * Names an icon-only control on hover and focus, with its shortcut if any
 * (`KeyHint`, so not on touch).
 * Touch has no hover, so every such control also carries an accessible name.
 */
function Tooltip({
  label,
  shortcut,
  children,
  side = "bottom",
}: {
  label: ReactNode;
  shortcut?: string;
  children: ReactElement;
  side?: TooltipPrimitive.Positioner.Props["side"];
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-(--z-overlay)">
          <TooltipPrimitive.Popup className="pop flex items-center gap-2 rounded-sm bg-ink px-2 py-1 text-canvas text-meta">
            {label}
            {shortcut && (
              <KeyHint>
                <kbd className="font-sans text-canvas/70">{shortcut}</kbd>
              </KeyHint>
            )}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
