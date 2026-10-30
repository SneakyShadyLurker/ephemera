import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { type Section, WINDOW_SECTION } from "./sections.ts";

/*
 * The one owner of the Settings address: the `section` search, a category id
 * (`sections.ts`), and the `window` search, a model ID (a setting, validated
 * as one in `routes/settings.tsx`), never chat content. Links pass them;
 * with `window`, Model setup opens, Context focuses that model's window
 * field, then the search clears to the category alone. A category opened
 * from the phone's list marks its history entry (`settingsList`, a flag),
 * so its back control returns there.
 */

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** A Settings category opened from the phone's list, so its back control goes back there. */
    settingsList?: boolean;
  }
}

/** In a line of text: underlined ink. */
const INLINE =
  "text-ink underline decoration-rush underline-offset-4 transition-[text-decoration-color] duration-(--duration-quick) ease-fade hover:decoration-ink";

/**
 * A link to Context on `model`'s window field; without a model, to the
 * category `section` (Model setup unless named). Inline text unless
 * `className` styles it (a button look).
 */
export function WindowLink({
  model,
  section = WINDOW_SECTION,
  label,
  className,
  children,
}: {
  model: string | null;
  section?: Section;
  /** The accessible name, when the visible words alone would repeat on the page. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/settings"
      search={model === null ? { section } : { window: model }}
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cn(className ?? INLINE)}
    >
      {children}
    </Link>
  );
}

/** A row of the phone's category list: opens `section`, marked as opened from the list. */
export function SectionLink({
  section,
  ref,
  className,
  children,
}: {
  section: Section;
  ref?: Ref<HTMLAnchorElement>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      ref={ref}
      to="/settings"
      search={{ section }}
      state={(previous) => ({ ...previous, settingsList: true })}
      className={className}
    >
      {children}
    </Link>
  );
}

/**
 * Moves between categories: `open` pushes one, so Back returns to the last;
 * `back` leaves a phone's category for the list, through history when the
 * list opened it, else in place (a category reached by a link).
 */
export function useSectionNavigation(): {
  open: (section: Section) => void;
  back: (fromList: boolean) => void;
} {
  const navigate = useNavigate({ from: "/settings" });
  const router = useRouter();
  return {
    open: (section) => void navigate({ search: { section }, resetScroll: false }),
    back: (fromList) => {
      if (fromList) router.history.back();
      else void navigate({ search: {}, replace: true, resetScroll: false });
    },
  };
}

/**
 * Clears the `window` search once Context has shown it, so the same link
 * focuses it again; Model setup stays open.
 */
export function useWindowShown(): () => void {
  const navigate = useNavigate({ from: "/settings" });
  return () =>
    void navigate({ search: { section: WINDOW_SECTION }, replace: true, resetScroll: false });
}
