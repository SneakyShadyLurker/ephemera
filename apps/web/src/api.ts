import {
  type EffectiveWindow,
  effectiveWindow,
  type ModelInfo,
  modelsResponseSchema,
  type Settings,
} from "@ephemera/core";
import type { ApiType } from "@ephemera/server/api";
import { BOUND_USER_HEADER } from "@ephemera/server/identity";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { hc } from "hono/client";
import { z } from "zod";
import { noteBuild } from "./app/build.ts";
import { IdentityChanged, identity } from "./signin/identity.ts";
import { retryable, SignedOut, signIn } from "./signin/signin.ts";

/**
 * The sign-in redirect as a manual-redirect fetch sees it (SWAG turns
 * Authelia's 401 into a 302 to the portal), or a 401 that reaches the
 * browser. Ephemera's API never answers either: its errors are JSON with
 * other statuses (PRINCIPLES.md 2).
 */
export const isSignedOut = (response: Response) =>
  response.type === "opaqueredirect" || response.status === 401;

/**
 * Ephemera's refusal of a request bound to another user than the session's
 * (PRINCIPLES.md 2); only Ephemera answers it, in JSON.
 */
const identityMismatchSchema = z.object({ error: z.literal("identity_mismatch") });

async function isIdentityMismatch(response: Response): Promise<boolean> {
  if (response.status !== 412) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return identityMismatchSchema.safeParse(body).success;
}

/** The request's headers with the tab's user bound to them, when the page named one. */
function bindHeaders(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit {
  const user = identity.bound();
  if (user === undefined) return { ...init };
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(BOUND_USER_HEADER, user);
  return { ...init, headers };
}

/**
 * The one fetch owner for API requests, the chat stream included. Redirects
 * are never followed: the sign-in portal is cross-origin, and following it
 * would only turn an expired session into a network error. Every request is
 * bound to the tab's user; once that user changed, nothing is sent at all.
 * Every answer says which build the server runs (app/build.ts).
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (identity.hasChanged()) throw new IdentityChanged();
  const outage = signIn.outage();
  const pass = signIn.pass();
  const response = await fetch(input, { ...bindHeaders(input, init), redirect: "manual" });
  noteBuild(response);
  if (isSignedOut(response)) {
    throw new SignedOut(!signIn.signedOut(pass));
  }
  if (await isIdentityMismatch(response)) {
    identity.changed();
    throw new IdentityChanged();
  }
  // Only Ephemera's own answer proves the session: SWAG's error page while Authelia
  // is down, or a 403 for another user, is neither a success nor Ephemera's JSON.
  const fromEphemera =
    response.ok || response.headers.get("Content-Type")?.startsWith("application/json") === true;
  if (fromEphemera) signIn.confirmed(outage);
  return response;
}

const API_BASE = "/api";

/** Typed RPC client for the Hono API; same origin only. */
export const api = hc<ApiType>(API_BASE, { fetch: apiFetch });

/**
 * A same-origin URL the browser loads itself (a download, an image), from a
 * typed client path (`$path`), so a renamed route or parameter fails the typecheck.
 */
export const apiHref = (path: string): string => `${API_BASE}${path}`;

/**
 * `apiHref` for one entity's route. The typed client puts parameters into
 * the path as given, so the id is encoded here.
 */
export const entityHref = (
  route: { $path: (args: { param: { id: string } }) => string },
  id: string,
): string => apiHref(route.$path({ param: { id: encodeURIComponent(id) } }));

/**
 * Why an entity's GET failed. An id that is not a UUID (a mistyped or cut
 * URL) is refused as invalid: nothing can be found there either, and it is
 * not retried as an outage would be.
 */
export const entityError = (status: number): Error =>
  new Error(status === 404 || status === 400 ? "not_found" : "unavailable");

/** Whether an entity's GET failed because the entity is not there (`entityError`). */
export const isNotFound = (error: unknown): boolean =>
  error instanceof Error && error.message === "not_found";

/** An entity query's retry rule: a missing entity is final, an outage is retried twice. */
export const entityRetry = (count: number, error: Error): boolean =>
  retryable(error) && !isNotFound(error) && count < 2;

/** The models CLIProxyAPI offers, with each one's context window and reasoning levels. */
export const modelsQuery = queryOptions({
  queryKey: ["models"],
  queryFn: async ({ signal }) => {
    const response = await api.models.$get(undefined, { init: { signal } });
    if (!response.ok) throw new Error("unavailable");
    return modelsResponseSchema.parse(await response.json()).models;
  },
  staleTime: 5 * 60_000,
});

/**
 * The models a picker offers: every one the catalog lists, and `current`
 * even when the catalog no longer lists it (or failed), each once.
 */
export function useModelOptions(current: string | null): string[] {
  const { data } = useQuery(modelsQuery);
  return [
    ...new Set([...(data ?? []).map((model) => model.id), ...(current === null ? [] : [current])]),
  ];
}

/** A model's catalog entry; undefined while loading, when unlisted or when the list failed. */
export function useModelInfo(id: string | null): ModelInfo | undefined {
  const { data } = useQuery(modelsQuery);
  return id === null ? undefined : data?.find((model) => model.id === id);
}

/**
 * The window replies to `model` are fitted to, as the server decides it:
 * "loading" until the model list answers (or fails), then the window or null.
 */
export function useContextWindow(
  model: string | null,
  settings: Pick<Settings, "contextWindows" | "contextLimits">,
): EffectiveWindow | null | "loading" {
  const models = useQuery(modelsQuery);
  if (model === null) return null;
  if (models.isPending) return "loading";
  return effectiveWindow(model, models.data, settings);
}
