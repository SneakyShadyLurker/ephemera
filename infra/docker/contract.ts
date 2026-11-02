/**
 * The container contract (docs/PRINCIPLES.md 1, Container), checked twice per
 * deploy: `config` reads the resolved Compose configuration of this directory
 * (and the user of the image it will run) before anything starts; `container`
 * reads the running container's inspect data, its file-system diff and a probe
 * write. Both parse Docker's JSON with Zod and tie the service to what
 * the deploy validated: the data directory's real path in
 * EPHEMERA_EXPECTED_DATA_DIR (both modes) and the built image's ID in
 * EPHEMERA_EXPECTED_IMAGE_ID (container mode). Output names violated rules
 * only: the resolved `environment` and the container's `Config.Env` hold
 * secrets, so the schemas drop them, Docker's stderr (which can echo a
 * malformed env value) stays in memory, and nothing here prints a Docker value.
 *
 * Usage: EPHEMERA_EXPECTED_DATA_DIR=<path> bun infra/docker/contract.ts config [image]
 *        EPHEMERA_EXPECTED_DATA_DIR=<path> EPHEMERA_EXPECTED_IMAGE_ID=<id> \
 *          bun infra/docker/contract.ts container
 */
import { z } from "zod";

export const PROJECT = "ephemera";
export const SERVICE = "ephemera";
const IMAGE = "ephemera:latest";
const DATA_TARGET = "/data";
/** Where the Compose file binds the ComfyUI CA certificate, or its empty placeholder, read-only. */
const CA_TARGET = "/run/comfyui-ca.pem";
/** Where the Compose file binds the extra workflows directory, or its empty placeholder, read-only. */
const WORKFLOWS_TARGET = "/run/workflows";
/** The optional read-only binds beside the data bind, each at most once. */
const OPTIONAL_TARGETS = [CA_TARGET, WORKFLOWS_TARGET];
const TMP_TARGET = "/tmp";
const TMPFS_FLAGS = ["noexec", "nosuid", "nodev"];
const LOOPBACK = "127.0.0.1";
/** The diff lines of the mount point Docker adds for `init: true` (docker-init); nothing is written there. */
const INIT_MOUNT_DIFF = ["C /sbin", "A /sbin/docker-init"];

export const RULES = {
  service: "the ephemera service exists",
  "only-service": "config: ephemera is the only service",
  "read-only-root": "the root file system is read-only",
  "tmp-tmpfs": "/tmp is a sized tmpfs mounted noexec, nosuid and nodev",
  "non-root-user": "the process runs as a numeric non-root uid:gid",
  "memory-no-swap": "a memory limit is set and the swap limit equals it",
  "logging-none": "the logging driver is none",
  "loopback-ports": "every published port binds 127.0.0.1 (no host network, no publish-all)",
  mounts:
    "the only mounts are the /data bind (never created on the host), the /tmp tmpfs and at most one read-only bind each of the ComfyUI CA file and the workflows directory",
  "data-source":
    "the /data bind's source is EPHEMERA_EXPECTED_DATA_DIR, the data directory the deploy checked",
  image:
    "config: the service runs ephemera:latest; container: the container's image ID is EPHEMERA_EXPECTED_IMAGE_ID, the image the deploy built",
  "cap-drop-all": "all capabilities are dropped, none added",
  "not-privileged": "the container is not privileged",
  "no-new-privileges": "no-new-privileges is set",
  namespaces: "the PID, IPC and user namespaces are the container's own, never the host's",
  devices: "no host device is mapped",
  "volumes-from": "no volumes come from another container",
  "pids-limit": "a positive pids limit is set",
  healthy: "the container runs and its health is healthy",
  "empty-diff": "the container's file-system diff is empty, but for the init binary's mount point",
  "probe-root": "a probe write to / fails",
  "probe-app": "a probe write to /app fails",
} as const;

export type Rule = keyof typeof RULES;

// Docker values Zod checks at the boundary. Unknown keys (environment, Env) are dropped.

