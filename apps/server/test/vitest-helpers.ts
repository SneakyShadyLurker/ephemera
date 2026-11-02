/*
 * Server test helpers that need Vitest; helpers.ts stays free of it, since
 * scripts/cards/check.ts runs outside the test runner.
 */
import { expect, vi } from "vitest";

/** Waits until `condition` holds: up to 2 s, checked every 10 ms; a timeout names the condition. */
export const until = (condition: () => boolean) =>
  vi.waitFor(() => expect(condition(), String(condition)).toBe(true), {
    timeout: 2_000,
    interval: 10,
  });

/** Silences every console method for the test; the spies record what was written. */
export const muteConsole = () =>
  (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
