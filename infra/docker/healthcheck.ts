/**
 * The container's health probe: the health route, which needs the proxy key
 * but no `Remote-User`, so it provisions no user instance and makes no
 * upstream call. Exits 0 only on a 2xx and prints nothing.
 */
import { PROXY_KEY_HEADER } from "../../apps/server/src/boundary.ts";
import { loadConfig } from "../../apps/server/src/config.ts";

const TIMEOUT_MS = 4_000;

try {
  const config = loadConfig(process.env);
  const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
    headers: { [PROXY_KEY_HEADER]: config.proxyKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.body?.cancel();
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
