import { createHash } from "node:crypto";
import {
  type createdResponseSchema,
  exportFileName,
  MAX_JSON_BYTES,
  MAX_REQUEST_BYTES,
  type portraitResponseSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { NO_STORE, PORTRAIT_CACHE_CONTROL } from "./http.ts";
import { ImageError, toPortrait } from "./images.ts";
import type { Logger } from "./log.ts";
import { PORTRAIT_IMAGE_PATH, PORTRAIT_PATH } from "./paths.ts";
import {
  PORTRAIT_SIZES,
  type PortraitSize,
  type PortraitStore,
  type Updated,
} from "./persistence/store.ts";
import type { FromUser, UserEnv } from "./user.ts";

/*
 * What every entity route shares: body limits, the generic validation hook,
 * id parameters and the portrait routes of characters and personas.
 */

// Core owns the body ceilings, so the web app can refuse a file before sending it.
export { MAX_JSON_BYTES, MAX_REQUEST_BYTES };

/** The one answer to a body, file or entity past its limit. */
export const payloadTooLarge = (c: Context) => c.json({ error: "payload_too_large" as const }, 413);

/** JSON bodies carry at most one entity. */
export const jsonLimit = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: payloadTooLarge });

export const uploadLimit = bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: payloadTooLarge });

/** The default hook echoes validation issues; answer without detail. */
/** A request the route cannot take as sent. */
export const invalidRequest = (c: Context) => c.json({ error: "invalid_request" as const }, 400);

export const invalid = (result: { success: boolean }, c: Context) => {
  if (!result.success) return invalidRequest(c);
};

/** One uploaded file, parsed by Hono's form validator after the size limit. */
export const fileForm = zValidator("form", z.object({ file: z.instanceof(File) }), invalid);

export const fileBytes = async (file: File) => new Uint8Array(await file.arrayBuffer());

export const idParam = zValidator("param", z.object({ id: z.uuid() }), invalid);

export const notFound = (c: Context) => c.json({ error: "not_found" as const }, 404);

/** Each refusal code's status, for a route's refusals before its model call. */
export type RefusalStatuses<E extends string> = Record<Exclude<E, "aborted">, 404 | 409 | 422>;

/**
 * Answers a request refused before its model call: the deadline 408
 * `request_timeout`, any other refusal with the status its route's table
 * gives, logged by class.
 */
export function refusedBeforeCall<E extends string>(
  c: Context,
  log: Logger,
  event: string,
  model: string,
  error: E,
  statuses: RefusalStatuses<E>,
) {
  if (error === "aborted") return c.json({ error: "request_timeout" as const }, 408);
  const code = error as Exclude<E, "aborted">;
  const status = statuses[code];
  log.warn({ event, model, status, errorClass: code });
  return c.json({ error: code }, status);
}

/** An edit made against another revision: nothing was written; the current revision is named. */
export const conflict = (c: Context, revision: number) =>
  c.json({ error: "conflict" as const, revision }, 409);

/** Answers an edit made against a revision: the entity as written, a conflict, or 404. */
export function answerUpdate<T>(c: Context, result: Updated<T>) {
  if (result.status === "missing") return notFound(c);
  if (result.status === "conflict") return conflict(c, result.revision);
  return c.json(result.value, 200);
}

/** 204 once the entity is removed, 404 for an unknown one. */
export const removed = (c: Context, ok: boolean) => (ok ? c.body(null, 204) : notFound(c));

/** The copy's id, or 404 for an unknown original. */
export const duplicated = (c: Context, id: string | undefined) =>
  id === undefined
    ? notFound(c)
    : c.json({ id } satisfies z.input<typeof createdResponseSchema>, 201);

/** Whether a store refused a write because the entity outgrew its limit, by core's `isTooLarge`. */
export const outgrew = (error: unknown, isTooLarge: (error: z.ZodError) => boolean) =>
  error instanceof z.ZodError && isTooLarge(error);

/**
 * A native export's text from `write` (core's envelope), or undefined when
 * the stored row is too large to be a file: the whole file past the limit
 * (core's `isTooLarge`), or a field past a bound set after it was saved. Any
 * other invalid row is a server error.
 */
export function nativeExport(
  write: () => string,
  isTooLarge: (error: z.ZodError) => boolean,
): string | undefined {
  try {
    return write();
  } catch (error) {
    if (
      error instanceof z.ZodError &&
      (isTooLarge(error) || error.issues.every((issue) => issue.code === "too_big"))
    ) {
      return undefined;
    }
    throw error;
  }
}

