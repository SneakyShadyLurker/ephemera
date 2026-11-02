import { type ModelInfo, modelsFromCatalog } from "@ephemera/core";
import type { AppConfig } from "./config.ts";
import { readBoundedJson, untilAborted } from "./lifetime.ts";
import { errorClass, type Logger } from "./log.ts";

/** Below Bun's 10 s idle timeout, which would otherwise cut the request first; both requests share it. */
const CATALOG_TIMEOUT_MS = 8_000;
/** How long the chat route reuses the last catalog before asking again. */
const CATALOG_TTL_MS = 60_000;
/** Far past any real catalog; larger is refused unread. */
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export type UpstreamFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type CatalogResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; error: "upstream_unavailable" | "upstream_invalid" };

/**
 * The upstream's model catalog, read by `modelsFromCatalog` whatever shape the
 * provider answers. The first query asks for the richest list providers
 * offer: `client_version` selects a catalog with each model's window and
 * reasoning levels (its empty value keeps every level), `detailed=true` adds
 * windows and capabilities where a provider supports it; others ignore both
 * or refuse them, and the plain list answers. Model metadata, never chat
 * content, so the last good catalog may be reused.
 */
export function createCatalog(config: AppConfig, fetch: UpstreamFetch, log: Logger) {
  /** `rich` when the catalog came from the rich query; a plain list never replaces such a one. */
  let cached: { models: ModelInfo[]; at: number; rich: boolean } | undefined;
  let refreshing: Promise<CatalogResult> | undefined;

  /** One model list request; `fallback` when a plain list may still answer. */
  async function ask(
    url: string,
    signal: AbortSignal,
    bounded: AbortSignal,
  ): Promise<{ result: CatalogResult; fallback: boolean }> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers:
          config.upstreamApiKey === undefined
            ? {}
            : { Authorization: `Bearer ${config.upstreamApiKey}` },
        signal: bounded,
      });
    } catch (error) {
      // A caller that left is no sign of the upstream's health.
      if (!signal.aborted) log.warn({ event: "upstream.models", errorClass: errorClass(error) });
      return { result: { ok: false, error: "upstream_unavailable" }, fallback: false };
    }
    if (!response.ok) {
      await response.body?.cancel();
      log.warn({ event: "upstream.models", status: response.status });
      const refused = response.status >= 400 && response.status < 500;
      return { result: { ok: false, error: "upstream_unavailable" }, fallback: refused };
    }
    const body = await readBoundedJson(response, MAX_CATALOG_BYTES).catch(() => undefined);
    const models = modelsFromCatalog(body?.ok === true ? body.json : undefined);
    if (models === undefined) {
      log.warn({ event: "upstream.models", errorClass: "InvalidModelCatalog" });
      return { result: { ok: false, error: "upstream_invalid" }, fallback: true };
    }
    return { result: { ok: true, models }, fallback: false };
  }

  /**
   * The rich catalog, else, when the upstream refuses its query (4xx) or
   * answers something else, the plain `/models` list, both within one budget.
   * Once a rich catalog was served, a failed rich query keeps it instead of
   * asking for the plain list, whose windows are all unknown.
   */
  async function load(signal: AbortSignal): Promise<CatalogResult> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]);
    const base = `${config.upstreamBaseUrl}/models`;
    const rich = await ask(`${base}?client_version=&detailed=true`, signal, bounded);
    if (rich.result.ok) {
      cached = { models: rich.result.models, at: Date.now(), rich: true };
      return rich.result;
    }
    if (!rich.fallback || cached?.rich === true) return rich.result;
    const { result } = await ask(base, signal, bounded);
    if (result.ok) cached = { models: result.models, at: Date.now(), rich: false };
    return result;
  }

  return {
    /** A fresh catalog, for the model list. */
    load,
    /**
     * The catalog for a generation: reused while recent, and the last good one
     * while the upstream cannot answer; undefined when there never was one.
     * Requests arriving together share one refresh, which no single request's
     * disconnect cancels (only its own timeout ends it); a request that ends
     * stops waiting for it at once.
     */
    async current(signal: AbortSignal): Promise<ModelInfo[] | undefined> {
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
      refreshing ??= load(new AbortController().signal).finally(() => {
        refreshing = undefined;
      });
      const result = await untilAborted(refreshing, signal);
      return result?.ok ? result.models : cached?.models;
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
