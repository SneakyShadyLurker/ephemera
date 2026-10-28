import type { MiddlewareHandler } from "hono";

/**
 * The response header naming the build the server runs: the deployed commit
 * (`EPHEMERA_BUILD_REVISION`), which the SPA is built with too. A tab loaded
 * from an earlier build sees another value and offers a reload
 * (apps/web `app/build.ts`).
 */
export const BUILD_HEADER = "X-Ephemera-Build";

/** What a build revision may be: a commit hash or a short name, safe in a header. */
export const BUILD_REVISION = /^[0-9A-Za-z._-]{1,64}$/;

/** Names the build on every response, errors and streams included. */
export const buildHeader =
  (revision: string): MiddlewareHandler =>
  async (c, next) => {
    await next();
    c.res.headers.set(BUILD_HEADER, revision);
  };
