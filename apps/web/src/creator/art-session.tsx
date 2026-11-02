import type { CreatorKind, ReasoningEffort } from "@ephemera/core";
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { motionMs } from "@/app/motion-tokens.ts";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { useScheme } from "@/app/theme.tsx";
import { applyAtmosphere, tintFromPixels } from "../portraits/atmosphere.ts";
import { type DecodedBatch, useDecodedBatch } from "./art.ts";
import type { ArtImage, ArtSliceState } from "./art-slice.ts";

/*
 * One art session as its regions read it (ArtStack.tsx): the host's store
 * and policy, and the batch on show decoded once for all of them. The
 * creator's showcase and the sheet's studio each provide one around their
 * own layout of the same regions.
 */

export interface ArtSessionHost {
  /** The creator's store or the sheet's; both extend `ArtSliceState`. */
  store: StoreApi<ArtSliceState>;
  kind: CreatorKind;
  /**
   * Shown when none is chosen in the session and Settings names no image
   * prompt model: the card's (creator) or the saved model (sheet).
   */
  defaults: { model: string | null; reasoning: ReasoningEffort };
  /** Alternates, direction and New art withheld (Keep saving; the sheet held). */
  locked: boolean;
  /** The art is leaving into its place (the creator's Keep); the sheet passes false. */
  leaving: boolean;
  /** The host's words for portraits off, a stopped run and an unavailable one without a batch. */
  copy: { off: string; stopped: string; unavailable: string };
  /** Where Stop hands focus when it leaves holding it. */
  focusAfter: () => HTMLElement | null;
}

/** The batch on show and what can be done with it now. */
type ArtBatch = DecodedBatch & {
  /** Shown before, under another mount: it arrives with a quick fade, not the reveal. */
  revealed: boolean;
  /** New art could be pressed: nothing held, painting or decoding. */
  idle: boolean;
  /** A decoded batch is on show and idle: Use or New art could be pressed. */
  usable: boolean;
};

interface ArtSession {
  host: ArtSessionHost;
  batch: ArtBatch;
  /** The main frame's art, which a chosen alternate morphs into. */
  frame: RefObject<HTMLDivElement | null>;
}

const ArtSessionContext = createContext<ArtSession | null>(null);

/** Batches revealed in this tab, so a remounted session shows them without the reveal. */
const revealedBatches = new WeakSet<ArtImage[]>();

/** Whether a batch has been on show before, under any mount, in this tab. */
export const shownBefore = (images: ArtImage[]): boolean => revealedBatches.has(images);

/**
 * The room leans toward the chosen portrait's hue, within the atmosphere's
 * caps and with its grey fallback: `--delay-follow` into a reveal, at once when
 * the choice changes, and not at all once the session is left.
 */
function useHueLean(batch: DecodedBatch, selected: number) {
  const scheme = useScheme();
  const reduced = useReducedMotion();
  const revealed = useRef<DecodedBatch | null>(null);
  const pixels = batch.status === "ready" ? batch.pixels[selected] : undefined;
  useEffect(() => {
    if (batch.status !== "ready" || pixels === undefined) {
      if (batch.status !== "decoding") applyAtmosphere(null);
      return;
    }
    const tint = tintFromPixels(pixels, scheme);
    if (revealed.current === batch || reduced) {
      revealed.current = batch;
      applyAtmosphere(tint);
      return;
    }
    revealed.current = batch;
    const timer = setTimeout(() => applyAtmosphere(tint), motionMs("--delay-follow"));
    return () => clearTimeout(timer);
  }, [batch, pixels, scheme, reduced]);
  useEffect(() => () => applyAtmosphere(null), []);
}

/**
 * Provides the session to its regions: decodes the batch on show, leans the
 * room toward the chosen one, and says "Portraits ready." once per batch
 * whose decode succeeded, never moving focus. Each session epoch mounts the
 * provider and its regions afresh, so a dropped session (a Clear, `pagehide`)
 * leaves no candidate in any component's state or refs.
 */
export function ArtSessionProvider({
  host,
  children,
}: {
  host: ArtSessionHost;
  children: ReactNode;
}) {
  const epoch = useStore(host.store, (state) => state.epoch);
  return (
    <EpochSession key={epoch} host={host}>
      {children}
    </EpochSession>
  );
}

/** One epoch's session: everything that holds its candidates lives here, and goes with it. */
function EpochSession({ host, children }: { host: ArtSessionHost; children: ReactNode }) {
  const images = useStore(host.store, (state) => state.images);
  const selected = useStore(host.store, (state) => state.selected);
  const busy = useStore(
    host.store,
    (state) => state.art?.status === "running" || state.art?.status === "waiting",
  );
  const decoded = useDecodedBatch(host.store, images);
  const frame = useRef<HTMLDivElement>(null);
  useHueLean(decoded, selected);

  // Whether this batch was revealed before is settled once per mount, so its
  // reveal is not cut short when it is recorded below.
  const [seen, setSeen] = useState<{ images: ArtImage[]; revealed: boolean } | null>(null);
  if (decoded.status === "ready" && seen?.images !== images) {
    setSeen({ images, revealed: revealedBatches.has(images) });
  }
  const revealed = seen?.images === images && seen.revealed;
  useEffect(() => {
    if (decoded.status === "ready") revealedBatches.add(images);
  }, [decoded.status, images]);

  const idle = !host.locked && !busy && decoded.status !== "decoding";
  const batch: ArtBatch = {
    ...decoded,
    revealed,
    idle,
    usable: idle && decoded.status === "ready",
  };
  return (
    <ArtSessionContext value={{ host, batch, frame }}>
      {children}
      <p role="status" className="sr-only">
        {decoded.status === "ready" && !revealed ? "Portraits ready." : ""}
      </p>
    </ArtSessionContext>
  );
}

function useArtContext(): ArtSession {
  const session = use(ArtSessionContext);
  if (session === null) throw new Error("The art regions need an ArtSessionProvider");
  return session;
}

/** A value from the session's store. */
export function useArtSession<T>(selector: (state: ArtSliceState) => T): T {
  return useStore(useArtContext().host.store, selector);
}

export function useArtSessionHost(): ArtSessionHost {
  return useArtContext().host;
}

/** The decoded batch, decoded once per provider and shared by every region and the host's footer. */
export function useArtBatch(): ArtBatch {
  return useArtContext().batch;
}

/** The main frame's art element, for the morph from an alternate. */
export function useArtFrame(): RefObject<HTMLDivElement | null> {
  return useArtContext().frame;
}
