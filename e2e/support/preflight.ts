import { chromium } from "@playwright/test";

/**
 * Starts the browser once before any test. A Playwright update needs a
 * Chromium build of its own; without it every test would fail the same way,
 * so the run stops here with the command that installs it.
 */
export default async function preflight() {
  try {
    await (await chromium.launch()).close();
  } catch (error) {
    throw new Error(
      "Chromium did not start. If Playwright was updated, run `bun run e2e:browsers` once.",
      { cause: error },
    );
  }
}
