import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { type CreatorKind, imagePromptModelOf } from "@ephemera/core";
import { type Ref, type RefObject, useId, useRef } from "react";
import { useStore } from "zustand";
import { useFormFactor } from "@/app/form-factor.ts";
import { CloseIcon } from "@/components/icons";
import { DIALOG_SURFACE, SCRIM } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { SwitchField } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { useModelInfo } from "../api.ts";
import {
  ArtAlternates,
  ArtControls,
  ArtFrame,
  ArtStatus,
  CHOICE_LABEL,
  CHOICE_ROW,
  NewArt,
  useArtShowing,
} from "../creator/ArtStack.tsx";
import {
  type ArtSessionHost,
  ArtSessionProvider,
  useArtBatch,
  useArtSession,
} from "../creator/art-session.tsx";
import { FullPortrait, Leaf } from "../portraits/Portrait.tsx";
import { PortraitViewer } from "../portraits/PortraitViewer.tsx";
import { portraitDefault } from "../rework/portrait-switch.ts";
import { useSetting } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { useSignInPhase } from "../signin/hooks.ts";
import { SignInNotice } from "../signin/SignInNotice.tsx";
import { signIn } from "../signin/signin.ts";
import { sheetArtStore, useSheetArt } from "./session.ts";
import type { UseRun } from "./store.ts";

/*
 * New art for a saved character: the showcase's art regions (ArtStack.tsx)
 * in a studio over the sheet, a dialog on tablet and desktop and the bottom
 * drawer on phones. A fixed header and footer around one scrolling body:
 * the art (the 2:3 frame and the four), the choices for the next batch with
 * Kind and Match first and the direction last, and the run's status. The
 * footer's primary action is what happens next: New art until a batch is on
 * show, then Use as portrait. Close stops a run in flight and keeps the
 * candidates until the sheet is left.
 */

/** The sheet's words where the art is off, stopped or unavailable: the portrait stays. */
const SHEET_ART_COPY: ArtSessionHost["copy"] = {
  off: "Add a ComfyUI address in Settings to paint portraits. The portrait stays as it is.",
  stopped: "Art stopped.",
  unavailable: "Portraits unavailable.",
};

const KINDS: readonly (readonly [CreatorKind, string])[] = [
  ["subject", "Subject"],
  ["group", "Group photo"],
  ["scenario", "Scenario still"],
];

