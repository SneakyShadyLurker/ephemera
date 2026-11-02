import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A keyboard shortcut said beside a control or in a line of help. Every
 * such hint goes through here, so a touch screen, where no keyboard is
 * assumed, never shows one; the control it names stays self-evident.
 */
export function KeyHint({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("touch:hidden", className)}>{children}</span>;
}
