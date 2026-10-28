/*
 * The route paths that middleware matches before routing: the boundary's
 * multipart and integration allowlists (boundary.ts) and the portrait cache
 * policy (http.ts), and the stylesheet the app shell links (shell.ts). The
 * mounts and route definitions use these constants, so a renamed route moves
 * its matcher with it.
 */
export const API_PATH = "/api";
export const MOUNTS = {
  characters: "/characters",
  personas: "/personas",
  lorebooks: "/lorebooks",
  creator: "/creator",
} as const;
export const IMPORT_PATH = "/import";
export const PORTRAIT_PATH = "/:id/portrait";
export const PORTRAIT_IMAGE_PATH = `${PORTRAIT_PATH}/image`;
export const IMAGE_CARD_PATH = "/card/from-image";
/** The custom palettes' stylesheet, which the app shell links (shell.ts). */
export const PALETTES_CSS_PATH = "/palettes.css";

/** The request paths of `path` under any of `mounts`; a `:param` segment matches any one segment. */
export const routePattern = (mounts: readonly string[], path: string): RegExp =>
  new RegExp(`^${API_PATH}(?:${mounts.join("|")})${path.replace(/:[^/]+/g, "[^/]+")}$`);
