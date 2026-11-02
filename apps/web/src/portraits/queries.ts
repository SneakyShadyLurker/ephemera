import { portraitResponseSchema } from "@ephemera/core";
import type { PortraitKind, PortraitSize } from "@ephemera/server/api";
import { sentence } from "@/lib/text";
import { api, apiHref } from "../api.ts";
import { removing } from "../sheet/saving.ts";
import { notReached, signedOutNow } from "../signin/signin.ts";

/** Who a portrait belongs to: the API collection of its owner. */
export type PortraitOwner = PortraitKind;

export type { PortraitSize };

/**
 * Same-origin portrait URL. The version names the image: the server lets the
 * browser keep only the current one, and has it ask again on every use.
 */
export function portraitUrl(
  owner: PortraitOwner,
  id: string,
  version: number,
  size: PortraitSize = "thumb",
): string {
  return apiHref(
    routes(owner)[":id"].portrait.image.$path({
      param: { id: encodeURIComponent(id) },
      query: { size, v: String(version) },
    }),
  );
}

const routes = (owner: PortraitOwner) => (owner === "characters" ? api.characters : api.personas);

/** An upload's answer; `signedOut`: the sign-in refused it, so its caller may wait for the renewal. */
export type PortraitResult =
  | { ok: true; version: number }
  | { ok: false; reason: string; signedOut: boolean };

/** Uploads a portrait through the server's one image pipeline; `signal` ends it early. */
export async function setPortrait(
  owner: PortraitOwner,
  id: string,
  file: File,
  signal?: AbortSignal,
): Promise<PortraitResult> {
  try {
    const response = await routes(owner)[":id"].portrait.$put(
      { param: { id }, form: { file } },
      signal === undefined ? undefined : { init: { signal } },
    );
    const saved = portraitResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (response.ok && saved.success) return { ok: true, version: saved.data.portrait };
    if (response.status === 415) {
      return { ok: false, reason: "Use a PNG, JPEG or WebP image.", signedOut: false };
    }
    if (response.status === 413) {
      return { ok: false, reason: "That image is too large.", signedOut: false };
    }
    return { ok: false, reason: "That image could not be read.", signedOut: false };
  } catch (error) {
    return { ok: false, reason: `${sentence(notReached())}.`, signedOut: signedOutNow(error) };
  }
}

/** Removes the portrait; false when the server did not (a missing portrait counts as removed). */
export function removePortrait(owner: PortraitOwner, id: string): Promise<boolean> {
  return removing((init) => routes(owner)[":id"].portrait.$delete({ param: { id } }, init));
}
