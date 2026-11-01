import { type CSSProperties, useRef } from "react";
import { GLIDE } from "@/app/glide.ts";
import { useOnScreen } from "@/app/KeptScroll.tsx";
import { MarkIcon } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useRenewals } from "../signin/hooks.ts";
import { type PortraitOwner, type PortraitSize, portraitUrl } from "./queries.ts";

/** A 10% ink hairline inside the edge, so pale art keeps its shape on the canvas. */
export const LEAF_EDGE =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-[color-mix(in_oklab,var(--ink)_10%,transparent)]";

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
  id,
  version,
  size = "thumb",
  arriving = false,
  transition = false,
  className,
}: {
  owner?: PortraitOwner;
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
  const renewals = useRenewals();
  const frame = useRef<HTMLDivElement>(null);
  // Back in a gallery, the morph lands only on a tile on screen (an edit can move it to the top).
  const shown = useOnScreen(frame, transition);
  const style: CSSProperties | undefined =
    transition && shown ? { viewTransitionName: PORTRAIT_TRANSITION } : undefined;
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
      {version !== null ? (
        <img
          key={renewals}
          src={portraitUrl(owner, id, version, size)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={cn("size-full object-cover object-top", arriving && "surface-in")}
        />
      ) : (
        <div className="flex size-full items-end p-[9%]">
          <MarkIcon size={32} className="text-reed opacity-45 [&_[data-lamp]]:fill-current" />
        </div>
      )}
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
  const renewals = useRenewals();
  return (
    <span key={renewals} className="relative block size-full">
      {shown !== "full" && (
        <img
          src={portraitUrl(owner, id, version, shown)}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover object-top"
        />
      )}
      <img
        src={portraitUrl(owner, id, version, "full")}
        alt=""
        decoding="async"
        draggable={false}
        className="relative size-full object-cover object-top"
      />
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
  const renewals = useRenewals();
  return (
    <span
      className={cn(
        "relative block aspect-[2/3] shrink-0 overflow-hidden rounded-xs",
        LEAF_EDGE,
        className,
      )}
    >
      <img
        key={renewals}
        src={portraitUrl(owner, id, version, "thumb")}
        alt=""
        decoding="async"
        draggable={false}
        className="size-full object-cover"
      />
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
