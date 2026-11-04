import { useFormFactor } from "@/app/form-factor.ts";
import { Drawer, DrawerCloseIcon, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { EditorBody, EditorHeader } from "@/components/ui/editor-shell";
import { EventsSection } from "../events/EventsSection.tsx";

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
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
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
          <EventsSection inSheet />
        </EditorBody>
      </DrawerContent>
    </Drawer>
  );
}
