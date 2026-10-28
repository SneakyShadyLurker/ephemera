import { queryOptions } from "@tanstack/react-query";
import { retryable } from "../signin/signin.ts";
import { fetchArtStatus, fetchArtWorkflows } from "./stream.ts";

/** Every workflow's status, to ask again after the address changes. */
export const ART_STATUS_KEY = ["creator", "art-status"] as const;

/**
 * Whether the configured ComfyUI can paint portraits with `workflow` now:
 * configuration, not content. Asked again whenever a screen that shows it
 * opens, after the address changes, and for each workflow chosen.
 */
export const artStatusQuery = (workflow: string) =>
  queryOptions({
    queryKey: [...ART_STATUS_KEY, workflow],
    queryFn: ({ signal }) => fetchArtStatus(workflow, signal),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: (count, error) => retryable(error) && count < 1,
  });

/** The built-in workflows: files shipped with the server, so asked once per tab. */
export const artWorkflowsQuery = queryOptions({
  queryKey: ["creator", "art-workflows"],
  queryFn: ({ signal }) => fetchArtWorkflows(signal),
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  retry: (count, error) => retryable(error) && count < 1,
});
