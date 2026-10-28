import { DEFAULT_SETTINGS, type PaletteChoice, paletteAttribute, type Theme } from "@ephemera/core";
import type { Context, MiddlewareHandler } from "hono";
import { USER_ATTRIBUTE } from "./identity.ts";
import { API_PATH, PALETTES_CSS_PATH } from "./paths.ts";
import type { UserEnv } from "./user.ts";

/**
 * Sets the requester's saved theme, palette and username on an HTML page's `<html>`,
 * the app shell and the renewal page alike, so a reload paints the right
 * theme before any script runs and the tab learns whom it serves: no inline
 * script, nothing stored in the browser (PRINCIPLES.md 1 and 2). The default
 * theme leaves the page to the media query and the default palette needs no
 * attribute (core `paletteAttribute`). The
 * username's charset is attribute-safe. A requester with custom palettes gets
 * their stylesheet linked in `<head>` (the policy allows no inline style),
 * addressed by the latest save so an edit is never served stale.
 */
export function userShell(
  read: (c: Context<UserEnv>) => {
    theme: Theme;
    palette: PaletteChoice;
    username: string;
    /** The latest custom palette's `updatedAt`; undefined when there is none. */
    palettesVersion: number | undefined;
  },
): MiddlewareHandler<UserEnv> {
  return async (c, next) => {
    await next();
    if (c.req.method !== "GET" || !c.res.headers.get("Content-Type")?.startsWith("text/html"))
      return;
    const { theme, palette, username, palettesVersion } = read(c);
    const rewriter = new HTMLRewriter().on("html", {
      element(html) {
        if (theme !== DEFAULT_SETTINGS.theme) html.setAttribute("data-theme", theme);
        const attribute = paletteAttribute(palette);
        if (attribute !== undefined) html.setAttribute("data-palette", attribute);
        html.setAttribute(USER_ATTRIBUTE, username);
      },
    });
    if (palettesVersion !== undefined) {
      rewriter.on("head", {
        element(head) {
          head.append(
            `<link rel="stylesheet" href="${API_PATH}${PALETTES_CSS_PATH}?v=${palettesVersion}">`,
            { html: true },
          );
        },
      });
    }
    c.res = rewriter.transform(c.res);
  };
}
