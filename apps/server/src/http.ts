import { Hono, type MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { BUILD_HEADER } from "./build.ts";
import type { Logger } from "./log.ts";
import { MOUNTS, PORTRAIT_IMAGE_PATH, routePattern } from "./paths.ts";

const PORTRAIT_IMAGE = routePattern([MOUNTS.characters, MOUNTS.personas], PORTRAIT_IMAGE_PATH);
/**
 * Every response's Cache-Control. `no-transform` also keeps a proxy from
 * rewriting a response: Cloudflare otherwise injects its analytics beacon and
 * bot-detection script into the HTML (third-party markup, principle 2).
 */
export const NO_STORE = "no-store, no-transform";
/**
 * The one storable response: a portrait addressed by its current version. The
 * browser revalidates it on every use, so the boundary and the requester's
 * own store run before a stored copy is shown (owner decision).
 */
export const PORTRAIT_CACHE_CONTROL = "private, no-cache, no-transform";

/**
 * `Cache-Control: no-store, no-transform` on every response, streams and errors included,
 * overwriting library defaults such as the AI SDK's `no-cache`. The one
 * exception (owner decision): a portrait GET, of a character or a persona,
 * that the route itself marked storable because the URL names its current
 * version, answered whole (200) or as still valid (304). Portraits are never
 * chat content.
 */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  const cacheablePortrait =
    c.req.method === "GET" &&
    PORTRAIT_IMAGE.test(c.req.path) &&
    (c.res.status === 200 || c.res.status === 304) &&
    c.res.headers.get("Cache-Control") === PORTRAIT_CACHE_CONTROL;
  if (!cacheablePortrait) c.res.headers.set("Cache-Control", NO_STORE);
};

/** Logs the matched route pattern, never the raw URL. */
export function requestLog(log: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    log.info({
      event: "request",
      method: c.req.method,
      route: routePath(c, c.req.routeIndex),
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  };
}

/**
 * Content Security Policy (PRINCIPLES.md 2). `script-src` is never widened.
 * No inline-style relaxation is needed: UI libraries set styles through the
 * CSSOM, which the policy does not govern; Base UI's style elements are off
 * (CSPProvider). Trusted Types forbid string-to-HTML and eval sinks, a second
 * guard for untrusted text. The e2e suite fails on any violation.
 */
const contentSecurityPolicy = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  workerSrc: ["'none'"],
  frameSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  requireTrustedTypesFor: ["'script'"],
  trustedTypes: ["'none'"],
};

/** The security headers every response carries, the policy above included. */
export const securityHeaders = secureHeaders({ xFrameOptions: "DENY", contentSecurityPolicy });

const fallback = new Hono()
  .use(noStore)
  .use(securityHeaders)
  .all("*", (c) => c.json({ error: "internal" }, 500));

/**
 * The answer to an error the runtime caught outside the app, with the headers
 * of every other response, the build it names included, and no detail. Bun's
 * own refusal of a body past `maxRequestBodySize`, sent before the app sees
 * the request, cannot carry them: it is a bare 413 with no body.
 */
export async function internalErrorResponse(revision?: string): Promise<Response> {
  const response = await fallback.fetch(new Request("http://localhost/"));
  if (revision !== undefined) response.headers.set(BUILD_HEADER, revision);
  return response;
}
