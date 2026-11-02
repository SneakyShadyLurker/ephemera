import type { Locator } from "@playwright/test";

/**
 * The file an engraved illustration is masked by, once it has loaded:
 * its address, whether that is the page's own origin, and the status the
 * browser received for it (0 until it arrives).
 */
export const illustrationFile = (art: Locator) =>
  art.evaluate((element) => {
    const mask = getComputedStyle(element).maskImage;
    const url = new URL(/url\("?([^")]+)"?\)/.exec(mask)?.[1] ?? "", location.href);
    const entry = performance
      .getEntriesByType("resource")
      .find((resource) => resource.name === url.href) as PerformanceResourceTiming | undefined;
    return {
      file: url.pathname.split("/").at(-1) ?? "",
      sameOrigin: url.origin === location.origin,
      status: entry?.responseStatus ?? 0,
    };
  });
