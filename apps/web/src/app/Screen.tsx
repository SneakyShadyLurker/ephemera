import type { ReactNode } from "react";
import { MarkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useChat } from "../chat/session.ts";
import { useCreatorWriting } from "../creator/writing.ts";
import { ChunkLoadError } from "./chunk-error.ts";
import { useFormFactor } from "./form-factor.ts";
import { setNavOpen } from "./ui.ts";

/** Whether anything is being written now (a chat reply, a card or its art): the lamp breathes faster then. */
export function useInFlight(): boolean {
  const reply = useChat((state) => state.generating);
  const creating = useCreatorWriting();
  return reply || creating;
}

/*
 * Frames: where a screen's body sits, its cap, padding and anchoring. The
 * header takes the same frame from tablet up, so its contents sit on the
 * edges of the body they act on.
 */

/**
 * A body scroller's gutters from tablet up: room for a standard scrollbar
 * kept on both sides, so a centred frame stays centred whether or not it
 * scrolls. Its header takes the same class as `gutters` to keep the same room.
 */
export const SCROLL_GUTTERS = "tablet:[scrollbar-gutter:stable_both-edges]";
/** The same room at the end only, for a pane anchored at its start (the lorebook's editor beside its list). */
export const SCROLL_GUTTER_END = "tablet:[scrollbar-gutter:stable]";

/** Galleries: the window filled up to a generous cap, with gutters that grow with it. */
export const BROWSE_FRAME = "mx-auto w-full max-w-browse px-4 tablet:px-[clamp(1rem,3vw,4rem)]";
/**
 * A gallery's cards inside `BROWSE_FRAME` as an `@container`: as many columns
 * as fit, the card's minimum growing with the space. The minimum leaves six
 * columns on a 1440px window whether the scrollbars overlay the content or
 * take their gutters (`SCROLL_GUTTERS`).
 */
export const BROWSE_GRID =
  "grid grid-cols-2 gap-x-3.5 gap-y-6 tablet:grid-cols-[repeat(auto-fill,minmax(clamp(10.25rem,12cqi,13rem),1fr))] tablet:gap-x-6 tablet:gap-y-8";
/** One quiet page column: settings, an empty gallery. */
export const PAGE_FRAME = "mx-auto w-full max-w-page px-5 tablet:px-6";

/**
 * A screen's 56px header row. On phones it starts with the navigation button,
 * the breathing mark, which quickens while a reply is written; the hairline appears only once content scrolls beneath it.
 */
export function ScreenHeader({
  title,
  children,
  edge,
  lead,
  storyTitle,
  frame,
  gutters,
}: {
  title: ReactNode;
  children?: ReactNode;
  /** Drawn along the bottom edge, over the hairline (the chat's context meter). */
  edge?: ReactNode;
  /** Before the title, after the phone's navigation button (the chat's small portrait); the title then takes the story face. */
  lead?: ReactNode;
  /** The story face for a title after a `lead`, or for a character's name; false keeps the interface sans (a back control is not a character). */
  storyTitle?: boolean;
  /** The body's frame (a frame constant), which the contents take from tablet up; the hairline stays full width. */
  frame?: string;
  /** The gutter class the body's scroller keeps (`SCROLL_GUTTERS`, the chat thread's own alike), so the header keeps the same room. */
  gutters?: string;
}) {
  const phone = useFormFactor() === "phone";
  const writing = useInFlight();
  const story = storyTitle ?? lead !== undefined;
  return (
    <header className="header-hairline relative box-content flex h-14 shrink-0 border-b pt-[env(safe-area-inset-top)]">
      <div className={cn("flex min-w-0 flex-1", gutters && cn("overflow-hidden", gutters))}>
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1",
            frame ?? "tablet:px-6",
            // Phone headers keep their own padding, whatever the body's.
            "max-tablet:px-2",
          )}
        >
          {phone && (
            <Button size="icon" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
              <MarkIcon breathing writing={writing} size={24} />
            </Button>
          )}
          {lead}
          <h1
            className={cn(
              "min-w-0 flex-1 truncate text-ink tablet:px-0",
              lead ? "pr-2 pl-1" : "px-2",
              story ? "font-[450] font-story text-[1.125rem] leading-6" : "font-semibold text-lead",
            )}
          >
            {title}
          </h1>
          {children}
        </div>
      </div>
      {edge}
    </header>
  );
}

/**
 * What a screen shows when its code or data throws while rendering: calm,
 * content-free (an error's message can quote card text), inside the app
 * shell so navigation and the sign-in notice stay. The chat lives outside
 * the screen and is not touched.
 */
export function ScreenError({ error, reset }: { error: unknown; reset: () => void }) {
  const chunk = error instanceof ChunkLoadError;
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <ScreenHeader title="Something went wrong" />
      <div className="grid justify-items-start gap-3 px-5 py-8 tablet:px-8">
        <p
          data-skip-target=""
          tabIndex={-1}
          role="alert"
          className="max-w-measure text-pretty text-lead text-reed outline-none"
        >
          {chunk
            ? "This screen's code did not arrive, and the browser keeps that until the page reloads. Your chat is still here; a reload brings the screen back and ends the chat."
            : "This screen could not load. Your chat is still here."}
        </p>
        {!chunk && (
          <Button variant="outline" onClick={reset}>
            Try again
          </Button>
        )}
      </div>
    </main>
  );
}

/** A quiet screen with a title and one sentence, such as Not found. */
export function PlaceholderScreen({ title, note }: { title: string; note: string }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <ScreenHeader title={title} />
      <div className="overflow-y-auto px-5 py-8 [scroll-timeline:--thread] tablet:px-8">
        <p
          data-skip-target=""
          tabIndex={-1}
          className="max-w-measure text-pretty text-lead text-reed outline-none"
        >
          {note}
        </p>
      </div>
    </main>
  );
}

/** The first Tab stop on every screen: straight to its main content (the message field in chat). */
export function SkipToContent() {
  return (
    <button
      type="button"
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-surface focus-visible:px-3 focus-visible:py-2 focus-visible:text-ink focus-visible:text-ui"
      onClick={() => document.querySelector<HTMLElement>("[data-skip-target]")?.focus()}
    >
      Skip to content
    </button>
  );
}
