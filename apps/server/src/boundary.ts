import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AppConfig } from "./config.ts";
import { BOUND_USER_HEADER, USER_HEADER, usernameSchema } from "./identity.ts";
import { IMAGE_CARD_PATH, IMPORT_PATH, MOUNTS, PORTRAIT_PATH, routePattern } from "./paths.ts";

export const PROXY_KEY_HEADER = "X-Ephemera-Proxy-Key";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface Route {
  method: string;
  path: RegExp;
}

/** The only routes the integration key opens: Atelier's image card request. */
const INTEGRATION_ROUTES: Route[] = [
  { method: "POST", path: routePattern([MOUNTS.creator], IMAGE_CARD_PATH) },
];

/** The only routes that take multipart bodies: card and lorebook imports, portrait uploads and image cards (PRINCIPLES.md 2). */
const MULTIPART_ROUTES: Route[] = [
  { method: "POST", path: routePattern([MOUNTS.characters, MOUNTS.lorebooks], IMPORT_PATH) },
  { method: "PUT", path: routePattern([MOUNTS.characters, MOUNTS.personas], PORTRAIT_PATH) },
  ...INTEGRATION_ROUTES,
];

const matches = (routes: Route[], method: string, path: string) =>
  routes.some((route) => route.method === method && route.path.test(path));

/** Keys are compared as fixed-length digests, so timing reveals neither length nor prefix. */
const digest = (value: string) => createHash("sha256").update(value).digest();

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/**
 * Whether a request carries the proxy key SWAG injects: the one owner of that
 * compare. The configured key is hashed once, when the check is made.
 */
export function proxyKeyCheck(config: Pick<AppConfig, "proxyKey">): (c: Context) => boolean {
  const expected = digest(config.proxyKey);
  return (c) => {
    const key = c.req.header(PROXY_KEY_HEADER);
    return key !== undefined && timingSafeEqual(digest(key), expected);
  };
}

/**
 * The request boundary (PRINCIPLES.md 2). Runs before every route, static
 * files included: SWAG injects the proxy key and `Remote-User`, which must be
 * a valid username; a request the client bound to another user is refused
 * with a distinct status, so the tab can discard the previous user's state.
 * An unsafe request under the proxy key must carry that binding. The
 * integration key stands in for the proxy key on the integration routes
 * only, under the same rules, the binding optional. Unsafe requests must come from the exact app
 * origin with a JSON body, or a multipart body on the import routes only.
 * No CORS headers are ever sent.
 */
export function boundary(
  config: Pick<AppConfig, "proxyKey" | "integrationKey" | "origin">,
): MiddlewareHandler {
  const proxyKey = digest(config.proxyKey);
  const integrationKey = digest(config.integrationKey ?? "");
  return async (c, next) => {
    const key = c.req.header(PROXY_KEY_HEADER);
    if (key === undefined) return c.json({ error: "forbidden" }, 403);
    const presented = digest(key);
    // Both comparisons run on every request, so timing does not reveal which key matched.
    const proxy = timingSafeEqual(presented, proxyKey);
    const integration = timingSafeEqual(presented, integrationKey);
    const admitted =
      proxy ||
      (config.integrationKey !== undefined &&
        integration &&
        matches(INTEGRATION_ROUTES, c.req.method, c.req.path));
    if (!admitted) return c.json({ error: "forbidden" }, 403);
    const user = usernameSchema.safeParse(c.req.header(USER_HEADER));
    if (!user.success) {
      return c.json({ error: "forbidden" }, 403);
    }
    const safe = SAFE_METHODS.has(c.req.method);
    const bound = c.req.header(BOUND_USER_HEADER);
    // A write through SWAG must name its user: a tab that names none (one loaded
    // before the binding existed) never writes into whoever is signed in now.
    // Navigation and images cannot carry the header; Atelier never sends it.
    const bindingRequired = proxy && !safe;
    if ((bound === undefined && bindingRequired) || (bound !== undefined && bound !== user.data)) {
      return c.json({ error: "identity_mismatch" }, 412);
    }
    if (!safe) {
      if (c.req.header("Origin") !== config.origin) {
        return c.json({ error: "forbidden" }, 403);
      }
      const type = mediaType(c.req.header("Content-Type"));
      const multipart =
        type === "multipart/form-data" && matches(MULTIPART_ROUTES, c.req.method, c.req.path);
      if (type !== "application/json" && !multipart) {
        return c.json({ error: "unsupported_media_type" }, 415);
      }
    }
    await next();
  };
}
