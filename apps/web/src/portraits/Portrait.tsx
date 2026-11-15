import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { GLIDE } from "@/app/glide.ts";
import { useOnScreen } from "@/app/KeptScroll.tsx";
import { MarkIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useRenewals } from "../signin/hooks.ts";
import { fittedSize, useFitted } from "./fit.ts";
import { type PortraitOwner, type PortraitSize, portraitUrl } from "./queries.ts";

/** A 10% ink hairline inside the edge, so pale art keeps its shape on the canvas. */
export const LEAF_EDGE =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-[color-mix(in_oklab,var(--ink)_10%,transparent)]";

/** Within one screen of view, around the viewport and around every scroller on the way. */
const NEAR_SCREEN: IntersectionObserverInit = { rootMargin: "100% 0px", scrollMargin: "100% 0px" };

/** Keep the actual decoded node until its replacement loads, including across session renewals. */
function KeptImage({
  src,
  arriving = false,
  lazy = false,
  unavailable,
  onDrawn,
}: {
  src: string | null;
  arriving?: boolean;
  lazy?: boolean;
  unavailable?: ReactNode;
  /** Each image once it has loaded in its place. */
  onDrawn?: (image: HTMLImageElement) => void;
}) {
  const renewals = useRenewals();
  const current = `${renewals}:${src}`;
  const [drawn, setDrawn] = useState<{ key: string; src: string } | null>(
    src === null || arriving ? null : { key: current, src },
  );
  const [failed, setFailed] = useState<string | null>(null);
  const frame = useRef<HTMLSpanElement>(null);
  if (src === null && drawn !== null) setDrawn(null);
  useEffect(() => {
    if (src === null || drawn?.key === current) return;
    let active = true;
    const show = () => {
      const probe = new Image();
      probe.src = src;
      void probe.decode().then(
        () => {
          if (active) {
            setFailed(null);
            setDrawn({ key: current, src });
          }
        },
        () => {
          if (active) setFailed(current);
        },
      );
    };
    const leaf = frame.current;
    // Renewals keep the gallery's lazy boundary, including portraits far off screen.
    const observer =
      lazy && leaf
        ? new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer?.disconnect();
            show();
          }, NEAR_SCREEN)
        : null;
    if (observer && leaf) observer.observe(leaf);
    else show();
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [current, src, drawn?.key, lazy]);
  const missing = failed === (drawn?.key ?? current);
  return (
    <span ref={frame} className="absolute inset-0">
      {src !== null &&
        (missing ? (
          unavailable === undefined ? (
            <UnavailablePortrait />
          ) : (
            unavailable
          )
        ) : drawn !== null ? (
          <img
            key={drawn.key}
            src={drawn.src}
            alt=""
            loading={lazy ? "lazy" : "eager"}
            decoding="async"
            draggable={false}
            onLoad={(event) => onDrawn?.(event.currentTarget)}
            onError={() => setFailed(drawn.key)}
            className={cn(
              "absolute inset-0 size-full object-cover object-top",
              arriving && "surface-in",
            )}
          />
        ) : null)}
    </span>
  );
}

/** A refused image keeps its frame and shows a deliberate, quiet face. */
function UnavailablePortrait({
  name,
  caption = false,
  compact = false,
}: {
  name?: string | undefined;
  caption?: boolean;
  compact?: boolean;
}) {
  return (
    <span
      role="img"
      aria-label="Portrait unavailable"
      className="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-surface-hover p-2 text-center"
    >
      <span
        aria-hidden="true"
        data-initial={initial(name ?? "Portrait")}
        className={cn(
          "font-semibold font-story text-ink before:content-[attr(data-initial)]",
          compact ? "text-note" : "text-title",
        )}
      />
      {caption && (
        <span aria-hidden="true" className="text-meta text-reed">
          Portrait unavailable
        </span>
      )}
    </span>
  );
}

/** One portrait across its versions and sizes. */
const portraitKey = (owner: PortraitOwner, id: string) => `${owner}:${id}`;

/** The shared-element name that carries a portrait from a gallery into its sheet. */
export const PORTRAIT_TRANSITION = "character-portrait";

/**
 * A character's or persona's portrait: always the whole art as a 2:3 leaf,
 * filled from the top, never cropped to a face. Without art the leaf keeps
 * its quiet ground with the mark's crescent and lamp low in it, one faint
 * glyph: the name is said once, by the caption or heading beside it.
 * `fit` draws the smallest WebP that has the leaf's device pixels, so the
 * art is as sharp in a wide tile on a dense screen as in a small one.
 */
