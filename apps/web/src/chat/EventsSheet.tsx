import { useCallback, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Drawer, DrawerCloseIcon, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { EditorBody, EditorHeader } from "@/components/ui/editor-shell";
import { EventsSection, type leaveGuardOf } from "../events/EventsSection.tsx";
import { saveStatusText } from "../sheet/autosave.ts";

/**
 * The events from the chat: the same list Lorebooks holds, open in a side
 * sheet (a bottom sheet on phones), so an event can be added or changed
 * without leaving the story. Focus returns to whatever opened it.
 */
export function EventsSheet({
  open,
  onOpenChange,
  returnTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnTo: () => HTMLElement | null;
}) {
  const phone = useFormFactor() === "phone";
  const saving = useRef<ReturnType<typeof leaveGuardOf>>(null);
  const closing = useRef(false);
  const [warned, setWarned] = useState(false);
  const [saveText, setSaveText] = useState("Not saved");
  const reportSaving = useCallback((guard: ReturnType<typeof leaveGuardOf>) => {
    saving.current = guard;
    setSaveText(saveStatusText(guard.status, guard.creating, "event"));
  }, []);
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    let saved: boolean;
    do {
      saved = await (saving.current?.flush() ?? Promise.resolve(true)).catch(() => false);
    } while (saved && saving.current?.hasUnsaved());
    closing.current = false;
    if (saved) onOpenChange(false);
    else setWarned(true);
  };
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else void close();
      }}
      swipeDirection={phone ? "down" : "right"}
      showSwipeHandle={phone}
      keyboardAware={phone}
    >
      <DrawerContent
        finalFocus={returnTo}
        className="data-[swipe-axis=x]:[--drawer-content-width:min(30rem,calc(100vw-6rem))]"
      >
        <EditorHeader
          title={<DrawerTitle>Events</DrawerTitle>}
          close={<DrawerCloseIcon label="Close Events" />}
        />
        <EditorBody className="pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <EventsSection inSheet onSavingChange={reportSaving} />
        </EditorBody>
        <ConfirmDialog
          open={warned}
          onOpenChange={setWarned}
          title="Leave without saving?"
          description={`${saveText}. Leaving now discards the edits that were not saved.`}
          confirm="Leave"
          cancel="Stay"
          onConfirm={() => onOpenChange(false)}
        />
      </DrawerContent>
    </Drawer>
  );
}
