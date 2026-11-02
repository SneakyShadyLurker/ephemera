import type { ReworkCard } from "@ephemera/core";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { CloseIcon, LampFlameIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Composer, type ComposerNotice, isRefusal } from "./Composer.tsx";
import { reworkStore, useReworkLocked } from "./session.ts";

/**
 * The sheet header's AI Rework button and the composer it opens: a popover
 * on tablet and desktop, the bottom drawer on phones. Labelled on tablet and
 * desktop, an icon on phones. A character not yet saved has nothing to
 * rework, and none starts while a run works or is under review, or while the
 * portrait changes (the run would read it as it was). The sheet
 * owns whether the composer is open, so the dock can reopen it (Try again).
 *
 * A run the server refuses before the model writes (too large, no context
 * window, character gone) reopens the composer with what to do; the run is
 * discarded, the request kept.
 */
export function ReworkButton({
  id,
  portrait,
  portraitChanging,
  card,
  open,
  onOpenChange,
  trigger,
}: {
  id: string | null;
  /** The stored portrait's version; null for none. */
  portrait: number | null;
  /** The portrait is being uploaded, removed or replaced by New art: no run opens or starts. */
  portraitChanging: boolean;
  /** The sheet's fields at submit time. */
  card: () => ReworkCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button, where Undo and Done return focus. */
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const phone = useFormFactor() === "phone";
  const locked = useReworkLocked();
  const field = useRef<HTMLTextAreaElement>(null);
  /** Rework closed the composer: focus goes to the dock, not back to this button. */
  const submitted = useRef(false);
  const sentModel = useRef("");
  const [notice, setNotice] = useState<ComposerNotice | null>(null);

  useEffect(
    () =>
      reworkStore.subscribe((state) => {
        if (state.phase !== "review" || !isRefusal(state.failure)) return;
        setNotice({ code: state.failure, model: sentModel.current });
        state.discard();
        submitted.current = false;
        onOpenChange(true);
      }),
    [onOpenChange],
  );

  const change = (next: boolean) => {
    if (next) submitted.current = false;
    onOpenChange(next);
  };
  const finalFocus = () => !submitted.current;
  const composer = (close?: ReactNode) =>
    id === null ? null : (
      <Composer
        close={close}
        characterId={id}
        portrait={portrait}
        portraitChanging={portraitChanging}
        card={card}
        notice={notice}
        phone={phone}
        field={field}
        onModelChange={() => setNotice(null)}
        onSubmitted={(model) => {
          sentModel.current = model;
          submitted.current = true;
          setNotice(null);
          onOpenChange(false);
        }}
      />
    );
  const disabled = id === null || locked || portraitChanging;

  if (phone) {
    return (
      <Drawer open={open} onOpenChange={change} swipeDirection="down" showSwipeHandle keyboardAware>
        <DrawerTrigger
          render={
            <Button
              ref={trigger}
              variant="outline"
              size="icon"
              aria-label="AI Rework"
              disabled={disabled}
            />
          }
        >
          <LampFlameIcon />
        </DrawerTrigger>
        <DrawerContent initialFocus={field} finalFocus={finalFocus}>
          <DrawerTitle className="sr-only">AI Rework</DrawerTitle>
          {composer(
            <DrawerClose
              render={<Button size="icon" aria-label="Close AI Rework" className="-mr-2" />}
            >
              <CloseIcon />
            </DrawerClose>,
          )}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger render={<Button ref={trigger} variant="outline" disabled={disabled} />}>
        <LampFlameIcon size={16} />
        AI Rework
      </PopoverTrigger>
      <PopoverContent
        title="AI Rework"
        align="end"
        initialFocus={field}
        finalFocus={finalFocus}
        className="max-h-[min(40rem,80dvh,var(--available-height))] w-[32rem] max-w-[calc(100vw-2rem)] p-0"
      >
        {composer()}
      </PopoverContent>
    </Popover>
  );
}
