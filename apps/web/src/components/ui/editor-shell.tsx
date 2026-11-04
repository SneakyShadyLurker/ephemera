import { Dialog } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode, Ref, RefObject } from "react";
import { useCoarsePointer, useFormFactor } from "@/app/form-factor.ts";
import { CloseIcon } from "@/components/icons";
import { DIALOG_SURFACE, SCRIM } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  PANEL_TITLE,
} from "@/components/ui/drawer";
import { cn } from "@/lib/cn";

/** The same header in a drawer, dialog or working popover. Close always comes last. */
export function EditorHeader({
  title,
  description,
  back,
  actions,
  close,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: ReactNode;
  actions?: ReactNode;
  close?: ReactNode;
  className?: string;
}) {
  return (
    <DrawerHeader className={cn("relative h-auto min-h-14 border-rush border-b", className)}>
      {back}
      <div className="grid min-w-0 flex-1 gap-1 py-3">
        {title}
        {description}
      </div>
      {actions}
      {close}
    </DrawerHeader>
  );
}

/** One scrolling body, with the header and actions outside its scroll boundary. */
export function EditorBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4", className)}
      {...props}
    />
  );
}

/** Actions keep the same inset and remain above a phone's home indicator. */
export function EditorFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "grid shrink-0 gap-2 border-rush border-t px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]",
        className,
      )}
      {...props}
    />
  );
}

/** Responsive editors share their primitive, focus lifecycle and visible composition. */
export function ResponsiveEditor({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  closeLabel,
  closeDisabled,
  closeRef,
  popupRef,
  initialFocus,
  finalFocus,
  focusOnTouch = false,
  footer,
  children,
  className,
  bodyClassName,
  wrap,
  ...data
}: {
  open: boolean;
  onOpenChange: (open: boolean, details: { cancel: () => void }) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  title: string;
  description?: string;
  closeLabel: string;
  closeDisabled?: boolean;
  closeRef?: Ref<HTMLButtonElement>;
  popupRef: RefObject<HTMLDivElement | null>;
  initialFocus?: Dialog.Popup.Props["initialFocus"];
  finalFocus?: Dialog.Popup.Props["finalFocus"];
  focusOnTouch?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  wrap?: (content: ReactNode) => ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const phone = useFormFactor() === "phone";
  const coarse = useCoarsePointer();
  const focus = {
    initialFocus: focusOnTouch && coarse ? popupRef : initialFocus,
    finalFocus,
  };
  const Title = phone ? DrawerTitle : Dialog.Title;
  const Description = phone ? DrawerDescription : Dialog.Description;
  const layout = (
    <>
      <EditorHeader
        title={<Title className={cn(PANEL_TITLE, "text-balance")}>{title}</Title>}
        description={
          description && (
            <Description className="text-pretty text-note text-reed">{description}</Description>
          )
        }
        close={
          <Button
            ref={closeRef}
            size="icon"
            aria-label={closeLabel}
            disabled={closeDisabled}
            onClick={() => onOpenChange(false, { cancel: () => {} })}
          >
            <CloseIcon />
          </Button>
        }
      />
      <EditorBody className={bodyClassName}>{children}</EditorBody>
      {footer && <EditorFooter>{footer}</EditorFooter>}
    </>
  );
  const content = wrap ? wrap(layout) : layout;
  if (phone) {
    return (
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
        showSwipeHandle
        keyboardAware
      >
        <DrawerContent
          ref={popupRef}
          {...focus}
          {...data}
          className={cn(
            "[timeline-scope:--thread] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-0.75rem-env(safe-area-inset-top))]",
            className,
          )}
        >
          {content}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={cn(SCRIM, "starting:opacity-0")} />
        <Dialog.Popup
          render={(props, state) => <div {...props} inert={!state.open} />}
          ref={popupRef}
          {...focus}
          {...data}
          className={cn(
            DIALOG_SURFACE,
            "flex flex-col [--dialog-width:36rem] [timeline-scope:--thread] starting:translate-y-(--rise) starting:opacity-0",
            className,
          )}
        >
          {content}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
