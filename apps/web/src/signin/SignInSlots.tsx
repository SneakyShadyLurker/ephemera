import { type RefObject, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { noticeFold } from "@/app/NoticeCard.tsx";
import { SCRIPT_FRAME } from "../chat/frame.ts";
import { useChat } from "../chat/session.ts";
import { SHEET_GRID } from "../sheet/fields.ts";
import { useSignInPhase } from "./hooks.ts";
import { SignInNotice, type Waiting } from "./SignInNotice.tsx";
import { signIn } from "./signin.ts";

/** How long "Signed in again" stays before it folds away. */
const RENEWED_NOTICE_MS = 4_000;

/** What the notice says waits for the session: the chat's generation first, then edits. */
function useWaiting(): Waiting {
  const pending = useChat((state) => state.pending !== null);
  const edits = useStore(signIn.store, (state) => state.edits > 0);
  const resumed = useStore(signIn.store, (state) => state.resumed);
  const phase = useSignInPhase();
  if (phase === "renewed") return resumed;
  return pending ? "send" : edits ? "edits" : "nothing";
}

/**
 * The notice with its lifecycle: it folds away after "Signed in again", and
 * when its button leaves while focused, focus returns to where it came from
 * (or to `fallback`), never to the page.
 */
function Notice({
  placement,
  fallback,
}: {
  placement: "dock" | "float";
  fallback?: RefObject<HTMLElement | null>;
}) {
  const phase = useSignInPhase();
  const waiting = useWaiting();
  const [leaving, setLeaving] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLeaving(false);
    if (phase !== "renewed") return;
    const timer = setTimeout(() => setLeaving(true), RENEWED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // The button is gone once renewed: focus it held goes back, not to the page.
  useEffect(() => {
    if (phase !== "renewed" || document.activeElement !== document.body) return;
    const target = returnTo.current?.isConnected ? returnTo.current : fallback?.current;
    target?.focus();
  }, [phase, fallback]);

  if (phase === "active") return null;
  return (
    <div
      ref={frame}
      onFocusCapture={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !frame.current?.contains(from)) returnTo.current = from;
      }}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget && event.propertyName === "height")
          signIn.dismiss();
      }}
      className={noticeFold(leaving)}
    >
      <div className={placement === "dock" ? "pb-2" : undefined}>
        <SignInNotice
          phase={phase}
          waiting={waiting}
          placement={placement}
          onSignIn={() => signIn.signIn()}
        />
      </div>
    </div>
  );
}

/** Above the composer, in the script frame: the chat's slot for the notice. */
export function SignInDock({ composer }: { composer: RefObject<HTMLElement | null> }) {
  useClaimNotice();
  return (
    <div className={`${SCRIPT_FRAME} shrink-0`}>
      <Notice placement="dock" fallback={composer} />
    </div>
  );
}

/** The last row of a sheet's field column, sticky above the bottom edge. */
export function SignInSheetRow() {
  useClaimNotice();
  const phase = useSignInPhase();
  if (phase === "active") return null;
  return (
    <div className={`${SHEET_GRID} sticky bottom-3 z-10 tablet:bottom-6`}>
      <div className="hidden tablet:block" />
      <Notice placement="float" />
    </div>
  );
}

/** Every other screen: the notice floats over the bottom of the content column. */
export function SignInFloat() {
  const claimed = useStore(claims, (count) => count > 0);
  if (claimed) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] tablet:px-6 tablet:pb-6">
      <div className="pointer-events-auto w-full max-w-notice">
        <Notice placement="float" />
      </div>
    </div>
  );
}

/** How many mounted screens place the notice themselves; the float yields to them. */
const claims = createStore<number>()(() => 0);

function useClaimNotice() {
  useEffect(() => {
    claims.setState((count) => count + 1);
    return () => claims.setState((count) => count - 1);
  }, []);
}
