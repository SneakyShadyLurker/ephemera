import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * An illustration's width by its role: a hero for a screen that is the
 * whole first step (first run, an empty character gallery, not found), a
 * spot for a quieter collection (personas, the library, memories).
 */
const ART_WIDTH = {
  hero: "w-[min(45vw,11.25rem)] tablet:w-[clamp(18.75rem,26vw,22.5rem)]",
  spot: "w-[min(36vw,8.75rem)] tablet:w-[clamp(10rem,14vw,12.5rem)]",
} as const;

/**
 * What a collection or a recovery screen says when it has nothing to show:
 * a heading a display step above the interface, one or two lines of
 * direction in reed and its actions, left-aligned on the screen's own
 * content container (the caller's frame), never centred. An illustration,
 * when one is given, sits above the heading at its role's size.
 */
export function EmptyState({
  title,
  children,
  actions,
  art,
  level = 2,
  skipTarget = false,
  alert = false,
  className,
}: {
  title: ReactNode;
  /** The direction: at most two lines. */
  children?: ReactNode;
  /** The first step, as one or two buttons. */
  actions?: ReactNode;
  art?: { role: keyof typeof ART_WIDTH; image: ReactNode };
  /** The heading's level: 3 inside a section that has its own heading. */
  level?: 2 | 3;
  /** The heading takes focus from Skip to content (a screen with nothing else to land on). */
  skipTarget?: boolean;
  /** Announced as it appears (a failure). */
  alert?: boolean;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section
      role={alert ? "alert" : undefined}
      className={cn(
        "grid content-start justify-items-start pt-[clamp(2rem,10dvh,6rem)] pb-10 surface-in",
        className,
      )}
    >
      {art && <div className={cn("mb-6", ART_WIDTH[art.role])}>{art.image}</div>}
      <Heading
        {...(skipTarget ? { "data-skip-target": "", tabIndex: -1 } : {})}
        className="max-w-measure text-balance font-semibold text-heading text-ink tracking-[-0.01em] outline-none tablet:text-title-phone"
      >
        {title}
      </Heading>
      {children && (
        <div className="mt-2 max-w-empty text-pretty text-lead text-reed">{children}</div>
      )}
      {actions && <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}
