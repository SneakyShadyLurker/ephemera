import { Link, useBlocker, useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, use, useEffect, useId, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import {
  BackControl,
  type BackTarget,
  HeaderActions,
  HeaderFrame,
  HeaderTitle,
  PHONE_TOOLBAR,
} from "@/app/Header.tsx";
import { SCROLL_GUTTERS } from "@/app/Screen.tsx";
import { CheckIcon, SavingIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useSignedIn } from "../signin/hooks.ts";
import { identity } from "../signin/identity.ts";
import { SignInSheetRow } from "../signin/SignInSlots.tsx";
import { isFailure, type SaveStatus, saveStatusText } from "./autosave.ts";
import { AuthoringField, FieldSaving } from "./FieldFeedback.tsx";
import { TITLE_FIELD } from "./fields.ts";

/*
 * The sheet frame shared by characters, personas and presets:
 * a back link, the name joining the header on scroll, the save state, the
 * sheet's actions, and one scrolling form on the sheet grid (`SHEET_GRID`).
 */

export type { BackTarget } from "@/app/Header.tsx";

/**
 * The sheet's occupied frame: the form, or the form, the gap and an aside
 * centred as one block, the aside being the character sheet's index
 * (characters/Sheet.tsx `SheetIndex`) or the prompt preset sheet's
 * formatting key (presets/FormattingKey.tsx). Content-box, so the cap is
 * the content's and the padding sits outside it.
 */
export const SHEET_FRAME = {
  form: "mx-auto box-content max-w-form px-5 tablet:px-6",
  indexed:
    "mx-auto box-content max-w-[calc(var(--container-form)+var(--gap-index)+var(--container-index))] px-5 tablet:px-6",
  keyed:
    "mx-auto box-content max-w-[calc(var(--container-form)+var(--gap-index)+var(--container-key))] px-5 tablet:px-6",
} as const;

/** A frame with an aside beside the form. */
type AsideFrame = Exclude<keyof typeof SHEET_FRAME, "form">;

/** The form's column and the aside's, for each frame with an aside. */
const ASIDE_COLUMNS: Record<AsideFrame, string> = {
  indexed: "grid-cols-[minmax(0,1fr)_var(--container-index)]",
  keyed: "grid-cols-[minmax(0,1fr)_var(--container-key)]",
};

/** The editor's own destination after its first save replaces the new-sheet URL. */
export const SheetPathname = createContext<string | null>(null);

/** A destination is loading after the leave guard passed; the outgoing fields must stop accepting edits. */
export function useLeavingSheet(): boolean {
  const pathname = use(SheetPathname);
  return useRouterState({
    select: (state) =>
      state.isLoading && state.location.pathname !== (pathname ?? state.matches.at(-1)?.pathname),
  });
}

export function SheetHeaderFrame({
  back,
  frame,
  gutters,
  title,
  titleProps,
  titleClassName,
  subtitle,
  titleReplacement,
  direct,
  children,
}: {
  back: BackTarget;
  frame?: string;
  gutters?: string | undefined;
  title?: ReactNode;
  titleProps?: { id?: string; tabIndex?: number; "aria-label"?: string };
  titleClassName?: string;
  subtitle?: ReactNode;
  titleReplacement?: ReactNode;
  direct?: ReactNode;
  children?: ReactNode;
}) {
  const leaving = useLeavingSheet();
  const phone = useFormFactor() === "phone";
  return (
    <HeaderFrame
      frame={frame}
      gutters={gutters}
      toolbar={
        phone && direct ? (
          <HeaderActions
            role="toolbar"
            aria-label="Sheet actions"
            className={PHONE_TOOLBAR}
            inert={leaving}
          >
            {direct}
          </HeaderActions>
        ) : undefined
      }
    >
      <BackControl back={back} />
      <div className="contents" inert={leaving}>
        {title !== undefined ? (
          <>
            <div className="min-w-0 flex-1 px-2">
              {titleReplacement ?? (
                <HeaderTitle {...titleProps} className={cn("px-0", titleClassName)}>
                  {title}
                </HeaderTitle>
              )}
              {subtitle && <p className="truncate text-meta text-reed">{subtitle}</p>}
            </div>
            <HeaderActions>
              {!phone && direct}
              {children}
            </HeaderActions>
          </>
        ) : (
          <>
            {!phone && direct}
            {children}
          </>
        )}
      </div>
    </HeaderFrame>
  );
}

export function SaveState({
  status,
  creating,
  noun,
  short = false,
}: {
  status: SaveStatus;
  creating: boolean;
  noun: string;
  /** In the phone header: a conflict says only "Not saved", since its notice explains. */
  short?: boolean;
}) {
  const failure = isFailure(status, creating);
  return (
    <>
      <span
        key={status.kind}
        className={cn(
          "flex min-w-0 items-center gap-1 whitespace-nowrap text-meta transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
          failure ? "text-ember" : "text-reed",
          // A quick save never says Saving: the word shows only once the save lasts.
          status.kind === "saving" && "lamplight-late",
        )}
      >
        {status.kind === "saved" && <CheckIcon size={16} />}
        {status.kind === "saving" && <SavingIcon size={16} />}
        {/* Saved and Saving take the same room, so nothing beside them moves as they swap. */}
        <span
          className={cn(
            "grid min-w-0",
            (status.kind === "saved" || status.kind === "saving") &&
              "after:invisible after:content-['Saving'] after:[grid-area:1/1]",
          )}
        >
          <span className="truncate [grid-area:1/1]">
            {short && status.kind === "conflict"
              ? "Not saved"
              : saveStatusText(status, creating, noun)}
          </span>
        </span>
      </span>
      {/* Only transitions into a not-saved state are announced; Saved and Saving stay quiet. */}
      <span role="alert" className="sr-only">
        {failure ? saveStatusText(status, creating, noun) : ""}
      </span>
    </>
  );
}

/**
 * The sheet's header: back, the name (which fades in once the name field
 * scrolls beneath it), the save state (in place of the name on phones when
 * something is not saved), then the sheet's actions.
 */
export function SheetHeader({
  back,
  title,
  status,
  creating,
  noun,
  frame = SHEET_FRAME.form,
  gutters = SCROLL_GUTTERS,
  direct,
  children,
}: {
  back: BackTarget;
  title: string;
  status: SaveStatus;
  creating: boolean;
  noun: string;
  /** The body's frame; the form's by default. */
  frame?: string;
  /** The body scroller's gutter class; SheetBody keeps `SCROLL_GUTTERS`. */
  gutters?: string;
  /** Commands kept on a second labelled row on phones, after Saved on wider screens. */
  direct?: ReactNode;
  children?: ReactNode;
}) {
  const phone = useFormFactor() === "phone";
  const failing = phone && isFailure(status, creating);
  return (
    <SheetHeaderFrame
      back={back}
      frame={frame}
      gutters={gutters}
      title={title}
      titleClassName="title-in"
      titleReplacement={
        failing ? <SaveState status={status} creating={creating} noun={noun} short /> : undefined
      }
      subtitle={
        phone && !failing ? (
          <SaveState status={status} creating={creating} noun={noun} short />
        ) : undefined
      }
      direct={phone ? direct : undefined}
    >
      {!phone && (
        <span className="px-2">
          <SaveState status={status} creating={creating} noun={noun} />
        </span>
      )}
      {!phone && direct}
      {children}
    </SheetHeaderFrame>
  );
}

/** A failed sheet action (duplicate, delete), said once in words. */
export function SheetNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 text-ember text-note arrive">
      <p className="flex-1">{notice}</p>
      <Button size="text" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** What one autosave tells a leave guard: its state, and how to save what is left before leaving. */
interface GuardedSaving {
  status: SaveStatus;
  hasUnsaved: () => boolean;
  flush: () => Promise<boolean>;
}

/** One autosave as a screen's shared leave guard holds it (`useLeaveGuardScope`). */
interface ScopedSaving extends GuardedSaving {
  creating: boolean;
  noun: string;
}

type ReportSaving = (key: string, saving: ScopedSaving | null) => void;

/**
 * Inside it, a leave guard reports its autosave to the screen's one guard
 * instead of asking on its own, so a screen with several (the Memory
 * screen's notebook and an open memory) never asks twice.
 */
export const LeaveGuardScope = createContext<ReportSaving | null>(null);

/**
 * Leaving saves first; only an edit that could not be saved asks. `leaving`
 * tells a first save in flight that a navigation is waiting for it. Inside a
 * `LeaveGuardScope` the scope's guard asks instead, and `leaving` is not told.
 */
export function useLeaveGuard(
  autosave: GuardedSaving,
  setLeaving: (leaving: boolean) => void,
  creating: boolean,
  noun: string,
): ReactNode {
  const report = use(LeaveGuardScope);
  const key = useId();
  const { status, hasUnsaved, flush } = autosave;
  useEffect(() => {
    if (report === null) return;
    report(key, { status, hasUnsaved, flush, creating, noun });
    return () => report(key, null);
  }, [report, key, status, hasUnsaved, flush, creating, noun]);
  return useLeavePrompt(autosave, setLeaving, creating, noun, report !== null);
}

const SAVED = { kind: "saved" } as const;

/**
 * The part a shared leave prompt speaks for: the first holding edits that
 * are not saved, signed out or still saving included, so the prompt never
 * reads "Saved" over edits it would discard.
 */
export const unsavedPart = <Part extends GuardedSaving>(parts: readonly Part[]): Part | undefined =>
  parts.find((part) => part.status.kind !== "saved" && part.hasUnsaved());

/** What a screen's header says over several autosaves: the state of one, and what it saves. */
export interface ScreenSaving {
  status: SaveStatus;
  noun: string;
}

/**
 * The state a screen's one header shows over its autosaves: a failure
 * first, then signed out, then saving, else Saved; so it never reads Saved
 * while any part says it is not.
 */
export function screenSaving(parts: readonly ScopedSaving[]): ScreenSaving | null {
  const first =
    parts.find((part) => isFailure(part.status, part.creating)) ??
    parts.find((part) => part.status.kind !== "saved" && part.status.kind !== "saving") ??
    parts.find((part) => part.status.kind === "saving") ??
    parts[0];
  return first === undefined ? null : { status: first.status, noun: first.noun };
}

/**
 * A screen's one leave guard over every autosave reporting to it (wrap them
 * in `LeaveGuardScope` with the returned report): leaving saves them all
 * first, and asks once, in the words of the first that could not be saved.
 * It also gives the screen's save state over them all (`screenSaving`),
 * null while none reports.
 */
export function useLeaveGuardScope(): [ReportSaving, ReactNode, ScreenSaving | null] {
  const [parts, setParts] = useState<ReadonlyMap<string, ScopedSaving>>(new Map());
  const [report] = useState<ReportSaving>(
    () => (key: string, saving: ScopedSaving | null) =>
      setParts((current) => {
        const next = new Map(current);
        if (saving === null) next.delete(key);
        else next.set(key, saving);
        return next;
      }),
  );
  const list = [...parts.values()];
  const stuck = unsavedPart(list);
  const guard: GuardedSaving = {
    status: stuck?.status ?? SAVED,
    hasUnsaved: () => list.some((part) => part.hasUnsaved()),
    flush: async () => {
      const flushed = await Promise.all(
        list.filter((part) => part.hasUnsaved()).map((part) => part.flush()),
      );
      return flushed.every(Boolean);
    },
  };
  const prompt = useLeavePrompt(
    guard,
    () => {},
    stuck?.creating ?? false,
    stuck?.noun ?? "",
    false,
  );
  return [report, prompt, screenSaving(list)];
}

function useLeavePrompt(
  autosave: GuardedSaving,
  setLeaving: (leaving: boolean) => void,
  creating: boolean,
  noun: string,
  disabled: boolean,
): ReactNode {
  const blocker = useBlocker({
    disabled,
    // Within one screen (the lorebook's `?entry=`) nothing is left behind: edits keep saving.
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname || !autosave.hasUnsaved()) return false;
      setLeaving(true);
      try {
        const saved = await autosave.flush();
        setLeaving(false);
        return !saved;
      } catch {
        setLeaving(false);
        return true;
      }
    },
    enableBeforeUnload: identity.guard(() => autosave.hasUnsaved()),
    withResolver: true,
  });
  if (disabled) return null;
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => !open && blocker.reset?.()}
      title="Leave without saving?"
      description={`${saveStatusText(autosave.status, creating, noun)}. Leaving now discards the edits that were not saved.`}
      confirm="Leave"
      cancel="Stay"
      onCancel={() => blocker.reset?.()}
      onConfirm={() => blocker.proceed?.()}
    />
  );
}

