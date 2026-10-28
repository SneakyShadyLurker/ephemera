import type { LorebookEntry } from "@ephemera/core";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { methodNotAllowed } from "hono/method-not-allowed";
import { routePath } from "hono/route";
import { type ApiDeps, createApi } from "./api.ts";
import { boundary, proxyKeyCheck } from "./boundary.ts";
import { buildHeader } from "./build.ts";
import type { WorkflowRegistry } from "./comfyui/workflow.ts";
import type { AppConfig } from "./config.ts";
import { noStore, requestLog, securityHeaders } from "./http.ts";
import { createLogger, errorClass } from "./log.ts";
import { API_PATH } from "./paths.ts";
import { createInstanceRegistry, type InstanceRegistry } from "./persistence/index.ts";
import { payloadTooLarge } from "./routes.ts";
import { userShell } from "./shell.ts";
import { warningLogger } from "./upstream.ts";
import { type UserEnv, withUser } from "./user.ts";

export interface AppDeps extends Partial<Omit<ApiDeps, "workflows">> {
  /** The workflows the server runs; their default seeds a new user's settings. */
  workflows: WorkflowRegistry;
  /** Every user's instance; tests without one get a registry kept in memory. */
  instances?: InstanceRegistry;
  /** Serves files of the built SPA; the Bun entry supplies it, tests may stub it. */
  staticFiles?: MiddlewareHandler[];
  /** Serves `index.html` for client routes. */
  appShell?: MiddlewareHandler;
  /** Serves the page Authelia returns the sign-in window to (`/auth/renewed`). */
  renewalPage?: MiddlewareHandler;
}

/**
 * A lorebook entry's digest for its timed state: Bun's native 64-bit hash of
 * its canonical JSON, as hex. Editing the entry changes it and so ends the
 * entry's effect (packages/core lorebook/timed.ts).
 */
const entryDigest = (entry: LorebookEntry) => Bun.hash(JSON.stringify(entry)).toString(16);

export function createApp(config: AppConfig, deps: AppDeps) {
  const log = deps.log ?? createLogger();
  // The AI SDK's warnings would print through process.emitWarning; they are logged as
  // operational events instead (upstream.ts).
  globalThis.AI_SDK_LOG_WARNINGS = warningLogger(log);
  const app = new Hono<UserEnv>();
  // In memory, the key encrypts nothing.
  const instances =
    deps.instances ??
    createInstanceRegistry({
      dataDir: ":memory:",
      key: Buffer.alloc(32),
      log,
      defaultWorkflow: deps.workflows.defaultWorkflow,
    });

  app.use(noStore);
  app.use(securityHeaders);
  if (config.buildRevision !== undefined) app.use(buildHeader(config.buildRevision));
  app.use(requestLog(log));
  // The container's probe: the proxy key alone, no user, no instance (PRINCIPLES.md 2).
  const proxyKeyMatches = proxyKeyCheck(config);
  app.get("/api/health", (c) =>
    proxyKeyMatches(c) ? c.json({ ok: true }, 200) : c.json({ error: "forbidden" }, 403),
  );
  app.use(boundary(config));
  app.use(withUser(instances, log));
  app.use(
    methodNotAllowed({
      app,
      onMethodNotAllowed: (c, methods) =>
        c.json({ error: "method_not_allowed" }, 405, { Allow: methods.join(", ") }),
    }),
  );

  app.route(
    API_PATH,
    createApi(config, {
      log,
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      ...(deps.onStreamingRequest ? { onStreamingRequest: deps.onStreamingRequest } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      digest: deps.digest ?? entryDigest,
      workflows: deps.workflows,
      ...(deps.comfyuiSocket ? { comfyuiSocket: deps.comfyuiSocket } : {}),
      ...(deps.shutdown ? { shutdown: deps.shutdown } : {}),
    }),
  );
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.use(
    userShell((c) => {
      const { stores, username } = c.var.user;
      const { theme, palette } = stores.settings.get();
      const saved = stores.palettes.list().map((custom) => custom.updatedAt);
      const palettesVersion = saved.length === 0 ? undefined : Math.max(...saved);
      return { theme, palette, username, palettesVersion };
    }),
  );
  // The sign-in window lands here; its script tells the chat tab and closes it (PRINCIPLES.md 2).
  if (deps.renewalPage) app.get("/auth/renewed", deps.renewalPage);
  for (const handler of deps.staticFiles ?? []) app.get("*", handler);
  const { appShell } = deps;
  if (appShell) {
    // Client routes have no file extension; a missing file, such as an asset
    // from a previous build, gets a 404 rather than HTML served as a script.
    app.get("*", (c, next) => (/\.[^/]*$/.test(c.req.path) ? next() : appShell(c, next)));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Replaces Hono's default console.error(err).
  app.onError((error, c) => {
    // Client faults raised by middleware, such as a malformed JSON body. Their
    // messages are not echoed (getResponse would); only the status is used.
    if (error instanceof HTTPException && error.status < 500) {
      log.warn({
        event: "request.rejected",
        method: c.req.method,
        route: routePath(c, c.req.routeIndex),
        status: error.status,
      });
      if (error.status === 413) return payloadTooLarge(c);
      return c.json({ error: "invalid_request" }, error.status);
    }
    log.error({
      event: "unhandled",
      method: c.req.method,
      route: routePath(c, c.req.routeIndex),
      errorClass: errorClass(error),
    });
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
