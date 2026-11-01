import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogClose = AlertDialogPrimitive.Close;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

/** The dim layer behind a modal dialog, fading in and out. */
export const SCRIM =
  "fixed inset-0 z-(--z-overlay) bg-scrim transition-opacity duration-(--duration-quick) ease-fade data-ending-style:opacity-0 data-starting-style:opacity-0";

/**
 * A modal dialog's surface, centered and kept 1rem clear of every edge and
 * safe area, no wider than `--dialog-width`, rising and fading as it opens.
 */
export const DIALOG_SURFACE =
  "pop fixed top-[calc(1rem+env(safe-area-inset-top))] right-[calc(1rem+env(safe-area-inset-right))] bottom-[calc(1rem+env(safe-area-inset-bottom))] left-[calc(1rem+env(safe-area-inset-left))] z-(--z-overlay) m-auto h-fit max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[min(var(--dialog-width),calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right)))] rounded-xl border border-rush bg-surface shadow-overlay outline-none";

/**
 * A confirmation that interrupts: scrim, centered surface, focus held inside.
 * It keeps 1rem clear of every edge and safe area, and scrolls as a whole
 * when its text is taller than the window. `status`, when given, is a line
 * between the description and the actions: what the confirmed action is
 * doing, or why it failed.
 */
function AlertDialogContent({
  title,
  description,
  status,
  finalFocus,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  status?: ReactNode;
  finalFocus?: AlertDialogPrimitive.Popup.Props["finalFocus"];
  children: ReactNode;
}) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className={SCRIM} />
      <AlertDialogPrimitive.Popup
        {...(finalFocus === undefined ? {} : { finalFocus })}
        className={cn(DIALOG_SURFACE, "overflow-y-auto p-6 [--dialog-width:26rem]")}
      >
        <AlertDialogPrimitive.Title className="font-semibold text-heading text-ink">
          {title}
        </AlertDialogPrimitive.Title>
        <AlertDialogPrimitive.Description className="mt-2 text-pretty text-lead text-reed">
          {description}
        </AlertDialogPrimitive.Description>
        {status}
        <div className="mt-6 flex flex-wrap justify-end gap-2">{children}</div>
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

/**
 * A confirmation of one action: the quiet way out (`cancel`) and the action
 * itself, a danger one unless `tone` says otherwise. Either button closes it.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  cancel = "Keep it",
  onConfirm,
  onCancel,
  tone = "danger",
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** The action's label: "Delete", "Forget", "Discard". */
  confirm: string;
  cancel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  tone?: "danger" | "primary";
  finalFocus?: AlertDialogPrimitive.Popup.Props["finalFocus"];
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        title={title}
        description={description}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <AlertDialogClose
          render={<Button variant="quiet" />}
          {...(onCancel === undefined ? {} : { onClick: onCancel })}
        >
          {cancel}
        </AlertDialogClose>
        <AlertDialogClose
          render={<Button variant={tone === "danger" ? "dangerSolid" : "primary"} />}
          onClick={onConfirm}
        >
          {confirm}
        </AlertDialogClose>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogTrigger, ConfirmDialog };