/** The sheet's one scroll owner and form; forms cannot nest, so everything inside is one form. */
export function SheetBody({
  label,
  onBlur,
  aside,
  asideFrame = "indexed",
  children,
  after,
  saving,
  compactOnPhone = false,
}: {
  label: string;
  onBlur: () => void;
  aside?: ReactNode;
  /** The frame the aside sits in; its header takes the same (SheetHeader's `frame`). */
  asideFrame?: AsideFrame;
  children: ReactNode;
  /** A notice kept at the end of the fields, sticky above the bottom (a save conflict). */
  after?: ReactNode;
  saving?: { status: SaveStatus; noun: string };
  compactOnPhone?: boolean;
}) {
  // While the sign-in notice floats at the end, a focused field scrolls clear of it.
  const signedIn = useSignedIn();
  const leaving = useLeavingSheet();
  return (
    <div
      inert={leaving}
      data-skip-target=""
      tabIndex={-1}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
        SCROLL_GUTTERS,
        (!signedIn || Boolean(after)) && "scroll-pb-40",
      )}
    >
      <div
        className={cn(
          "relative pt-4 pb-16 tablet:pt-8",
          aside
            ? cn(SHEET_FRAME[asideFrame], "grid gap-index", ASIDE_COLUMNS[asideFrame])
            : SHEET_FRAME.form,
        )}
      >
        <SheetTitleBoundary />
        <form
          aria-label={label}
          className={cn(
            "grid grid-cols-[minmax(0,1fr)] gap-10",
            compactOnPhone && "max-tablet:gap-6",
          )}
          onSubmit={(event) => event.preventDefault()}
          onBlur={onBlur}
        >
          <FieldSaving value={saving ?? null}>{children}</FieldSaving>
          <SignInSheetRow />
          {after}
        </form>
        {aside}
      </div>
    </div>
  );
}

