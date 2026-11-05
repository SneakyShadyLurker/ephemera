import { type CSSProperties, useEffect, useRef, useState } from "react";
import { GLIDE } from "@/app/glide.ts";
import { useOnScreen } from "@/app/KeptScroll.tsx";
import { MarkIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useRenewals } from "../signin/hooks.ts";
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
}: {
  src: string | null;
  arriving?: boolean;
  lazy?: boolean;
}) {
  const renewals = useRenewals();
  const current = `${renewals}:${src}`;
  const [drawn, setDrawn] = useState<{ key: string; src: string } | null>(
    src === null ? null : { key: current, src },
  );
  const [failed, setFailed] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  if (src === null && drawn !== null) setDrawn(null);
  useEffect(() => {
    if (src === null || drawn?.key === current) return;
    let active = true;
    const show = () => {
      const probe = new Image();
      probe.src = src;
      void probe.decode().then(
        () => {
          if (active) setDrawn({ key: current, src });
        },
        () => {},
      );
    };
    const leaf = image.current;
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
  if (src === null || drawn === null || failed === drawn.key) return null;
  return (
    <img
      ref={image}
      key={drawn.key}
      src={drawn.src}
      alt=""
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
      draggable={false}
      onError={() => setFailed(drawn.key)}
      className={cn("absolute inset-0 size-full object-cover object-top", arriving && "surface-in")}
    />
  );
}

/** The shared-element name that carries a portrait from a gallery into its sheet. */
export const PORTRAIT_TRANSITION = "character-portrait";

/**
 * A character's or persona's portrait: always the whole art as a 2:3 leaf,
 * filled from the top, never cropped to a face. Without art the leaf keeps
 * its quiet ground with the mark's crescent and lamp low in it, one faint
 * glyph: the name is said once, by the caption or heading beside it.
 */
export function Portrait({
  owner = "characters",
  name,
  id,
  version,
  size = "thumb",
  arriving = false,
  transition = false,
  className,
}: {
  owner?: PortraitOwner;
  name?: string;
  id: string;
  version: number | null;
  size?: PortraitSize;
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
  const src = version === null ? null : portraitUrl(owner, id, version, size);
  // The art on the leaf. Arriving art waits for its pixels, so it surfaces out of
  // blur once they paint, and a replacement keeps the art it replaces until then.
  const [drawn, setDrawn] = useState(arriving ? null : src);
  if (!arriving && drawn !== src) setDrawn(src);
  // Art that did not load (a session expired meanwhile) shows the leaf without art, never the
  // browser's broken image; a renewal or a new version tries again under a new key.
  // The probe starts once the leaf comes within a screen of view (as native lazy loading does),
  // so arrivals far off screen fetch nothing yet; `scrollMargin` widens the screen's own
  // scroller, which clips the leaf before the viewport does.
  useEffect(() => {
    const leaf = frame.current;
    if (!arriving || src === null || leaf === null) return;
    let current = true;
    // A refused decode shows the image anyway; the element reports its own failure.
    const show = () => {
      if (current) setDrawn(src);
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const probe = new Image();
      probe.src = src;
      probe.decode().then(show, show);
    }, NEAR_SCREEN);
    observer.observe(leaf);
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [arriving, src]);
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
          className="absolute inset-0 grid place-items-center font-semibold font-story text-ink text-title"
        >
          {initial(name)}
        </span>
      ) : (
        <MarkIcon
          size={32}
          className="absolute bottom-[9cqi] left-[9cqi] text-reed opacity-45 [&_[data-lamp]]:fill-current"
        />
      )}
      <KeptImage key={`${owner}:${id}`} src={drawn} arriving={arriving} lazy />
    </div>
  );
}

/**
 * The portrait at full size for the viewer, laid over the size already shown,
 * which holds its place until the full one arrives.
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
  shown: PortraitSize;
}) {
  return (
    <span className="relative block size-full">
      {shown !== "full" && (
        <KeptImage key={`shown:${owner}:${id}`} src={portraitUrl(owner, id, version, shown)} />
      )}
      <KeptImage key={`full:${owner}:${id}`} src={portraitUrl(owner, id, version, "full")} />
    </span>
  );
}

/** The small leaf of the chat cues and Session: the whole art, no crop. */
export function Leaf({
  owner = "characters",
  id,
  version,
  className,
}: {
  owner?: PortraitOwner;
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
      <KeptImage key={`${owner}:${id}`} src={src} />
    </span>
  );
}

/** The first letter of a name as one grapheme, so an emoji or accented letter stays whole. */
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
      <span className="text-[70cqi]">{initial(name)}</span>
    </span>
  ) : (
    <Leaf owner={owner} id={id} version={version} className={className} />
  );
}
