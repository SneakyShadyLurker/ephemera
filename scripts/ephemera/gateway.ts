/**
 * The local gateway: the trusted authentication proxy for one person on one
 * machine (docs/ARCHITECTURE.md § Local gateway). It listens on loopback,
 * admits only requests addressed to its own origin, clears inbound identity
 * headers, injects the proxy key and the one `Remote-User`, and streams
 * everything else through unchanged, aborting the server's request when the
 * browser goes away.
 */
import { PROXY_KEY_HEADER } from "../../apps/server/src/boundary.ts";
import { USER_HEADER } from "../../apps/server/src/identity.ts";
import type { LocalAccess } from "./env.ts";

export interface GatewayOptions {
  access: LocalAccess;
  proxyKey: string;
  /** The server's own address, e.g. `http://127.0.0.1:8790`. */
  target: string;
}

/** Headers a hop must not pass on, plus the identity only the gateway may set. */
const REQUEST_DROPPED = [
  USER_HEADER,
  PROXY_KEY_HEADER,
  "host",
  // Answers stay uncompressed between the server and the gateway.
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const RESPONSE_DROPPED = ["connection", "keep-alive", "transfer-encoding"];

/** The gateway's address under the loopback IP rather than its name. */
const LOOPBACK_IP = "127.0.0.1";

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** The gateway's request handler, for `Bun.serve`. */
export function gatewayHandler(options: GatewayOptions) {
  const origin = new URL(options.access.origin);
  return async (request: Request, server: Bun.Server<undefined>): Promise<Response> => {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    // A page elsewhere can point its own name at 127.0.0.1 (DNS rebinding);
    // only requests addressed to the gateway's own origin get the identity.
    if (host !== origin.host) {
      if (
        host === `${LOOPBACK_IP}:${origin.port}` &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return plain(308, `Ephemera lives at ${origin.origin}`, {
          Location: `${origin.origin}${url.pathname}${url.search}`,
        });
      }
      return plain(421, `Open Ephemera at ${origin.origin}`);
    }
    // Replies from slow reasoning models can stay quiet for a long time; the
    // server bounds every request's lifetime itself.
    server.timeout(request, 0);
    const headers = new Headers(request.headers);
    for (const name of REQUEST_DROPPED) headers.delete(name);
    headers.set(PROXY_KEY_HEADER, options.proxyKey);
    headers.set(USER_HEADER, options.access.user);
    let response: Response;
    try {
      response = await fetch(`${options.target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: request.signal,
      });
    } catch {
      return plain(502, "Ephemera is not answering. Run ./ephemera status to see why.");
    }
    const answer = new Headers(response.headers);
    for (const name of RESPONSE_DROPPED) answer.delete(name);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: answer,
    });
  };
}