/** Every sheet uses the same interruptible title threshold, at its actual in-page title. */
export function SheetTitleBoundary({ alwaysVisible = false }: { alwaysVisible?: boolean }) {
  const titleBoundary = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const boundary = titleBoundary.current;
    const scroller = boundary?.closest<HTMLElement>("[data-sheet-scroller], [data-skip-target]");
    const sheet = scroller?.closest("main");
    if (!boundary || !scroller || !sheet) return;
    const title = scroller.querySelector("[data-sheet-heading]") ?? boundary;
    // Observe the threshold without a compositor timeline trigger: a block expanding
    // while focus scrolls the sheet can interrupt that trigger's animation.
    const observer = new IntersectionObserver(
      ([entry]) => {
        sheet.toggleAttribute(
          "data-sheet-title",
          alwaysVisible ||
            (entry !== undefined &&
              !entry.isIntersecting &&
              entry.rootBounds !== null &&
              entry.boundingClientRect.bottom <= entry.rootBounds.top),
        );
      },
      { root: scroller },
    );
    observer.observe(title);
    return () => {
      observer.disconnect();
      sheet.removeAttribute("data-sheet-title");
    };
  }, [alwaysVisible]);
  return (
    <span
      ref={titleBoundary}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 h-px w-px"
    />
  );
}

