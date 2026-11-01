import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import * as React from "react";
import { CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type DrawerContextProps = {
  keyboardAware: boolean;
  showSwipeHandle: boolean;
  swipeDirection: NonNullable<DrawerPrimitive.Root.Props["swipeDirection"]>;
};

const DrawerContext = React.createContext<DrawerContextProps | null>(null);

function useDrawer() {
  const context = React.use(DrawerContext);

  if (!context) {
    throw new Error("useDrawer must be used within a Drawer.");
  }

  return context;
}

/** Always modal, without snap points: no sheet in the app uses either. */
function Drawer({
  keyboardAware = false,
  showSwipeHandle = false,
  swipeDirection = "down",
  ...props
}: Omit<DrawerPrimitive.Root.Props, "modal" | "snapPoints"> & {
  /**
   * A bottom sheet with form fields: the focused field is kept in view
   * above a software keyboard, and the sheet rises over it, its header and
   * footer in place while the body scrolls (Base UI's VirtualKeyboardProvider).
   */
  keyboardAware?: boolean;
  showSwipeHandle?: boolean;
}) {
  return (
    <DrawerContext value={{ keyboardAware, showSwipeHandle, swipeDirection }}>
      <DrawerPrimitive.Root data-slot="drawer" swipeDirection={swipeDirection} {...props} />
    </DrawerContext>
  );
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-(--z-overlay) min-h-dvh bg-scrim opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-(--duration-panel-in) ease-fade select-none data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*var(--duration-swipe-out))] data-starting-style:opacity-0 starting:opacity-0 data-swiping:duration-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      {...props}
    />
  );
}

function DrawerSwipeHandle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-swipe-handle"
      aria-hidden="true"
      className={cn(
        "relative z-(--z-raised) flex shrink-0 cursor-grab transition-opacity duration-(--duration-arrive) ease-fade group-data-nested-drawer-open/drawer-popup:opacity-0 group-data-nested-drawer-swiping/drawer-popup:opacity-100 group-data-[swipe-axis=x]/drawer-popup:h-full group-data-[swipe-axis=x]/drawer-popup:w-3 group-data-[swipe-axis=x]/drawer-popup:items-center group-data-[swipe-axis=y]/drawer-popup:h-4 group-data-[swipe-axis=y]/drawer-popup:w-full group-data-[swipe-axis=y]/drawer-popup:justify-center group-data-[swipe-direction=down]/drawer-popup:items-end group-data-[swipe-direction=left]/drawer-popup:order-last group-data-[swipe-direction=left]/drawer-popup:justify-start group-data-[swipe-direction=right]/drawer-popup:justify-end group-data-[swipe-direction=up]/drawer-popup:order-last group-data-[swipe-direction=up]/drawer-popup:items-start after:block after:shrink-0 after:rounded-full after:bg-control-edge group-data-[swipe-axis=x]/drawer-popup:after:h-8 group-data-[swipe-axis=x]/drawer-popup:after:w-1 group-data-[swipe-axis=y]/drawer-popup:after:h-1 group-data-[swipe-axis=y]/drawer-popup:after:w-8 active:cursor-grabbing",
        className,
      )}
      {...props}
    />
  );
}

