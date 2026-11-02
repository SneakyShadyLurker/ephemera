import { QueryClient } from "@tanstack/react-query";
import { identity } from "../signin/identity.ts";
import { retryable, signIn } from "../signin/signin.ts";

/**
 * The tab's one query cache: server data for characters, personas, presets and
 * settings, in memory only (no persister is installed; PRINCIPLES.md 1).
 * A signed-out request is never retried; it loads again once the session is back.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, error) => retryable(error) && count < 3 } },
});

// Another user's session: nothing cached for this one survives until the reload.
identity.onChanged(() => queryClient.clear());

signIn.onRenewed(async () => {
  await queryClient.refetchQueries({ predicate: (query) => query.state.status === "error" });
});