/** The sheet's large name field: one wrapping row, Enter ignored, line breaks become spaces. */
export function NameField({
  value,
  placeholder = "Name",
  maxLength,
  autoSelect = false,
  readOnly = false,
  onChange,
}: {
  value: string;
  placeholder?: string;
  maxLength: number;
  /** Selects the name once, for an entity that was just created with a placeholder name. */
  autoSelect?: boolean;
  /** While an AI Rework works or is under review. */
  readOnly?: boolean;
  onChange: (name: string) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoSelect) field.current?.select();
  }, [autoSelect]);
  return (
    <AuthoringField
      ref={field}
      data-sheet-heading=""
      aria-label="Name"
      rows={1}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      readOnly={readOnly}
      aria-readonly={readOnly || undefined}
      onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
      onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, " "))}
      className={cn(
        TITLE_FIELD,
        // On touch its 36px line sits near the middle of the 44px target.
        "w-full resize-none text-title-phone tracking-[-0.015em] [field-sizing:content] touch:py-0.5 tablet:text-title",
      )}
    />
  );
}

/**
 * What a sheet screen shows for the entity `id`. Its route loads a fresh copy
 * before arrival (the editor seeds its fields once); an error replaces the editor
 * only before that entity's editor first appeared, so a failed background
 * refetch never discards unsaved edits. The screen stays mounted when only
 * the id changes (Duplicate, Back), so what was shown is kept per id.
 */
