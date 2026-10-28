import { Link, useBlocker } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { SCROLL_GUTTERS, ScreenHeader } from "@/app/Screen.tsx";
import { BackIcon } from "@/components/icons";
import { AlertDialog, AlertDialogClose, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { identity } from "../signin/identity.ts";
import { CREATOR_FRAME } from "./CardLayout.tsx";
import { Choose, COLUMN } from "./Choose.tsx";
import { Describe } from "./Describe.tsx";
import { KeepBar } from "./KeepBar.tsx";
import { keptStore } from "./kept.ts";
import { Showcase } from "./Showcase.tsx";
import { creatorStore, hasUnsavedCard, keeping, useCreator } from "./session.ts";
import { Writing } from "./Writing.tsx";
import { setCreatorWriting } from "./writing.ts";

/**
 * Create with AI: one screen that changes state (choose, describe, the card
 * being written, the showcase), joined by view transitions. Leaving it drops
 * the card and its portraits and keeps the description for a visit to
 * Settings; an unkept card asks first, and a card being kept holds the way
 * out until its Keep settles.
 */
export function CreateScreen() {
  const stage = useCreator((state) => state.stage);
  const status = useCreator((state) => state.card?.status ?? null);
  // Only a finished card, which no longer changes as text streams in.
  const complete = useCreator((state) => (state.card?.status === "complete" ? state.card : null));
  const developing = useCreator((state) => state.art?.status === "running");
  const scroller = useRef<HTMLDivElement>(null);
  // The lamp glow breathes behind the frame, and the navigation lamp at the
  // same pace, while the card or its art is in progress.
  const busy = status === "writing" || developing;

  useEffect(() => {
    setCreatorWriting(busy);
  }, [busy]);
  useEffect(() => {
    // A new visit starts fresh: the last Keep's gallery note has had its moment.
    keptStore.setState({ kept: null });
    return () => {
      setCreatorWriting(false);
      creatorStore.getState().returnToDescription();
    };
  }, []);

  return (
    <main
      data-writing={busy ? "" : undefined}
      className="relative flex min-w-0 flex-1 flex-col [timeline-scope:--thread]"
    >
      <ScreenHeader
        lead={<BackToGallery />}
        storyTitle={false}
        title="Create with AI"
        gutters={SCROLL_GUTTERS}
        frame={
          stage === "choose" || stage === "describe" || status === null ? COLUMN : CREATOR_FRAME
        }
      />
      <div
        ref={scroller}
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        {stage === "choose" ? (
          <Choose />
        ) : stage === "describe" || status === null ? (
          <Describe />
        ) : complete !== null ? (
          <Showcase card={complete} />
        ) : (
          <Writing scroller={scroller} />
        )}
      </div>
      {complete !== null && <KeepBar kind={complete.kind} />}
      <LeaveGuard />
    </main>
  );
}

function BackToGallery() {
  const phone = useFormFactor() === "phone";
  return phone ? (
    <Link
      to="/characters"
      aria-label="Back to characters"
      className={buttonVariants({ size: "icon" })}
    >
      <BackIcon />
    </Link>
  ) : (
    <Link to="/characters" className={cn(buttonVariants(), "pl-2")}>
      <BackIcon size={16} />
      Characters
    </Link>
  );
}

/** Whether leaving now would lose a card, or cut short its Keep. */
const guarded = () => {
  const state = creatorStore.getState();
  return keeping(state) || hasUnsavedCard(state);
};

/**
 * Leaving with a card that has not been kept asks first, as leaving a chat
 * does; a reload too. While Keep saves, leaving waits: the dialog says the
 * card is being kept, and once it is the owner goes on. A Keep that fails
 * to save the card turns the dialog into the usual question.
 */
function LeaveGuard() {
  const saving = useCreator(keeping);
  const unsaved = useCreator(hasUnsavedCard);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname && guarded(),
    enableBeforeUnload: identity.guard(guarded),
    withResolver: true,
  });
  const blocked = blocker.status === "blocked";
  const proceed = blocker.proceed;
  useEffect(() => {
    if (blocked && !saving && !unsaved) proceed?.();
  }, [blocked, saving, unsaved, proceed]);
  return (
    <AlertDialog open={blocked} onOpenChange={(open) => !open && blocker.reset?.()}>
      <AlertDialogContent
        title={saving ? "Keeping this character…" : "Leave and lose it?"}
        description={
          saving
            ? "It is being saved. You leave as soon as it is kept."
            : "This character has not been kept. Nothing of it is saved anywhere, so it cannot be restored."
        }
      >
        <AlertDialogClose render={<Button variant="quiet" />} onClick={() => blocker.reset?.()}>
          Stay
        </AlertDialogClose>
        {!saving && (
          <AlertDialogClose
            render={<Button variant="dangerSolid" />}
            onClick={() => blocker.proceed?.()}
          >
            Leave
          </AlertDialogClose>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