/** ASCII fallback and RFC 6266 `filename*` for an export; never lets an entity name shape the header. */
export function attachment(name: string, extension: "png" | "json"): string {
  const file = exportFileName(name, extension);
  const ascii = file.replace(/[^A-Za-z0-9 ._()-]/g, "_");
  // RFC 5987 attr-char leaves out ' ( ) * !, which encodeURIComponent keeps.
  const encoded = encodeURIComponent(file).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Answers an upload the image pipeline refused; any other error is rethrown. */
export function imageRefused(c: Context, log: Logger, event: string, error: unknown) {
  if (!(error instanceof ImageError)) throw error;
  log.warn({ event, errorClass: error.code });
  if (error.code === "unsupported_image")
    return c.json({ error: "unsupported_media_type" as const }, 415);
  if (error.code === "image_too_large") return payloadTooLarge(c);
  return c.json({ error: "invalid_image" as const }, 422);
}

const portraitQuery = z.object({
  size: z.enum(PORTRAIT_SIZES).default("thumb"),
  v: z.string().optional(),
});

/** Whose portraits a route serves: the API collection of their owner. */
export type PortraitKind = "characters" | "personas";

/**
 * The portrait's validator, bound to the requester: another user's request
 * for the same id and version never carries a tag that could match.
 */
function portraitTag(
  username: string,
  kind: PortraitKind,
  id: string,
  version: number,
  size: PortraitSize,
): string {
  const hash = createHash("sha256")
    .update([username, kind, id, String(version), size].join("\0"))
    .digest("hex");
  return `"${hash.slice(0, 32)}"`;
}

/** Whether an `If-None-Match` list names the tag (the weak comparison RFC 9110 asks for). */
const matches = (header: string | undefined, tag: string) =>
  header?.split(",").some((entry) => entry.trim().replace(/^W\//, "") === tag) ?? false;

/**
 * Upload, remove and serve an owner's portrait from the requester's store:
 * the one route definition for characters and personas. Uploads go through
 * the one image pipeline. Only the current version may be stored, and the
 * browser asks again on every use (PRINCIPLES.md 1); the image sits under its
 * own path, so no URL of the earlier long-lived policy is ever asked for again.
 */
export function createPortraitApi(store: FromUser<PortraitStore>, log: Logger, kind: PortraitKind) {
  const event = `${kind}.portrait`;
  return new Hono<UserEnv>()
    .put(PORTRAIT_PATH, idParam, uploadLimit, fileForm, async (c) => {
      let portrait: Awaited<ReturnType<typeof toPortrait>>;
      try {
        portrait = await toPortrait(await fileBytes(c.req.valid("form").file));
      } catch (error) {
        return imageRefused(c, log, event, error);
      }
      const version = store(c).setPortrait(c.req.valid("param").id, portrait);
      if (version === undefined) return notFound(c);
      return c.json({ portrait: version } satisfies z.input<typeof portraitResponseSchema>, 200);
    })
    .delete(PORTRAIT_PATH, idParam, (c) =>
      removed(c, store(c).removePortrait(c.req.valid("param").id)),
    )
    .get(PORTRAIT_IMAGE_PATH, idParam, zValidator("query", portraitQuery, invalid), async (c) => {
      const { size, v } = c.req.valid("query");
      const { id } = c.req.valid("param");
      const tagOf = (version: number) => portraitTag(c.var.user.username, kind, id, version, size);
      // A revalidation of the current version is answered before any bytes are read.
      const current = store(c).portraitVersion(id);
      if (current === undefined) return notFound(c);
      if (v === String(current) && matches(c.req.header("If-None-Match"), tagOf(current))) {
        return c.body(null, 304, { "Cache-Control": PORTRAIT_CACHE_CONTROL, ETag: tagOf(current) });
      }
      const image = await store(c).portrait(id, size);
      if (image === undefined) return notFound(c);
      const headers = {
        "Content-Type": size === "full" ? "image/png" : "image/webp",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      };
      // Anything but the current version stays no-store and carries no validator.
      if (v !== String(image.version)) {
        return c.body(new Uint8Array(image.bytes), 200, { ...headers, "Cache-Control": NO_STORE });
      }
      return c.body(new Uint8Array(image.bytes), 200, {
        ...headers,
        "Cache-Control": PORTRAIT_CACHE_CONTROL,
        ETag: tagOf(image.version),
      });
    });
}