export function Portrait({
  owner = "characters",
  name,
  id,
  version,
  size = "fit",
  lazy,
  arriving = false,
  transition = false,
  className,
}: {
  owner?: PortraitOwner;
  name?: string;
  id: string;
  version: number | null;
  size?: "fit" | "full";
  /**
   * Loads once near the screen, as a gallery's tiles do: the default for a
   * fitted leaf. A portrait that stands alone turns it off: lazily, one above
   * the fold of a scroller that opens on its end would stay unloaded until it
   * is scrolled to.
   */
  lazy?: boolean;
  /** Just imported or uploaded: surfaces out of blur once. */
  arriving?: boolean;
  /** Carries the view-transition name for the gallery-to-sheet morph. */
  transition?: boolean;
  className?: string;
}) {
  // An image refused while signed out loads again after the renewal.
  const frame = useRef<HTMLDivElement>(null);
  // Back in a gallery, the morph lands only on a tile on screen (an edit can move it to the top).
  const shown = useOnScreen(frame, transition);
  const style: CSSProperties | undefined =
    transition && shown ? { viewTransitionName: PORTRAIT_TRANSITION } : undefined;
  const fitted = useFitted(
    frame,
    size === "fit" && version !== null ? portraitKey(owner, id) : null,
  );
  const src =
    version === null ? null : portraitUrl(owner, id, version, size === "full" ? size : fitted.size);
  return (
    <div
      ref={frame}
      style={style}
      className={cn(
        "@container relative isolate aspect-[2/3] overflow-hidden rounded-lg bg-surface-hover",
        LEAF_EDGE,
        GLIDE,
        className,
      )}
    >
      {/* The mark low in the leaf, 9% of its width in from the corner (the leaf is the container). */}
      {version === null && name ? (
        <span
          aria-hidden="true"
          data-initial={initial(name)}
          className="absolute inset-0 grid place-items-center font-semibold font-story text-ink text-title before:content-[attr(data-initial)]"
        />
      ) : (
        <MarkIcon
          size={32}
          className="absolute bottom-[9cqi] left-[9cqi] text-reed opacity-45 [&_[data-lamp]]:fill-current"
        />
      )}
      {/* Keyed on the size as first measured, before any paint: the image starts at that size. */}
      <KeptImage
        key={`${portraitKey(owner, id)}:${fitted.start}`}
        src={src}
        arriving={arriving}
        lazy={lazy ?? size === "fit"}
        unavailable={<UnavailablePortrait name={name} caption />}
        onDrawn={fitted.drawn}
      />
    </div>
  );
}

/**
 * The portrait at full size for the viewer, laid over the size already shown,
 * which holds its place until the full one arrives. `fit`: the rendition its
 * fitted leaf settled on.
 */
export function FullPortrait({
  owner = "characters",
  id,
  version,
  shown,
}: {
  owner?: PortraitOwner;
  id: string;
  version: number;
  /** The size already on screen, so already loaded. */
  shown: PortraitSize | "fit";
}) {
  const under = shown === "fit" ? fittedSize(portraitKey(owner, id)) : shown;
  return (
    <span className="relative block size-full">
      {under !== "full" && (
        <KeptImage key={`shown:${owner}:${id}`} src={portraitUrl(owner, id, version, under)} />
      )}
      <KeptImage
        key={`full:${owner}:${id}`}
        src={portraitUrl(owner, id, version, "full")}
        {...(under !== "full" ? { unavailable: null } : {})}
      />
    </span>
  );
}

/** The small leaf of the chat cues and Session: the whole art, no crop. */
export function Leaf({
  owner = "characters",
  name,
  id,
  version,
  className,
}: {
  owner?: PortraitOwner;
  name?: string | undefined;
  id: string;
  version: number;
  className?: string;
}) {
  const src = portraitUrl(owner, id, version, "thumb");
  // Art that did not load leaves the leaf's quiet ground, never the browser's broken image.
  return (
    <span
      className={cn(
        "relative block aspect-[2/3] shrink-0 overflow-hidden rounded-xs bg-surface-selected",
        LEAF_EDGE,
        className,
      )}
    >
      <KeptImage
        key={portraitKey(owner, id)}
        src={src}
        unavailable={<UnavailablePortrait name={name} compact />}
      />
    </span>
  );
}

/**
 * The first letter of a name as one grapheme, so an emoji or accented letter
 * stays whole. Drawn as generated content (`data-initial`), never as text: a
 * leaf inside a link or button is decoration beside the name, and its letter
 * would otherwise join the control's visible words that speech input matches.
 */
const initial = (name: string): string => {
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name.trim());
  return first?.segment.toLocaleUpperCase() ?? "";
};

/**
 * A character's or persona's small leaf, or one of the same size with its
 * initial when it has no portrait: in the reading sans the name is set in,
 * sized to the leaf's width so it stays legible down to the smallest.
 */
export function PortraitLeaf({
  owner = "characters",
  id,
  name,
  version,
  className,
}: {
  owner?: PortraitOwner;
  id: string;
  name: string;
  version: number | null;
  className: string;
}) {
  return version === null ? (
    <span
      aria-hidden="true"
      className={cn(
        "@container relative grid aspect-[2/3] shrink-0 place-items-center overflow-hidden rounded-xs bg-surface-selected font-semibold font-story text-ink leading-none",
        LEAF_EDGE,
        className,
      )}
    >
      {/* Container units measure the nearest container above the element using them: the leaf. */}
      <span
        data-initial={initial(name)}
        className="text-[70cqi] before:content-[attr(data-initial)]"
      />
    </span>
  ) : (
    <Leaf owner={owner} id={id} name={name} version={version} className={className} />
  );
}
