import type { AnyRouter } from "@tanstack/react-router";
import { loadMarkdown } from "../chat/markdown-chunk.ts";
import { loadInspector } from "../chat/open-inspector.ts";
import { loadTransport } from "../chat/session.ts";
import { loadMotionFeatures } from "./motion.tsx";

/**
 * Code the chat loads on demand, through each chunk's own loader: the
 * Markdown renderer, the inspector, the stream decoder, gestures.
 */
const CHAT_CHUNKS = [loadMarkdown, loadInspector, loadTransport, loadMotionFeatures];

/** The preload waits for the first idle moment after the first paint at most this long. */
const AFTER_FIRST_PAINT_MS = 2_000;

/**
 * Loads every chunk right after the first paint, while the session that
 * served the page is fresh. The first paint stays small, and a chunk already
 * in the module map never reaches the network again: signed out, a missing
 * chunk would meet the sign-in redirect, and the router answers a chunk it
 * cannot load by reloading the tab, which would lose the chat. A fetch that
 * fails here stays failed for the page's life (the browser's module map);
 * the screen then says so instead of reloading (app/router-package.ts).
 */
export function preloadChunks(router: AnyRouter): void {
  const load = () =>
    Promise.allSettled([
      ...Object.values(router.routesById).map(async (route) => router.loadRouteChunk(route)),
      ...CHAT_CHUNKS.map((chunk) => chunk()),
    ]);
  // The first idle moment after the first paint; a hidden tab gets the deadline.
  requestIdleCallback(() => void load(), { timeout: AFTER_FIRST_PAINT_MS });
}
