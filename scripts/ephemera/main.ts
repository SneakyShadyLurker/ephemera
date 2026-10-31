/**
 * `./ephemera`: set up, run and look after your own Ephemera server.
 * `./ephemera help` lists the commands.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { intro, log, note, outro } from "@clack/prompts";
import { ConfigError, loadConfig } from "../../apps/server/src/config.ts";
import { ENV_FILE, LocalAccessError, localAccess, ROOT, serverEnv } from "./env.ts";
import { checkModels } from "./providers.ts";
import {
  downloadVersion,
  installedCopy,
  latestRevision,
  removeOldVersions,
  switchTo,
} from "./release.ts";
import {
  buildCommand,
  buildOutdated,
  builtRevision,
  checkoutRevision,
  healthy,
  installStagedBuild,
  nextRevision,
  portTaken,
  type RunState,
  runEnv,
  running,
  SERVE_ENTRY,
  stageBuild,
  stopServer,
  WEB_WORKSPACE,
  waitUntilReady,
} from "./service.ts";
import { setup } from "./setup.ts";
import {
  accent,
  activity,
  bold,
  CLI,
  command,
  dim,
  fail,
  models,
  openBrowser,
  session,
  since,
  step,
  TITLE,
} from "./ui.ts";

const HELP = `${TITLE} ${dim("· your own roleplay server")}

${bold("Usage")}  ${CLI} ${dim("<command> [options]")}

${bold("Commands")}
  ${command("setup")}     Choose your model provider and write .env, then build
  ${command("start")}     Start in the background and open it in your browser
  ${command("stop")}      Stop, saving every library first
  ${command("restart")}   Stop, then start again
  ${command("status")}    Show whether it runs, where, and since when
  ${command("open")}      Open it in your browser
  ${command("update")}    Pull the latest version, rebuild and restart
  ${command("doctor")}    Check the setup and say what to fix

${bold("Options")}
  ${command("start --foreground")}   Stay attached and show the server's log (Ctrl-C stops)
  ${command("start --no-open")}      Do not open the browser
  ${command("setup --yes")}          Ask nothing; take these instead:
    ${command("--upstream <url>")}     The provider's base URL; its key in EPHEMERA_UPSTREAM_API_KEY
    ${command("--user <name>")}        Your library's name (default: your account name)
    ${command("--port <port>")}        The port to open it on (default: 8780)
    ${command("--behind-proxy <url>")} Serve behind your own sign-in proxy at that address
    ${command("--no-check")}           Do not test the provider
    ${command("--no-start")}           Do not start once set up
`;

/** The settings, valid, or the command ends saying what to fix. */
function configured() {
  if (!existsSync(ENV_FILE))
    fail(`Ephemera is not set up yet. Run ${command(`${CLI} setup`)} first.`);
  const env = runEnv(serverEnv());
  try {
    return { env, access: localAccess(env), config: loadConfig(env) };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof LocalAccessError) {
      fail(`${error.message}. Run ${command(`${CLI} setup`)} or edit .env.`);
    }
    throw error;
  }
}

/**
 * Builds the app beside the served one when the checkout moved on (or
 * always, outside Git). True when a new build waits to be installed.
 */
async function buildIfOutdated(force = false): Promise<boolean> {
  if (!force && !buildOutdated()) return false;
  const revision = nextRevision();
  const built = await step(
    "Building the app",
    "Built the app",
    buildCommand(),
    { ...process.env, EPHEMERA_BUILD_REVISION: revision },
    WEB_WORKSPACE,
  );
  if (!built) fail("The build failed; the output above says why. Nothing was changed.");
  stageBuild(revision);
  return true;
}