/** The image prompt's shape for the next batch; a session choice, the card's tags unchanged. */
function KindChoice({ disabled, phone }: { disabled: boolean; phone: boolean }) {
  const kind = useSheetArt((state) => state.kind);
  const labelId = useId();
  return (
    // Phones set the label over the three, which take the whole width.
    <div className={cn(CHOICE_ROW, phone && "@3xs:col-span-2 @3xs:grid-cols-1")}>
      <span id={labelId} className={CHOICE_LABEL}>
        Kind
      </span>
      <ToggleGroup
        aria-labelledby={labelId}
        value={[kind]}
        disabled={disabled}
        onValueChange={(next) => {
          const chosen = KINDS.find(([option]) => option === next[0]);
          if (chosen) sheetArtStore.getState().setKind(chosen[0]);
        }}
        className={phone ? "grid w-full grid-cols-3" : "w-fit"}
      >
        {KINDS.map(([option, text]) => (
          <ToggleGroupItem
            key={option}
            value={option}
            labelled
            className={cn(phone && "justify-center px-1 text-note")}
          >
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * Whether the prompt model sees the stored portrait, as the switch stands
 * for the effective model (`portraitDefault`, the same rule the session
 * sends by), with the portrait itself at the row's end opening larger.
 * Only when the character has one.
 */
function MatchSwitch({
  characterId,
  name,
  portrait,
  disabled,
}: {
  characterId: string;
  name: string;
  portrait: number | null;
  disabled: boolean;
}) {
  const saved = useSetting((settings) => settings.model);
  const setting = useSetting((settings) => settings.imagePromptModel);
  const artModel = useArtSession((state) => state.artModel);
  const choice = useSheetArt((state) => state.reference);
  const info = useModelInfo(imagePromptModelOf(artModel, setting, saved));
  const shown = portraitDefault(info, portrait !== null);
  if (portrait === null || !shown.shown) return null;
  const label = `Current portrait of ${name}`;
  return (
    <div className="flex items-start justify-between gap-4 @3xs:col-span-2">
      <SwitchField
        label="Match current portrait"
        description={
          info?.images === true ? "Uses the portrait as a visual reference" : shown.description
        }
        checked={shown.enabled && (choice ?? shown.on)}
        disabled={disabled || !shown.enabled}
        onCheckedChange={(checked) => sheetArtStore.getState().setReference(checked)}
      />
      <PortraitViewer
        label={label}
        art={<FullPortrait id={characterId} version={portrait} shown="thumb" />}
        className="shrink-0 rounded-[5px]"
      >
        <Leaf id={characterId} version={portrait} className="w-9 touch:w-11" />
      </PortraitViewer>
    </div>
  );
}

/**
 * The footer's primary action, what happens next: New art until a batch is
 * on show, then Use as portrait ("Retry save" after a failed save, "Saving
 * portrait…" while it saves). Disabled while a run paints or the sheet holds
 * the portrait, it keeps focus, so a keyboard never drops to the page.
 */
export function StudioPrimary({
  useRun,
  noModel,
  onUse,
  className,
  ref,
}: {
  useRun: UseRun | null;
  /** No model to write the image prompt: New art cannot run. */
  noModel: boolean;
  onUse: () => void;
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
}) {
  const showing = useArtShowing();
  const { usable } = useArtBatch();
  if (showing !== "batch") {
    return <NewArt ref={ref} variant="primary" disabled={noModel} className={className} />;
  }
  const saving = useRun?.status === "saving";
  return (
    <Button
      ref={ref}
      variant="primary"
      disabled={saving || useRun?.status === "waiting" || !usable}
      focusableWhenDisabled
      className={className}
      onClick={onUse}
    >
      {saving ? "Saving portrait…" : useRun?.status === "failed" ? "Retry save" : "Use as portrait"}
    </Button>
  );
}

/** Use as portrait's own lines under the run's status: saving, waiting for the sign-in, or why it failed. */
function UseStatus({ useRun }: { useRun: UseRun | null }) {
  return (
    <>
      <p role="status" className="text-pretty text-note text-reed empty:sr-only">
        {useRun?.status === "saving"
          ? "Saving the portrait."
          : useRun?.status === "waiting"
            ? "Waiting for you to sign in"
            : ""}
      </p>
      {useRun?.status === "failed" && (
        <p role="alert" className="text-pretty text-ember text-note">
          {useRun.reason}
        </p>
      )}
    </>
  );
}

/** The sign-in notice inside the studio, since the sheet's own sits behind the modal. */
function StudioSignIn() {
  const phase = useSignInPhase();
  const edits = useStore(signIn.store, (state) => state.edits > 0);
  if (phase === "active") return null;
  return (
    <SignInNotice
      phase={phase}
      waiting={edits ? "edits" : "nothing"}
      placement="float"
      onSignIn={() => signIn.signIn()}
    />
  );
}

/** Portraits off: no ComfyUI address saved; the studio offers the way to Settings and Close. */
function PortraitsOff() {
  return (
    <div className="grid justify-items-start gap-3 text-note">
      <div className="grid gap-1">
        <p className="font-medium text-ink">Portraits off</p>
        <p className="text-pretty text-reed">{SHEET_ART_COPY.off}</p>
      </div>
      <WindowLink
        model={null}
        section="pictures"
        className={cn(buttonVariants({ variant: "outline" }), "h-8 w-fit text-note touch:h-11")}
      >
        Picture settings
      </WindowLink>
    </div>
  );
}

/**
 * The studio's body: the art, then Kind, Match, the choices and the
 * direction, then the status. Tablet and desktop set the art in its own
 * column, sized by the window's height so the frame and the four always fit;
 * phones set the frame beside the four in a 2x2 grid over the rest.
 */
function StudioBody({
  characterId,
  name,
  portrait,
  phone,
  disabled,
}: {
  characterId: string;
  name: string;
  portrait: number | null;
  phone: boolean;
  /** The choices wait: a run paints, or the sheet holds the portrait. */
  disabled: boolean;
}) {
  const portraits = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const showing = useArtShowing();
  const useRun = useSheetArt((state) => state.useRun);

  const art = phone ? (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-4">
      <ArtFrame name={name} phone className="h-[min(34dvh,16rem)]" />
      <ArtAlternates name={name} className="grid-cols-2" />
    </div>
  ) : (
    <div className="grid w-[min(12rem,max(9rem,calc((100dvh-13rem)/1.875)))] content-start gap-3 desktop:w-[min(18rem,max(10rem,calc((100dvh-13rem)/1.875)))]">
      <ArtFrame name={name} phone={false} />
      <ArtAlternates name={name} />
    </div>
  );
  const status = (
    <div className="grid content-start justify-items-start gap-3">
      {portraits ? (
        // The footer's New art is the one retry.
        <ArtStatus retry={false}>
          <UseStatus useRun={useRun} />
        </ArtStatus>
      ) : (
        <PortraitsOff />
      )}
      <StudioSignIn />
    </div>
  );
  const rest = (
    <div className="grid min-w-0 content-start gap-6">
      {portraits && (
        <ArtControls
          before={
            <>
              <KindChoice disabled={disabled} phone={phone} />
              <MatchSwitch
                characterId={characterId}
                name={name}
                portrait={portrait}
                disabled={disabled}
              />
            </>
          }
          newArt={showing === "batch" ? "inline" : "none"}
          directionLabel="visible"
          width="full"
          disabled={disabled}
        />
      )}
      {status}
    </div>
  );
  return (
    <div
      className={cn(
        "grid min-h-0 overflow-y-auto overscroll-contain",
        phone
          ? "flex-1 content-start gap-6 px-5 pt-1 pb-4"
          : "grid-cols-[auto_minmax(0,1fr)] gap-10 px-6 pt-2 pb-6 desktop:gap-14",
      )}
    >
      {art}
      {rest}
    </div>
  );
}

/**
 * The studio for `characterId`'s new art, open while `open`. `name` names
 * it and its candidates; `portrait` is the stored version for Match; `held`:
 * a rework or this session's save holds the portrait. `trigger` takes focus
 * back on closing. `onOpenChange(false)` asks to close; a save in progress
 * refuses it.
 */
export function ArtStudio({
  open,
  onOpenChange,
  characterId,
  name,
  portrait,
  held,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string;
  name: string;
  portrait: number | null;
  held: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const phone = useFormFactor() === "phone";
  const kind = useSheetArt((state) => state.kind);
  const saved = useSetting((settings) => settings.model);
  const setting = useSetting((settings) => settings.imagePromptModel);
  const artModel = useSheetArt((state) => state.artModel);
  const useRun = useSheetArt((state) => state.useRun);
  const painting = useSheetArt(
    (state) => state.art?.status === "running" || state.art?.status === "waiting",
  );
  const portraits = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const popupRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const saving = useRun?.status === "saving";
  const title = `New art for ${name}`;

  const host: ArtSessionHost = {
    store: sheetArtStore,
    kind,
    defaults: { model: saved, reasoning: "provider-default" },
    locked: held,
    leaving: false,
    copy: SHEET_ART_COPY,
    focusAfter: () => primaryRef.current,
  };

  // Escape, the scrim, a swipe and both Close buttons ask here; a save answers first.
  const change = (next: boolean, details: { cancel: () => void }) => {
    if (next) return;
    if (sheetArtStore.getState().useRun?.status === "saving") {
      details.cancel();
      return;
    }
    onOpenChange(false);
  };
  // A saved Use closes the studio through the binding's portrait callback (NewArtButton).
  const use = () => void sheetArtStore.getState().use();
  // The chosen candidate when the four are in place; a reopened batch may still decode, so
  // then the footer's action, which keeps the body scrolled to Kind and Match.
  const initialFocus = () =>
    popupRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
    primaryRef.current ??
    closeRef.current;

  const primary = portraits && (
    <StudioPrimary
      ref={primaryRef}
      useRun={useRun}
      noModel={imagePromptModelOf(artModel, setting, saved) === null}
      onUse={use}
      className={cn(phone && "flex-1")}
    />
  );
  const body = (
    <StudioBody
      characterId={characterId}
      name={name}
      portrait={portrait}
      phone={phone}
      disabled={held || painting}
    />
  );
  const writing = painting ? "" : undefined;

  if (phone) {
    return (
      <Drawer open={open} onOpenChange={change} swipeDirection="down" showSwipeHandle keyboardAware>
        <DrawerContent
          ref={popupRef}
          data-writing={writing}
          initialFocus={initialFocus}
          finalFocus={trigger}
          className="data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-1rem-env(safe-area-inset-top))]"
        >
          <ArtSessionProvider host={host}>
            <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-1 pb-3">
              <DrawerTitle className="text-balance text-heading">{title}</DrawerTitle>
              <DrawerClose
                render={
                  <Button size="icon" aria-label="Close" disabled={saving} className="-mr-2" />
                }
              >
                <CloseIcon />
              </DrawerClose>
            </div>
            {body}
            <div className="flex shrink-0 items-center gap-3 px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <DrawerClose render={<Button ref={closeRef} disabled={saving} className="px-3" />}>
                Close
              </DrawerClose>
              {primary}
            </div>
          </ArtSessionProvider>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={change}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className={SCRIM} />
        <DialogPrimitive.Popup
          ref={popupRef}
          data-writing={writing}
          initialFocus={initialFocus}
          finalFocus={trigger}
          className={cn(
            DIALOG_SURFACE,
            "grid grid-rows-[auto_minmax(0,1fr)_auto] [--dialog-width:44rem] desktop:[--dialog-width:58rem]",
          )}
        >
          <ArtSessionProvider host={host}>
            <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-4">
              <DialogPrimitive.Title className="text-balance font-semibold text-heading text-ink">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                render={
                  <Button size="icon" aria-label="Close" disabled={saving} className="-mr-2" />
                }
              >
                <CloseIcon size={20} />
              </DialogPrimitive.Close>
            </div>
            {body}
            <div className="flex items-center justify-end gap-2 px-6 pt-3 pb-5">
              <DialogPrimitive.Close render={<Button ref={closeRef} disabled={saving} />}>
                Close
              </DialogPrimitive.Close>
              {primary}
            </div>
          </ArtSessionProvider>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
