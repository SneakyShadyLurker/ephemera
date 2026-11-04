import { useFormFactor } from "@/app/form-factor.ts";
import {
  Drawer,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
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
        <DrawerHeader>
          <DrawerTitle>Events</DrawerTitle>
          <DrawerCloseIcon label="Close Events" />
        </DrawerHeader>
        <div className="min-h-0 overflow-y-auto px-5 pt-1 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          <EventsSection inSheet />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
