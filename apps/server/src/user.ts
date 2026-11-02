import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { USER_HEADER, usernameSchema } from "./identity.ts";
import { errorClass, type Logger } from "./log.ts";
import { type InstanceRegistry, RegistryClosed, type UserInstance } from "./persistence/store.ts";

export type UserEnv = {
  Variables: {
    user: UserInstance;
    /** Set on a streamed response (streams.ts): settles once the work it answers is done. */
    streaming?: Promise<void>;
  };
};

/** Picks what a route needs (a store) from the requester's instance. */
export type FromUser<T> = (c: Context<UserEnv>) => T;

/**
 * Resolves the requester's instance after the boundary admitted their
 * username, and makes every write the request caused durable before its
 * response completes. A plain response is answered only once its writes are
 * flushed, or with a 500 when the flush fails (the write stays dirty and the
 * next flush retries it). A stream, a response its route marked
 * (`markStreaming`), is flushed at its end, before it closes, and errors when
 * that flush fails; when the client goes away the flush runs on its own once
 * the stream's work settled. The instance counts as in use until the
 * response is done and its work settled, so idle eviction never drops it
 * mid-stream.
 */
export function withUser(registry: InstanceRegistry, log: Logger) {
  return createMiddleware<UserEnv>(async (c, next) => {
    // The boundary admitted the header; parsing again only brands it.
    const username = usernameSchema.parse(c.req.header(USER_HEADER));
    let user: UserInstance;
    try {
      user = registry.instance(username);
    } catch (error) {
      if (error instanceof RegistryClosed) return c.json({ error: "unavailable" }, 503);
      // The registry logged the class (instance.open); the file is left as it is.
      return c.json({ error: "internal" }, 500);
    }
    c.set("user", user);
    user.enter();
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      user.leave();
    };
    const failed = (error: unknown) =>
      log.error({ event: "instance.flush", errorClass: errorClass(error) });

    try {
      await next();
    } catch (error) {
      // A route that wrote before it threw still has its writes made durable.
      await user.flushIfDirty().catch(failed);
      leave();
      throw error;
    }

    const response = c.res;
    const streaming = c.get("streaming");
    if (streaming !== undefined && response.body !== null) {
      // `cancel` is in the Streams standard and Bun runs it; the DOM and Bun type libraries lack it.
      const transformer: Transformer<Uint8Array, Uint8Array> & { cancel: () => void } = {
        async flush(controller) {
          try {
            await streaming;
            await user.flushIfDirty();
          } catch (error) {
            failed(error);
            controller.error(new TypeError("flush_failed"));
          } finally {
            leave();
          }
        },
        // The client went away (or an inner stream errored): the writes are flushed all the same,
        // once the work that may still write settled.
        cancel() {
          void streaming
            .then(() => user.flushIfDirty())
            .catch(failed)
            .finally(leave);
        },
      };
      c.res = new Response(response.body.pipeThrough(new TransformStream(transformer)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      return;
    }

    try {
      await user.flushIfDirty();
    } catch (error) {
      failed(error);
      // A fresh response: nothing of the one the route made (its headers included) is kept.
      c.res = undefined;
      c.res = c.json({ error: "internal" }, 500);
    } finally {
      leave();
    }
  });
}
