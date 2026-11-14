import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "@playwright/test";

/*
 * The two waits a spec cannot express as a state to wait for. Lint refuses
 * Playwright's own sleep and its wait for network idle in a spec, so either
 * has to be one of these on purpose; a timer written by hand is the same
 * sleep and belongs here too.
 */

/**
 * Waits until the page's code has all arrived. The chunks the app loads
 * after its first paint (app/preload.ts) show nothing a test could wait
 * for, so this waits for the network to fall idle.
 */
export async function codeArrived(page: Page): Promise<void> {
  // biome-ignore lint/suspicious/noPlaywrightNetworkidle: the preload leaves no other sign of its end.
  await page.waitForLoadState("networkidle");
}

/**
 * Lets `ms` pass before a test asserts that something did not happen: a late
 * event of an aborted stream, a beacon, a choice that should have been
 * dropped. An event that must never come cannot be awaited.
 */
export async function letPass(ms: number): Promise<void> {
  await sleep(ms);
}
