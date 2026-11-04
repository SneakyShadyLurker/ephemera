import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { MarkIcon, MenuIcon } from "@/components/icons";
import { Illustration } from "@/components/illustration.tsx";
import { MoreButton } from "@/components/more-button.tsx";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useChat } from "../chat/session.ts";
import { useCreatorWriting } from "../creator/writing.ts";
import { ChunkLoadError } from "./chunk-error.ts";
import { EmptyState } from "./EmptyState.tsx";
import { useFormFactor } from "./form-factor.ts";
import {
  BackControl,
  type BackTarget,
  HeaderActions,
  HeaderFrame,
  HeaderTitle,
} from "./Header.tsx";
import { setNavOpen } from "./ui.ts";

/** Whether anything is being written now (a chat reply, a card or its art): the mark's drip quickens then. */
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
export const BROWSE_BODY = "@container grid grid-cols-[minmax(0,1fr)] gap-5 pt-2 pb-10 tablet:pt-3";
export const BROWSE_FRAME = "mx-auto w-full max-w-browse px-4 tablet:px-[clamp(1rem,3vw,4rem)]";
/**
 * A gallery's cards inside `BROWSE_FRAME` as an `@container`: as many columns
 * as fit, the card's minimum growing with the space, so a wide window takes
 * larger cards rather than more empty tracks. The minimum and its cap keep
 * every common window clear of a column boundary (five columns at 1440px,
 * six at full HD and 2560px, eight at 4K), so the count holds whether the
 * scrollbars overlay the content or take their gutters (`SCROLL_GUTTERS`).
 */
export const BROWSE_GRID =
  "grid grid-cols-2 gap-x-3.5 gap-y-6 tablet:grid-cols-[repeat(auto-fill,minmax(clamp(10.25rem,15cqi,17rem),1fr))] tablet:gap-x-6 tablet:gap-y-8";
/** One quiet page column: an empty gallery. */
export const PAGE_FRAME = "mx-auto w-full max-w-page px-5 tablet:px-6";
/**
 * Settings: its index, the index's gap and a measure-wide panel, centred as
 * one block (the character sheet's indexed frame, with the panel at the measure).
 */
export const SETTINGS_FRAME =
  "mx-auto w-full max-w-[calc(var(--container-index)+var(--gap-index)+var(--container-measure))] px-5 tablet:px-6";

/**
 * A screen's 56px header row. On phones it starts with the navigation button,
 * the dripping mark, which quickens while a reply is written; the hairline appears only once content scrolls beneath it.
 */
export function ScreenHeader({
  title,
  children,
  edge,
  lead,
  back,
  storyTitle,
  frame,
  gutters,
  yieldsTitle = false,
}: {
  title: ReactNode;
  children?: ReactNode;
  /** Drawn along the bottom edge, over the hairline (the chat's context meter). */
  edge?: ReactNode;
  /** Before the title, after the phone's navigation button (the chat's small portrait); the title then takes the story face. */
  lead?: ReactNode;
  back?: BackTarget | undefined;
  /** The story face for a title after a `lead`, or for a character's name; false keeps the interface sans (a back control is not a character). */
  storyTitle?: boolean;
  /** The body's frame (a frame constant), which the contents take from tablet up; the hairline stays full width. */
  frame?: string;
  /** The gutter class the body's scroller keeps (`SCROLL_GUTTERS`, the chat thread's own alike), so the header keeps the same room. */
  gutters?: string;
  /**
   * The title fades while an ancestor carries `data-name-shown` (a nameplate with the same
   * name in view below, stuck or not), so the name never shows twice; it stays the heading.
   */
  yieldsTitle?: boolean;
}) {
  const phone = useFormFactor() === "phone";
  const writing = useInFlight();
  const story = storyTitle ?? lead !== undefined;
  return (
    <HeaderFrame frame={frame} gutters={gutters} edge={edge}>
      {phone && (
        // The mark on a plate, so it reads as the control that opens the navigation.
        <MoreButton
          aria-label="Open navigation"
          onClick={() => setNavOpen(true)}
          mark={<MarkIcon dripping writing={writing} size={20} />}
          cue={<MenuIcon size={14} />}
        />
      )}
      {back && <BackControl back={back} />}
      {lead}
      <HeaderTitle
        className={cn(
          "min-w-0 flex-1 truncate text-ink tablet:px-0",
          lead || back ? "pr-2 pl-1" : "px-2",
          // A display step above the navigation's labels, one size on every screen.
          story ? "font-[450] font-story text-heading" : "font-semibold text-heading",
          yieldsTitle &&
            "transition-opacity duration-(--duration-quick) ease-fade [[data-name-shown]_&]:opacity-0",
        )}
      >
        {title}
      </HeaderTitle>
      <HeaderActions>{children}</HeaderActions>
    </HeaderFrame>
  );
}

/**
 * What a screen shows when its code or data throws while rendering: calm,
 * content-free (an error's message can quote card text), inside the app
 * shell so navigation and the sign-in notice stay. The chat lives outside
 * the screen and is not touched. Code that did not arrive comes back only
 * with a reload, which ends the chat, so that is said and left to the owner.
 */
export function ScreenError({ error, reset }: { error: unknown; reset: () => void }) {
  const chunk = error instanceof ChunkLoadError;
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <ScreenHeader title="Something went wrong" />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 tablet:px-6">
        <EmptyState
          alert
          skipTarget
          title={chunk ? "This screen needs a reload" : "This screen could not load"}
          art={{ role: "hero", image: <Illustration name="error" /> }}
          actions={
            !chunk && (
              <Button variant="outline" onClick={reset}>
                Try again
              </Button>
            )
          }
        >
          {chunk
            ? "Its code did not arrive, and the browser keeps that until the page reloads. Your chat is still here; a reload brings the screen back and ends the chat."
            : "Your chat is still here."}
        </EmptyState>
      </div>
    </main>
  );
}

/** An address that leads nowhere: said plainly, with the way back to the story. */
export function NotFoundScreen() {
  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <ScreenHeader title="Not found" />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 [scroll-timeline:--thread] tablet:px-6">
        <EmptyState
          skipTarget
          title="Nothing lives at this address"
          art={{ role: "hero", image: <Illustration name="not-found" /> }}
          actions={
            <Link to="/" className={buttonVariants({ variant: "primary" })}>
              Back to the story
            </Link>
          }
        >
          The link may be old or mistyped.
        </EmptyState>
      </div>
    </main>
  );
}

/** The first Tab stop on every screen: straight to its main content (the message field in chat). */
export function SkipToContent() {
  return (
    <button
      type="button"
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-(--z-overlay) focus-visible:rounded-md focus-visible:bg-surface focus-visible:px-3 focus-visible:py-2 focus-visible:text-ink focus-visible:text-ui"
      onClick={() => document.querySelector<HTMLElement>("[data-skip-target]")?.focus()}
    >
      Skip to content
    </button>
  );
}