async function start(options: {
  foreground: boolean;
  open: boolean;
  /** The caller has just installed a build, which outside Git cannot be told from an old one. */
  built?: boolean;
}): Promise<void> {
  const { access, config } = configured();
  const current = running();
  if (current !== undefined) {
    log.info(`Ephemera is already running at ${accent(current.url)}`);
    if (options.open && current.local) openBrowser(current.url);
    return;
  }
  if (!options.built && (await buildIfOutdated())) installStagedBuild();
  const ports = [
    ...(access ? [[access.port, `pick another with ${command(`${CLI} setup`)}`] as const] : []),
    [config.port, "set another EPHEMERA_PORT in .env"] as const,
  ];
  for (const [port, fix] of ports) {
    if (await portTaken(port)) fail(`Port ${port} is taken by another program; ${fix}.`);
  }

  const argv = [process.execPath, "--no-env-file", SERVE_ENTRY];
  if (options.foreground) {
    log.step(
      `Running in the foreground at ${accent(access?.origin ?? `http://${config.host}:${config.port}`)}; Ctrl-C stops it`,
    );
    // Ctrl-C reaches serve.ts too, which stops the server in order; this waits for it.
    process.on("SIGINT", () => {});
    const child = Bun.spawn(argv, { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await child.exited);
  }

  // Detached into its own session, so closing the terminal leaves it running.
  // Its output goes nowhere: no log reaches the disk (docs/PRINCIPLES.md 1).
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const progress = activity();
  progress.start("Starting Ephemera");
  const state =
    child.pid === undefined ? undefined : await waitUntilReady(child.pid, config.proxyKey);
  if (state === undefined) {
    progress.error("Ephemera did not start");
    fail(`Run ${command(`${CLI} start --foreground`)} to see why.`);
  }
  progress.stop(`Ephemera is running at ${accent(state.url)}`);
  if (state.local) {
    if (options.open && openBrowser(state.url)) log.info("Opened it in your browser.");
  } else {
    log.info("Open it through your sign-in proxy.");
  }
}

async function stop(): Promise<boolean> {
  const state = running();
  if (state === undefined) {
    log.info("Ephemera is not running.");
    return false;
  }
  const progress = activity();
  progress.start("Stopping Ephemera and saving every library");
  const outcome = await stopServer(state);
  if (outcome === "still-running") {
    progress.error("Ephemera is still saving");
    fail(`Give it a moment, then run ${command(`${CLI} status`)}.`);
  }
  if (outcome === "not-saved") {
    progress.error("Ephemera stopped, but it could not confirm every library was saved");
    fail(`Run ${command(`${CLI} start --foreground`)} and stop it with Ctrl-C to see why.`);
  }
  progress.stop("Stopped, every library saved");
  return true;
}

async function status(): Promise<void> {
  const { env, access, config } = configured();
  const state = running();
  if (state === undefined) {
    log.warn(`Stopped. Start it with ${command(`${CLI} start`)}.`);
    return;
  }
  const ok = await healthy(state, config.proxyKey);
  const revision = builtRevision();
  note(
    [
      `${dim("State   ")} ${ok ? accent("● running") : "● not answering"}`,
      `${dim("Address ")} ${state.url}`,
      `${dim("Access  ")} ${access ? `just ${access.user}, on this computer` : "through your sign-in proxy"}`,
      `${dim("Since   ")} ${since(state.startedAt)}`,
      `${dim("Provider")} ${env.EPHEMERA_UPSTREAM_BASE_URL}`,
      ...(revision ? [`${dim("Version ")} ${revision.slice(0, 7)}`] : []),
    ].join("\n"),
    "Ephemera",
  );
}

/**
 * Updates an installed copy: the next version is downloaded, installed and
 * built beside the running one, then made current while the server is
 * stopped, and started from its own code.
 */
async function updateInstalledCopy(): Promise<void> {
  const current = checkoutRevision();
  let latest: string;
  try {
    latest = await latestRevision();
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : "Checking for updates failed"}. Try again later.`,
    );
  }
  if (latest === current) {
    if (!buildOutdated()) {
      log.success("Already up to date.");
      return;
    }
    // The code is current and only its build is missing: built from it, beside the served one.
    await buildIfOutdated(true);
    const wasRunning = running() !== undefined;
    if (wasRunning) await stop();
    installStagedBuild();
    if (wasRunning) await start({ foreground: false, open: false, built: true });
    log.success("Rebuilt the app.");
    return;
  }
  const fetching = activity();
  fetching.start("Downloading the latest version");
  let dir: string;
  try {
    dir = await downloadVersion(latest);
  } catch (error) {
    fetching.error(error instanceof Error ? error.message : "The download failed");
    fail("Updating stopped; your copy is as it was.");
  }
  fetching.stop("Downloaded the latest version");
  const installed = await step(
    "Installing dependencies",
    "Dependencies installed",
    [process.execPath, "install", "--frozen-lockfile"],
    process.env,
    dir,
  );
  if (!installed) fail("Installing dependencies failed; your copy is as it was.");
  const built = await step(
    "Building the app",
    "Built the app",
    buildCommand(),
    { ...process.env, EPHEMERA_BUILD_REVISION: latest },
    join(dir, "apps", "web"),
  );
  if (!built) fail("The build failed; your copy is as it was.");
  stageBuild(latest);
  const wasRunning = running() !== undefined;
  if (wasRunning) await stop();
  installStagedBuild();
  switchTo(dir);
  removeOldVersions(dir);
  log.success(`Updated to ${latest.slice(0, 7)}.`);
  if (wasRunning) {
    // Started by the new version's own code.
    const restarted = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(dir, "scripts", "ephemera", "main.ts"),
        "start",
        "--no-open",
      ],
      { stdio: ["inherit", "inherit", "inherit"] },
    );
    if ((await restarted.exited) !== 0) process.exit(1);
  }
}

async function update(): Promise<void> {
  configured();
  if (installedCopy()) return updateInstalledCopy();
  if (!existsSync(join(ROOT, ".git")))
    fail("This copy is not a Git checkout, so it cannot update itself.");
  const before = checkoutRevision() ?? "";
  const pulled = await step("Fetching the latest version", "Fetched the latest version", [
    "git",
    "pull",
    "--ff-only",
  ]);
  if (!pulled) fail("Updating stopped; your copy is as it was.");
  const after = checkoutRevision() ?? "";
  if (after === before && !buildOutdated()) {
    log.success("Already up to date.");
    return;
  }
  const installed = await step("Installing dependencies", "Dependencies installed", [
    process.execPath,
    "install",
    "--frozen-lockfile",
  ]);
  if (!installed) fail("Installing dependencies failed.");
  // Built beside the served app, which is replaced only once the server is stopped.
  await buildIfOutdated(true);
  const wasRunning = running() !== undefined;
  if (wasRunning) await stop();
  installStagedBuild();
  if (wasRunning) await start({ foreground: false, open: false, built: true });
  log.success(`Updated to ${after.slice(0, 7)}.`);
}

async function doctor(): Promise<boolean> {
  let healthyAll = true;
  const report = (ok: boolean, message: string, fix?: string) => {
    if (ok) log.success(message);
    else {
      healthyAll = false;
      log.error(fix ? `${message}\n${dim(fix)}` : message);
    }
  };
  report(true, `Bun ${Bun.version}`);
  if (!existsSync(ENV_FILE)) {
    report(false, "No .env yet", `Run ${command(`${CLI} setup`)}.`);
    return false;
  }
  // Windows has no mode bits; .env sits in the user's own profile there.
  if (process.platform !== "win32") {
    report(
      (statSync(ENV_FILE).mode & 0o077) === 0,
      ".env is readable by you alone",
      "It holds your keys: chmod 600 .env",
    );
  }
  const env = runEnv(serverEnv());
  let config: ReturnType<typeof loadConfig> | undefined;
  let access: ReturnType<typeof localAccess>;
  try {
    access = localAccess(env);
    config = loadConfig(env);
    report(true, "Settings are valid");
  } catch (error) {
    report(
      false,
      error instanceof Error ? error.message : "Settings are invalid",
      `Run ${command(`${CLI} setup`)}.`,
    );
  }
  if (checkoutRevision() === undefined) {
    log.info("Not a Git checkout: every start builds the app afresh.");
  } else {
    report(
      !buildOutdated(),
      "The app is built for this version",
      `${command(`${CLI} start`)} builds it.`,
    );
  }
  if (env.EPHEMERA_UPSTREAM_BASE_URL) {
    const check = await checkModels(
      env.EPHEMERA_UPSTREAM_BASE_URL,
      env.EPHEMERA_UPSTREAM_API_KEY || undefined,
    );
    report(
      check.ok,
      check.ok
        ? `The model provider answers with ${models(check.models)}`
        : `The model provider does not answer (${check.reason})`,
      "Check EPHEMERA_UPSTREAM_BASE_URL and EPHEMERA_UPSTREAM_API_KEY, or run setup again.",
    );
  }
  const state: RunState | undefined = running();
  if (state && config) {
    report(
      await healthy(state, config.proxyKey),
      `Running at ${state.url}`,
      `Try ${command(`${CLI} restart`)}.`,
    );
  } else if (config) {
    for (const port of [...(access ? [access.port] : []), config.port]) {
      report(
        !(await portTaken(port)),
        `Port ${port} is free`,
        "Another program uses it; pick another port with setup.",
      );
    }
  }
  return healthyAll;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    yes: { type: "boolean", short: "y", default: false },
    upstream: { type: "string" },
    user: { type: "string" },
    port: { type: "string" },
    "behind-proxy": { type: "string" },
    "no-check": { type: "boolean", default: false },
    "no-start": { type: "boolean", default: false },
    foreground: { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    // Windows shortcuts: keep the window open on an error, so it can be read.
    pause: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [name = "help"] = positionals;

session.pauseOnError = values.pause;

if (values.help || name === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}

intro(TITLE);
switch (name) {
  case "setup": {
    const interactive = !values.yes && process.stdin.isTTY === true;
    const startNow = await setup({
      interactive,
      upstream: values.upstream,
      user: values.user,
      port: values.port,
      behindProxy: values["behind-proxy"],
      check: !values["no-check"],
    });
    const staged = await buildIfOutdated();
    if (running() !== undefined) {
      log.step("Restarting Ephemera so it uses the new settings");
      await stop();
      if (staged) installStagedBuild();
      await start({ foreground: false, open: false, built: staged });
    } else {
      if (staged) installStagedBuild();
      if (startNow && !values["no-start"]) {
        await start({ foreground: false, open: interactive, built: staged });
      } else log.info(`Start it any time with ${command(`${CLI} start`)}.`);
    }
    outro("You're all set.");
    break;
  }
  case "start":
    await start({ foreground: values.foreground, open: !values["no-open"] });
    outro(`${command(`${CLI} stop`)} stops it; ${command(`${CLI} status`)} shows how it is.`);
    break;
  case "stop":
    await stop();
    outro("See you soon.");
    break;
  case "restart":
    await stop();
    await start({ foreground: false, open: false });
    outro("Restarted.");
    break;
  case "status":
    await status();
    outro("");
    break;
  case "open": {
    const state = running();
    if (state === undefined)
      fail(`Ephemera is not running. Start it with ${command(`${CLI} start`)}.`);
    if (!openBrowser(state.url)) log.info(`Open ${accent(state.url)} in your browser.`);
    outro("");
    break;
  }
  case "update":
    await update();
    outro("");
    break;
  case "doctor": {
    const ok = await doctor();
    outro(ok ? "Everything looks right." : "Fix what is marked, then run it again.");
    process.exit(ok ? 0 : 1);
    break;
  }
  default:
    fail(`There is no command "${name}". Run ${command(`${CLI} help`)} to see them.`);
}