const byteCount = z.union([
  z.number(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
]);

const composeServiceSchema = z.object({
  image: z.string().min(1),
  user: z.string().optional(),
  read_only: z.boolean().optional(),
  privileged: z.boolean().optional(),
  network_mode: z.string().optional(),
  tmpfs: z.union([z.string(), z.array(z.string())]).optional(),
  mem_limit: byteCount.optional(),
  memswap_limit: byteCount.optional(),
  logging: z.object({ driver: z.string().optional() }).optional(),
  ports: z
    .array(
      z.object({
        host_ip: z.string().optional(),
        target: z.number(),
        published: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
  volumes: z
    .array(
      z.object({
        type: z.string(),
        source: z.string().optional(),
        target: z.string(),
        read_only: z.boolean().optional(),
        bind: z.object({ create_host_path: z.boolean().optional() }).optional(),
      }),
    )
    .optional(),
  cap_drop: z.array(z.string()).optional(),
  cap_add: z.array(z.string()).optional(),
  security_opt: z.array(z.string()).optional(),
  pid: z.string().optional(),
  ipc: z.string().optional(),
  userns_mode: z.string().optional(),
  devices: z.array(z.unknown()).optional(),
  volumes_from: z.array(z.string()).optional(),
  pids_limit: z.number().optional(),
});

/** The ephemera service in full; any other service only by name, so its presence fails a rule. */
export const composeConfigSchema = z.object({
  services: z.object({ [SERVICE]: composeServiceSchema.optional() }).catchall(z.unknown()),
});

export const imageInspectSchema = z
  .array(z.object({ Config: z.object({ User: z.string() }) }))
  .length(1);

const portBindingSchema = z.object({ HostIp: z.string(), HostPort: z.string() });

export const containerInspectSchema = z
  .array(
    z.object({
      Image: z.string(),
      Config: z.object({ User: z.string() }),
      State: z.object({
        Running: z.boolean(),
        Health: z.object({ Status: z.string() }).optional(),
      }),
      HostConfig: z.object({
        ReadonlyRootfs: z.boolean(),
        Privileged: z.boolean(),
        NetworkMode: z.string(),
        PublishAllPorts: z.boolean(),
        Init: z.boolean().nullish(),
        Tmpfs: z.record(z.string(), z.string()).nullish(),
        Memory: z.number(),
        MemorySwap: z.number(),
        LogConfig: z.object({ Type: z.string() }),
        PortBindings: z.record(z.string(), z.array(portBindingSchema).nullable()).nullish(),
        CapDrop: z.array(z.string()).nullish(),
        CapAdd: z.array(z.string()).nullish(),
        SecurityOpt: z.array(z.string()).nullish(),
        PidMode: z.string(),
        IpcMode: z.string(),
        UsernsMode: z.string(),
        Devices: z.array(z.unknown()).nullish(),
        VolumesFrom: z.array(z.string()).nullish(),
        PidsLimit: z.number().nullish(),
      }),
      Mounts: z.array(
        z.object({
          Type: z.string(),
          Source: z.string(),
          Destination: z.string(),
          RW: z.boolean().optional(),
        }),
      ),
    }),
  )
  .length(1);

export const probeSchema = z.object({ root: z.string(), app: z.string() });

export type ComposeConfig = z.infer<typeof composeConfigSchema>;
export type ContainerInspect = z.infer<typeof containerInspectSchema>[number];
export type Probe = z.infer<typeof probeSchema>;

/** What the deploy validated: the data directory's real path and the image ID it built. */
export interface Expected {
  dataDir: string;
  imageId: string;
}

/** A tmpfs spec such as `/tmp:size=64m,mode=1777,noexec,nosuid,nodev`, as path and options. */
function tmpfsEntry(spec: string): [string, string[]] {
  const [path = "", options = ""] = spec.split(/:(.*)/s);
  return [path, options.split(",").filter(Boolean)];
}

const hardenedTmp = (options: string[]) =>
  options.some((option) => /^size=\d+[kmg]?$/i.test(option)) &&
  TMPFS_FLAGS.every((flag) => options.includes(flag));

/** Numeric `uid:gid`, neither of them root. */
const nonRootUser = (user: string | undefined) => {
  const match = /^(\d+):(\d+)$/.exec(user ?? "");
  return match !== null && Number(match[1]) !== 0 && Number(match[2]) !== 0;
};

const noNewPrivileges = (options: readonly string[] | null | undefined) =>
  (options ?? []).some((option) => /^no-new-privileges(?:[:=]true)?$/.test(option));

/**
 * The namespace modes that keep the container in its own namespaces: the
 * default (empty) everywhere, and for IPC also Docker's `private` and `none`.
 * `host`, `container:<id>` and `shareable` are refused.
 */
const ownNamespaces = (
  pid: string | undefined,
  ipc: string | undefined,
  userns: string | undefined,
) => (pid ?? "") === "" && ["", "private", "none"].includes(ipc ?? "") && (userns ?? "") === "";

const positive = (limit: number | null | undefined) =>
  limit !== undefined && limit !== null && limit > 0;

/** Whether the extra mounts' targets are optional ones, none of them twice. */
const optionalTargets = (targets: string[]) =>
  targets.every((target) => OPTIONAL_TARGETS.includes(target)) &&
  new Set(targets).size === targets.length;

const violations = (checks: [Rule, boolean][]): Rule[] =>
  checks.filter(([, holds]) => !holds).map(([rule]) => rule);

/**
 * Rules the resolved Compose service breaks; `imageUser` is the image's
 * configured user, `dataDir` the real path of the data directory the deploy checked.
 */
export function checkConfig(
  config: ComposeConfig,
  imageUser: string | undefined,
  dataDir: string,
): Rule[] {
  const service = config.services[SERVICE];
  if (!service) return ["service"];
  const others = Object.keys(config.services).filter((name) => name !== SERVICE);
  const tmpfs = (typeof service.tmpfs === "string" ? [service.tmpfs] : (service.tmpfs ?? [])).map(
    tmpfsEntry,
  );
  const tmp = tmpfs.find(([path]) => path === TMP_TARGET);
  const volumes = service.volumes ?? [];
  const [data, ...extra] = volumes;
  const optionalBinds =
    optionalTargets(extra.map((volume) => volume.target)) &&
    extra.every(
      (volume) =>
        volume.type === "bind" &&
        volume.read_only === true &&
        volume.bind?.create_host_path === false,
    );
  return violations([
    ["only-service", others.length === 0],
    ["read-only-root", service.read_only === true],
    ["tmp-tmpfs", tmp !== undefined && hardenedTmp(tmp[1])],
    ["non-root-user", nonRootUser(service.user ?? imageUser)],
    ["memory-no-swap", (service.mem_limit ?? 0) > 0 && service.memswap_limit === service.mem_limit],
    ["logging-none", service.logging?.driver === "none"],
    [
      "loopback-ports",
      service.network_mode !== "host" &&
        (service.ports ?? []).every((port) => port.host_ip === LOOPBACK),
    ],
    [
      "mounts",
      optionalBinds &&
        data?.type === "bind" &&
        data.target === DATA_TARGET &&
        data.bind?.create_host_path === false &&
        tmpfs.length === 1 &&
        tmp !== undefined,
    ],
    ["data-source", volumes.find((volume) => volume.target === DATA_TARGET)?.source === dataDir],
    ["image", service.image === IMAGE],
    [
      "cap-drop-all",
      (service.cap_drop ?? []).includes("ALL") && (service.cap_add ?? []).length === 0,
    ],
    ["not-privileged", service.privileged !== true],
    ["no-new-privileges", noNewPrivileges(service.security_opt)],
    ["namespaces", ownNamespaces(service.pid, service.ipc, service.userns_mode)],
    ["devices", (service.devices ?? []).length === 0],
    ["volumes-from", (service.volumes_from ?? []).length === 0],
    ["pids-limit", positive(service.pids_limit)],
  ]);
}

/** Rules the running container breaks, from `docker inspect`, `docker diff` and the probe. */
export function checkContainer(
  container: ContainerInspect,
  diff: string,
  probe: Probe | undefined,
  expected: Expected,
): Rule[] {
  const host = container.HostConfig;
  const tmpfs = Object.entries(host.Tmpfs ?? {});
  const tmpOptions = host.Tmpfs?.[TMP_TARGET];
  const bindings = Object.values(host.PortBindings ?? {}).flatMap((list) => list ?? []);
  const mounts = container.Mounts;
  const data = mounts.find((mount) => mount.Destination === DATA_TARGET);
  const extra = mounts.filter((mount) => mount !== data);
  return violations([
    ["read-only-root", host.ReadonlyRootfs],
    ["tmp-tmpfs", tmpOptions !== undefined && hardenedTmp(tmpOptions.split(","))],
    ["non-root-user", nonRootUser(container.Config.User)],
    ["memory-no-swap", host.Memory > 0 && host.MemorySwap === host.Memory],
    ["logging-none", host.LogConfig.Type === "none"],
    [
      "loopback-ports",
      host.NetworkMode !== "host" &&
        !host.PublishAllPorts &&
        bindings.every((binding) => binding.HostIp === LOOPBACK),
    ],
    [
      "mounts",
      data?.Type === "bind" &&
        optionalTargets(extra.map((mount) => mount.Destination)) &&
        extra.every((mount) => mount.Type === "bind" && mount.RW === false) &&
        tmpfs.length === 1 &&
        tmpOptions !== undefined,
    ],
    [
      "data-source",
      mounts.find((mount) => mount.Destination === DATA_TARGET)?.Source === expected.dataDir,
    ],
    ["image", container.Image === expected.imageId],
    ["cap-drop-all", (host.CapDrop ?? []).includes("ALL") && (host.CapAdd ?? []).length === 0],
    ["not-privileged", !host.Privileged],
    ["no-new-privileges", noNewPrivileges(host.SecurityOpt)],
    ["namespaces", ownNamespaces(host.PidMode, host.IpcMode, host.UsernsMode)],
    ["devices", (host.Devices ?? []).length === 0],
    ["volumes-from", (host.VolumesFrom ?? []).length === 0],
    ["pids-limit", positive(host.PidsLimit)],
    ["healthy", container.State.Running && container.State.Health?.Status === "healthy"],
    [
      "empty-diff",
      diff
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .every((line) => host.Init === true && INIT_MOUNT_DIFF.includes(line)),
    ],
    ["probe-root", probe !== undefined && probe.root !== "written"],
    ["probe-app", probe !== undefined && probe.app !== "written"],
  ]);
}

/**
 * Runs in the container: tries to create a file in / and in /app and reports
 * each outcome as "written" or the error code. A file that could be written is
 * removed again.
 */
export const PROBE_SCRIPT = `
const fs = require("node:fs");
const result = {};
for (const [name, path] of [["root", "/.ephemera-probe"], ["app", "/app/.ephemera-probe"]]) {
  try { fs.writeFileSync(path, ""); fs.rmSync(path); result[name] = "written"; }
  catch (error) { result[name] = error?.code ?? "failed"; }
}
process.stdout.write(JSON.stringify(result));
`;

class ContractInputError extends Error {
  override name = "ContractInputError";
}

/**
 * Runs a Docker command in this directory. Stdout and stderr stay in memory,
 * never echoed: `compose` reads the env file and its errors can quote a value.
 */
function docker(args: string[]): string {
  const result = Bun.spawnSync(["docker", ...args], {
    cwd: import.meta.dirname,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    throw new ContractInputError(`docker ${args[0]} failed with exit status ${result.exitCode}`);
  }
  return result.stdout.toString();
}

/** Parses Docker JSON; an error names the failing paths, never the values. */
function parse<T>(schema: z.ZodType<T>, text: string, source: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ContractInputError(`${source}: not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new ContractInputError(
      `${source}: unexpected shape at ${[...new Set(paths)].join(", ")}`,
    );
  }
  return parsed.data;
}

function configMode(image: string | undefined, dataDir: string): Rule[] {
  const config = parse(
    composeConfigSchema,
    docker(["compose", "config", "--format", "json"]),
    "compose config",
  );
  const reference = image ?? config.services[SERVICE]?.image;
  if (reference === undefined) return ["service"];
  const [inspected] = parse(
    imageInspectSchema,
    docker(["image", "inspect", reference]),
    "image inspect",
  );
  return checkConfig(config, inspected?.Config.User, dataDir);
}

function containerMode(expected: Expected): Rule[] {
  const ids = docker([
    "ps",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
    "--filter",
    `label=com.docker.compose.service=${SERVICE}`,
  ])
    .split("\n")
    .filter(Boolean);
  const [id] = ids;
  if (id === undefined || ids.length > 1) return ["service"];
  const [container] = parse(containerInspectSchema, docker(["inspect", id]), "inspect");
  if (!container) return ["service"];
  const diff = docker(["diff", id]);
  let probe: Probe | undefined;
  try {
    probe = parse(probeSchema, docker(["exec", id, "bun", "-e", PROBE_SCRIPT]), "probe");
  } catch {
    probe = undefined;
  }
  return checkContainer(container, diff, probe, expected);
}

/** An expectation from the environment; the deploy sets both (neither is secret). */
function expectation(name: "EPHEMERA_EXPECTED_DATA_DIR" | "EPHEMERA_EXPECTED_IMAGE_ID") {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function main(argv: string[]): number {
  const [mode, image] = argv;
  if (!(mode === "config" && argv.length <= 2) && !(mode === "container" && argv.length === 1)) {
    process.stderr.write("usage: contract.ts config [image] | contract.ts container\n");
    return 2;
  }
  const dataDir = expectation("EPHEMERA_EXPECTED_DATA_DIR");
  const imageId = expectation("EPHEMERA_EXPECTED_IMAGE_ID");
  let check: () => Rule[];
  if (mode === "config" && dataDir !== undefined) {
    check = () => configMode(image, dataDir);
  } else if (mode === "container" && dataDir !== undefined && imageId !== undefined) {
    check = () => containerMode({ dataDir, imageId });
  } else {
    const names =
      mode === "config"
        ? "EPHEMERA_EXPECTED_DATA_DIR"
        : "EPHEMERA_EXPECTED_DATA_DIR and EPHEMERA_EXPECTED_IMAGE_ID";
    process.stderr.write(`contract ${mode}: set ${names}\n`);
    return 2;
  }
  let failed: Rule[];
  try {
    failed = check();
  } catch (error) {
    if (!(error instanceof ContractInputError)) throw error;
    process.stderr.write(`contract ${mode}: cannot check: ${error.message}\n`);
    return 1;
  }
  if (failed.length === 0) {
    process.stdout.write(`contract ${mode}: passed\n`);
    return 0;
  }
  process.stderr.write(`contract ${mode}: failed\n`);
  for (const rule of failed) process.stderr.write(`  ${rule}: ${RULES[rule]}\n`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
