import { serveStatic } from "@hono/bun";
import { createApp } from "./app.ts";
import { createAllowlist } from "./comfyui/allowlist.ts";
import {
  loadWorkflowRegistry,
  type ServerWorkflows,
  WorkflowFileError,
} from "./comfyui/workflow.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { internalErrorResponse } from "./http.ts";
import { createLogger, errorClass } from "./log.ts";
import {
  createInstanceRegistry,
  prepareDataDirectory,
  verifyInstances,
} from "./persistence/index.ts";
import { MAX_REQUEST_BYTES } from "./routes.ts";
import { loadStarterCharacter, type StarterCharacter } from "./starter.ts";

const log = createLogger();

/** How long an orderly stop waits for ComfyUI cleanup; inside Docker's ten-second stop grace. */
const DRAIN_TIMEOUT_MS = 8_000;

// Replace the runtime's default printing of uncaught errors, which includes messages.
process.on("uncaughtException", (error) => {
  log.error({ event: "uncaught", errorClass: errorClass(error) });
  process.exit(1);
});
// A rejection nobody handled leaves the process in an unknown state, so it ends
// like an uncaught exception and the container restarts it.
process.on("unhandledRejection", (reason) => {
  log.error({ event: "unhandled_rejection", errorClass: errorClass(reason) });
  process.exit(1);
});

/** Ends the start on invalid configuration; the message names variables only. */
function refuseConfig(error: ConfigError): never {
  log.error({ event: "config.invalid", errorClass: error.name });
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) refuseConfig(error);
  throw error;
}

const { staticDir, dataDir, dataKey: key } = config;
// The curated node classes plus EPHEMERA_COMFYUI_EXTRA_NODES.
const allowlist = createAllowlist(config.extraNodes);
// The bundled graphs and those of EPHEMERA_WORKFLOWS_DIR, read once; a bad
// file, a node class outside the allowlist or a default without a graph
// stops the start.
let workflows: ServerWorkflows;
try {
  workflows = loadWorkflowRegistry({
    workflowsDir: config.workflowsDir,
    defaultWorkflow: config.defaultWorkflow,
    allowlist,
    log,
  });
} catch (error) {
  log.error({
    event: "startup.workflows",
    errorClass: errorClass(error),
    ...(error instanceof WorkflowFileError ? { file: error.file } : {}),
  });
  process.exit(1);
}
// Nothing is served until the data directory is owner-only and every user's
// file opens.
try {
  prepareDataDirectory(dataDir);
} catch (error) {
  log.error({ event: "startup.data_dir", errorClass: errorClass(error) });
  process.exit(1);
}
try {
  await verifyInstances({ dataDir, key, log });
} catch (error) {
  log.error({ event: "startup.verify", errorClass: errorClass(error) });
  process.exit(1);
}
let starterCharacter: StarterCharacter | undefined;
if (config.starterCharacter) {
  try {
    starterCharacter = await loadStarterCharacter();
  } catch (error) {
    log.error({ event: "startup.starter", errorClass: errorClass(error) });
    process.exit(1);
  }
}
const instances = createInstanceRegistry({
  dataDir,
  key,
  log,
  defaultWorkflow: workflows.defaultWorkflow,
  ...(starterCharacter && { starterCharacter }),
});

const stopping = new AbortController();
const drains: (() => Promise<void>)[] = [];

let server: Bun.Server<undefined> | undefined;
const app = createApp(config, {
  log,
  instances,
  workflows,
  allowlist,
  ...(staticDir && {
    staticFiles: [serveStatic({ root: staticDir })],
    appShell: serveStatic({ root: staticDir, path: "index.html" }),
    renewalPage: serveStatic({ root: staticDir, path: "auth/renewed.html" }),
  }),
  onStreamingRequest: (request) => server?.timeout(request, 0),
  shutdown: { signal: stopping.signal, drain: (settled) => drains.push(settled) },
});

server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: false,
  // A backstop under every route's own limit (Bun's default is 128 MB).
  maxRequestBodySize: MAX_REQUEST_BYTES,
  fetch: app.fetch,
  // Replaces Bun's default error page and logging.
  error: (error) => {
    log.error({ event: "server.error", errorClass: errorClass(error) });
    return internalErrorResponse(config.buildRevision);
  },
});

log.info({ event: "listening", route: `${config.host}:${server.port}` });

/**
 * An orderly stop: no new requests, creator runs end, in-flight responses
 * finish (Bun's graceful `stop()` resolves once every connection has closed)
 * and ComfyUI cleanup (PRINCIPLES.md 1) runs, all within one deadline; a
 * connection still open then is closed. Then every user's instance is
 * flushed to its encrypted file and closed.
 */
async function stop() {
  if (stopping.signal.aborted) return;
  const closed = server?.stop();
  stopping.abort();
  const deadline = new Promise<"late">((resolve) =>
    setTimeout(() => resolve("late"), DRAIN_TIMEOUT_MS),
  );
  if ((await Promise.race([closed, deadline])) === "late") void server?.stop(true);
  await Promise.race([Promise.all(drains.map((settled) => settled())), deadline]);
  try {
    await instances.close();
  } catch (error) {
    log.error({ event: "instance.close", errorClass: errorClass(error) });
    process.exit(1);
  }
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void stop());
}
