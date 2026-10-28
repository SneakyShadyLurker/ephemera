import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * The one owner of the Settings `window` search: a model ID (a setting,
 * validated as one in `routes/settings.tsx`), never chat content. Links pass
 * it; Context focuses that model's window field, then clears it.
 */

/** In a line of text: underlined ink. */
const INLINE =
  "text-ink underline decoration-rush underline-offset-4 transition-[text-decoration-color] duration-(--duration-quick) ease-fade hover:decoration-ink";

/**
 * A link to Context on `model`'s window field; without a model, Settings as
 * it is. Inline text unless `className` styles it (a button look).
 */
export function WindowLink({
  model,
  label,
  className,
  children,
}: {
  model: string | null;
  /** The accessible name, when the visible words alone would repeat on the page. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/settings"
      search={model === null ? {} : { window: model }}
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cn(className ?? INLINE)}
    >
      {children}
    </Link>
  );
}

/** Clears the `window` search once Context has shown it, so the same link focuses it again. */
export function useWindowShown(): () => void {
  const navigate = useNavigate({ from: "/settings" });
  return () => void navigate({ search: {}, replace: true, resetScroll: false });
}