export function useSheetState(
  id: string,
  query: { data: unknown; isError: boolean },
): "error" | "loading" | "ready" {
  const ready = query.data !== undefined;
  const [shownFor, setShownFor] = useState<string | null>(null);
  useEffect(() => {
    if (ready && !query.isError) setShownFor(id);
  }, [id, ready, query.isError]);
  if (query.isError && shownFor !== id) return "error";
  return ready ? "ready" : "loading";
}

/** Where a missing sheet's way back leads: a list, or the chat that opened it. */
type MissingBack =
  | { to: "/characters" | "/personas" | "/lorebooks" | "/presets"; label: string }
  | { to: "/"; label: "Chat" };

/**
 * A sheet whose entity did not load: the header's way back, what happened,
 * Try again unless the entity is gone, and the way back in words.
 */
export function SheetMissing({
  back,
  noun,
  notFound,
  onRetry,
}: {
  back: MissingBack;
  noun: string;
  notFound: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <SheetHeaderFrame back={back}>
        <span />
      </SheetHeaderFrame>
      <div role="alert" className="grid justify-items-start gap-3 px-5 pt-[12dvh] tablet:px-16">
        <p className="text-lead text-reed">
          This {noun} could not be {notFound ? "found" : "loaded"}.
        </p>
        <div className="flex flex-wrap gap-2">
          {!notFound && (
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Link
            to={back.to}
            className={buttonVariants({ variant: notFound ? "outline" : "quiet" })}
          >
            {back.to === "/" ? "Back to the chat" : `Back to ${back.label.toLowerCase()}`}
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * A sheet waiting for its entity's fresh copy: nothing at first, and once
 * the wait lasts, the column's top rule with a light passing along it.
 */
export function SheetLoading() {
  return (
    <main className="flex-1" aria-busy="true">
      <div className={cn(SHEET_FRAME.form, "pt-[calc(3.5rem+env(safe-area-inset-top))]")}>
        <div aria-hidden="true" className="lamplight-late relative h-px bg-rush">
          <span className="lamplight-edge" />
        </div>
      </div>
    </main>
  );
}

/**
 * Whether a sheet shows the entity it just created, kept through the
 * redirect from its "new" id: the router keeps the screen mounted when only
 * the id changes (TanStack Router's default remount rule), so the editor
 * stays. Another id (a Duplicate, then Back) or `forget` (Reload, which
 * fetches the saved entity) leaves it.
 */
export function useCreated(id: string): {
  fresh: boolean;
  created: string | null;
  onCreated: (id: string) => void;
  forget: () => void;
} {
  const [created, setCreated] = useState<string | null>(null);
  if (created !== null && id !== created && id !== "new") setCreated(null);
  return {
    fresh: id === "new" || id === created,
    created,
    onCreated: setCreated,
    forget: () => setCreated(null),
  };
}
