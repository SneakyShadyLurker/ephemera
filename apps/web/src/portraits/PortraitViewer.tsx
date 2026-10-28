import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CloseIcon } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { LEAF_EDGE } from "./Portrait.tsx";

/** The shared-element name that carries a portrait out of its place into the viewer and back. */
const VIEWER_TRANSITION = "portrait-viewer";

/**
 * A portrait that opens larger on request: the art grows out of its place
 * into the middle of the screen over a veiled canvas, and Close, Escape or a
 * click beside the art lays it back where it came from. While it is open its
 * place stays empty, so the art reads as lifted out rather than copied.
 */
export function PortraitViewer({
  label,
  art,
  children,
  disabled = false,
  className,
}: {
  /** Names the art: the trigger reads "show larger" after it, the viewer takes it as its title. */
  label: string;
  /** The art at full size, drawn while the viewer is open. */
  art: ReactNode;
  /** The art in its place. */
  children: ReactNode;
  /** No art to open yet; an open viewer stays open, so new art can replace the old in it. */
  disabled?: boolean;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const runs = useRef(0);
  const [open, setOpen] = useState(false);

  // The name moves from the art in its place to the viewer's art and back
  // inside one view transition; a newer run keeps the name a skipped one
  // would otherwise clear.
  const morph = (next: boolean) => {
    const source = trigger.current;
    if (source === null) {
      setOpen(next);
      return;
    }
    const run = ++runs.current;
    if (next) source.style.viewTransitionName = VIEWER_TRANSITION;
    const transition = document.startViewTransition(() => {
      source.style.viewTransitionName = next ? "" : VIEWER_TRANSITION;
      flushSync(() => setOpen(next));
    });
    void transition.finished.finally(() => {
      if (runs.current === run) source.style.viewTransitionName = "";
    });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`${label}: show larger`}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => morph(true)}
        className={cn(
          "block cursor-zoom-in rounded-lg outline-offset-4 transition-[filter] duration-(--duration-quick) ease-fade enabled:hover:brightness-[1.04] disabled:cursor-default",
          open && "invisible",
          className,
        )}
      >
        {children}
      </button>
      <DialogPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) morph(false);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-[color-mix(in_oklab,var(--canvas)_76%,transparent)] backdrop-blur-md transition-opacity duration-(--duration-arrive) ease-fade data-ending-style:opacity-0 data-starting-style:opacity-0" />
          {/* Clicks pass through the popup's empty space to the backdrop, which closes the viewer. */}
          <DialogPrimitive.Popup
            data-portrait-viewer=""
            className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] outline-none tablet:p-10"
          >
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
            {open && (
              <>
                <div
                  style={{ viewTransitionName: VIEWER_TRANSITION }}
                  className={cn(
                    "pointer-events-auto relative isolate aspect-[2/3] w-[min(100%,calc((100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))*2/3))] overflow-hidden rounded-xl bg-surface-hover shadow-overlay tablet:w-[min(100%,calc((100dvh-5rem)*2/3))]",
                    LEAF_EDGE,
                  )}
                >
                  {art}
                </div>
                <DialogPrimitive.Close
                  aria-label="Close the portrait"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" }),
                    "pointer-events-auto fixed top-[calc(1rem+env(safe-area-inset-top))] right-[calc(1rem+env(safe-area-inset-right))] rounded-full bg-surface shadow-overlay transition-[opacity,scale,background-color] delay-(--duration-quick) duration-(--duration-arrive) ease-spring starting:scale-90 starting:opacity-0",
                  )}
                >
                  <CloseIcon size={20} />
                </DialogPrimitive.Close>
              </>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