function DrawerContent({ className, children, ...props }: DrawerPrimitive.Popup.Props) {
  const { keyboardAware, showSwipeHandle, swipeDirection } = useDrawer();
  const swipeAxis = swipeDirection === "down" || swipeDirection === "up" ? "y" : "x";

  const portal = (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="pointer-events-auto fixed inset-0 z-(--z-overlay) select-none"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-popup"
          data-swipe-axis={swipeAxis}
          className={cn(
            // Base.
            "group/drawer-popup pointer-events-auto fixed z-(--z-overlay) m-(--drawer-inset,0px) flex h-(--drawer-content-height) max-h-(--drawer-content-max-height,none) min-h-0 w-(--drawer-content-width,auto) transform-[translate3d(var(--translate-x,0px),var(--translate-y,0px),0)_scale(var(--stack-scale))] flex-col border-rush bg-surface text-ink shadow-overlay transition-[transform,height,opacity,filter] duration-(--duration-panel-in) ease-spring motion-reduce:data-ending-style:opacity-0 motion-reduce:data-ending-style:transform-none motion-reduce:data-starting-style:opacity-0 motion-reduce:data-starting-style:transform-none will-change-transform outline-none select-none [interpolate-size:allow-keywords] data-[swipe-direction=down]:rounded-t-xl data-[swipe-direction=down]:border-t data-[swipe-direction=left]:rounded-r-xl data-[swipe-direction=left]:border-r data-[swipe-direction=right]:rounded-l-xl data-[swipe-direction=right]:border-l data-[swipe-direction=up]:rounded-b-xl data-[swipe-direction=up]:border-b",
            // Nested.
            "data-nested-drawer-open:overflow-hidden data-nested-drawer-open:brightness-95",
            // Bleed.
            "after:pointer-events-none after:absolute after:bg-(--drawer-bleed-background,var(--color-surface)) data-[swipe-axis=x]:after:inset-y-0 data-[swipe-axis=x]:after:w-(--bleed) data-[swipe-axis=y]:after:inset-x-0 data-[swipe-axis=y]:after:h-(--bleed) data-[swipe-direction=down]:after:top-full data-[swipe-direction=left]:after:right-full data-[swipe-direction=right]:after:left-full data-[swipe-direction=up]:after:bottom-full",
            // Sizing.
            "[--drawer-content-height:var(--drawer-height,auto)] data-[swipe-axis=x]:[--drawer-content-width:min(22.5rem,calc(100vw-6rem))] data-[swipe-axis=y]:[--drawer-content-max-height:80dvh]",
            // Stack.
            "[--bleed:3rem] [--peek:1rem] [--stack-height:var(--drawer-frontmost-height,var(--drawer-height,0px))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] [--stack-scale-base:max(0,calc(1-(var(--nested-drawers)*var(--stack-step))))] [--stack-scale:clamp(0,calc(var(--stack-scale-base)+(var(--stack-step)*var(--stack-progress))),1)] [--stack-shrink:calc(1-var(--stack-scale))] [--stack-step:0.05]",
            // Transitions. A drawer mounted open enters from its starting style, as Base UI's never shows.
            "starting:transform-(--closed-transform) motion-reduce:starting:transform-none motion-reduce:starting:opacity-0 data-ending-style:transform-(--closed-transform) data-ending-style:opacity-[0.9999] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*var(--duration-swipe-out))] data-nested-drawer-swiping:duration-0 data-ending-style:data-nested-drawer-swiping:duration-[calc(var(--drawer-swipe-strength)*var(--duration-swipe-out))] data-starting-style:transform-(--closed-transform) data-swiping:duration-0 data-ending-style:data-swiping:duration-[calc(var(--drawer-swipe-strength)*var(--duration-swipe-out))]",
            // Axis: y.
            "data-[swipe-axis=y]:inset-x-0 data-[swipe-axis=y]:data-nested-drawer-open:h-(--stack-height)",
            // Axis: x.
            "data-[swipe-axis=x]:inset-y-0 data-[swipe-axis=x]:flex-row",
            // Keyboard: the inset, set only under the provider, lifts a bottom sheet over
            // the software keyboard and shortens it by as much.
            "data-[swipe-direction=down]:bottom-(--drawer-keyboard-inset,0px) data-[swipe-direction=down]:max-h-[calc(var(--drawer-content-max-height)-var(--drawer-keyboard-inset,0px))]",
            // Direction: down.
            "data-[swipe-direction=down]:origin-bottom data-[swipe-direction=down]:[--closed-transform:translate3d(0,calc(100%+var(--drawer-inset,0px)+2px),0)] data-[swipe-direction=down]:[--translate-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y)-var(--stack-peek-offset)-(var(--stack-shrink)*var(--stack-height)))]",
            // Direction: up.
            "data-[swipe-direction=up]:top-0 data-[swipe-direction=up]:origin-top data-[swipe-direction=up]:[--closed-transform:translate3d(0,calc(-100%-var(--drawer-inset,0px)-2px),0)] data-[swipe-direction=up]:[--translate-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y)+var(--stack-peek-offset)+(var(--stack-shrink)*var(--stack-height)))]",
            // Direction: left.
            "data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:origin-left data-[swipe-direction=left]:[--closed-transform:translate3d(calc(-100%-var(--drawer-inset,0px)-2px),0,0)] data-[swipe-direction=left]:[--translate-x:calc(var(--drawer-swipe-movement-x)+var(--stack-peek-offset)+(var(--stack-shrink)*100%))]",
            // Direction: right.
            "data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:origin-right data-[swipe-direction=right]:[--closed-transform:translate3d(calc(100%+var(--drawer-inset,0px)+2px),0,0)] data-[swipe-direction=right]:[--translate-x:calc(var(--drawer-swipe-movement-x)-var(--stack-peek-offset)-(var(--stack-shrink)*100%))]",
            className,
          )}
          {...props}
        >
          {showSwipeHandle && <DrawerSwipeHandle />}
          <DrawerPrimitive.Content
            data-slot="drawer-content"
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain rounded-[inherit] transition-opacity duration-(--duration-panel-in) ease-spring select-text group-data-nested-drawer-open/drawer-popup:opacity-0 group-data-nested-drawer-swiping/drawer-popup:opacity-100 group-data-swiping/drawer-popup:select-none",
            )}
          >
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );

  // Within the root, around the portal, so the viewport measures and the popup reads the inset.
  return keyboardAware ? (
    <DrawerPrimitive.VirtualKeyboardProvider>{portal}</DrawerPrimitive.VirtualKeyboardProvider>
  ) : (
    portal
  );
}

/** A panel's title: a sheet's, or a docked panel's heading in the same place. */
const PANEL_TITLE = "font-semibold text-ink text-lead";

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(PANEL_TITLE, className)}
      {...props}
    />
  );
}

function DrawerDescription({ ...props }: DrawerPrimitive.Description.Props) {
  return <DrawerPrimitive.Description data-slot="drawer-description" {...props} />;
}

/** A panel's header: its title, then its controls, the close control last. */
function DrawerHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="drawer-header"
      className={cn("flex h-14 shrink-0 items-center justify-between gap-2 pr-2 pl-5", className)}
      {...props}
    />
  );
}

/** A sheet's close control as an icon, named by `label`. */
function DrawerCloseIcon({ label }: { label: string }) {
  return (
    <DrawerClose render={<Button size="icon" aria-label={label} />}>
      <CloseIcon />
    </DrawerClose>
  );
}

/**
 * A row in a phone's bottom sheet: the sheet's width, tinted under the
 * finger and pressed like a button. The caller lays out what it holds.
 */
const DRAWER_ROW = "press w-full rounded-md text-left text-ink hover:bg-surface-hover";

/** A sheet row that acts: an icon and a verb, a thumb's height. */
const DRAWER_ACTION = cn(
  DRAWER_ROW,
  "flex h-13 items-center gap-4 px-4 text-lead [&_svg]:text-reed",
);

export {
  DRAWER_ACTION,
  DRAWER_ROW,
  Drawer,
  DrawerClose,
  DrawerCloseIcon,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  PANEL_TITLE,
};
