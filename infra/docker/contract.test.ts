import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  type ComposeConfig,
  type ContainerInspect,
  checkConfig,
  checkContainer,
  composeConfigSchema,
  containerInspectSchema,
  imageInspectSchema,
  type Probe,
  probeSchema,
  type Rule,
} from "./contract.ts";

/**
 * Recorded from Docker Desktop (Engine 29.8.1, Compose v5.5.1), then made
 * synthetic: environment values, paths, ids, addresses, times and the port.
 */
const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));

const config = () => composeConfigSchema.parse(json("compose-config.json"));
const imageUser = () => imageInspectSchema.parse(json("image-inspect.json"))[0]?.Config.User;
const container = (): ContainerInspect => {
  const [inspected] = containerInspectSchema.parse(json("container-inspect.json"));
  if (!inspected) throw new Error("fixture holds no container");
  return inspected;
};
const diff = () => fixture("container-diff.txt");
const probe = (): Probe => probeSchema.parse(json("probe.json"));
/** What the deploy expects of the recorded stack: its data directory and the image it built. */
const EXPECTED = {
  dataDir: "/tmp/ephemera-fixture/data",
  imageId: `sha256:${"0123456789abcdef".repeat(4)}`,
};

/** The Compose file's ComfyUI CA bind as `docker compose config` resolves it. */
const caVolume = () => ({
  type: "bind",
  source: "/tmp/ephemera-fixture/comfyui-ca.pem",
  target: "/run/comfyui-ca.pem",
  read_only: true,
  bind: { create_host_path: false },
});

/** The Compose file's workflows bind with a host directory set, as `docker compose config` resolves it. */
const workflowsVolume = () => ({
  type: "bind",
  source: "/tmp/ephemera-fixture/workflows",
  target: "/run/workflows",
  read_only: true,
  bind: { create_host_path: false },
});

function service(value: ComposeConfig) {
  const found = value.services.ephemera;
  if (!found) throw new Error("fixture holds no ephemera service");
  return found;
}

/** Replaces the fixture's placeholder workflows bind with `volume`. */
function setWorkflowsVolume(value: ComposeConfig, volume: ReturnType<typeof workflowsVolume>) {
  const target = service(value);
  target.volumes = (target.volumes ?? []).map((entry) =>
    entry.target === "/run/workflows" ? volume : entry,
  );
}

describe("config mode", () => {
  test("the resolved example configuration and the built image pass", () => {
    expect(checkConfig(config(), imageUser(), EXPECTED.dataDir)).toEqual([]);
  });

  test("the configuration without the machine-local override lacks the memory limit", () => {
    const withoutOverride = composeConfigSchema.parse(json("compose-config-no-override.json"));
    expect(checkConfig(withoutOverride, imageUser(), EXPECTED.dataDir)).toEqual(["memory-no-swap"]);
  });

  const cases: [string, Rule, (value: ComposeConfig) => void, string?][] = [
    ["a missing service", "service", (value) => delete value.services.ephemera],
    [
      "a writable root",
      "read-only-root",
      (value) => {
        service(value).read_only = false;
      },
    ],
    [
      "a /tmp tmpfs without noexec",
      "tmp-tmpfs",
      (value) => {
        service(value).tmpfs = ["/tmp:size=64m,mode=1777,nosuid,nodev"];
      },
    ],
    [
      "a /tmp tmpfs without a size",
      "tmp-tmpfs",
      (value) => {
        service(value).tmpfs = ["/tmp:mode=1777,noexec,nosuid,nodev"];
      },
    ],
    ["a root image user", "non-root-user", () => {}, "0:0"],
    ["a named image user", "non-root-user", () => {}, "bun"],
    ["a uid without a gid", "non-root-user", () => {}, "1000"],
    [
      "a service user overriding the image as root",
      "non-root-user",
      (value) => {
        service(value).user = "0";
      },
    ],
    [
      "a swap limit above the memory limit",
      "memory-no-swap",
      (value) => {
        service(value).memswap_limit = 2 * 1024 ** 3;
      },
    ],
    [
      "a disk-backed logging driver",
      "logging-none",
      (value) => {
        service(value).logging = { driver: "local" };
      },
    ],
    [
      "a port published on every interface",
      "loopback-ports",
      (value) => {
        service(value).ports = [{ host_ip: "0.0.0.0", target: 8790 }];
      },
    ],
    [
      "a port published without a host address",
      "loopback-ports",
      (value) => {
        service(value).ports = [{ target: 8790, published: "8000" }];
      },
    ],
    [
      "the host network",
      "loopback-ports",
      (value) => {
        service(value).network_mode = "host";
      },
    ],
    [
      "a second volume",
      "mounts",
      (value) =>
        void service(value).volumes?.push({ type: "volume", target: "/app/apps/web/dist" }),
    ],
    [
      "a data bind that may create its host path",
      "mounts",
      (value) => {
        const [data] = service(value).volumes ?? [];
        if (data) data.bind = { create_host_path: true };
      },
    ],
    [
      "a second tmpfs",
      "mounts",
      (value) => {
        service(value).tmpfs = [
          "/tmp:size=64m,mode=1777,noexec,nosuid,nodev",
          "/run:size=1m,noexec,nosuid,nodev",
        ];
      },
    ],
    [
      "a data bind from another directory",
      "data-source",
      (value) => {
        const [data] = service(value).volumes ?? [];
        if (data) data.source = "/tmp/ephemera-fixture/other";
      },
    ],
    [
      "an image other than ephemera:latest",
      "image",
      (value) => {
        service(value).image = "ephemera:candidate";
      },
    ],
    [
      "kept capabilities",
      "cap-drop-all",
      (value) => {
        service(value).cap_drop = [];
      },
    ],
    [
      "an added capability",
      "cap-drop-all",
      (value) => {
        service(value).cap_add = ["NET_ADMIN"];
      },
    ],
    [
      "a privileged container",
      "not-privileged",
      (value) => {
        service(value).privileged = true;
      },
    ],
    [
      "no no-new-privileges",
      "no-new-privileges",
      (value) => {
        service(value).security_opt = [];
      },
    ],
    [
      "the host PID namespace",
      "namespaces",
      (value) => {
        service(value).pid = "host";
      },
    ],
    [
      "the host IPC namespace",
      "namespaces",
      (value) => {
        service(value).ipc = "host";
      },
    ],
    [
      "another container's IPC namespace",
      "namespaces",
      (value) => {
        service(value).ipc = "container:other";
      },
    ],
    [
      "the host user namespace",
      "namespaces",
      (value) => {
        service(value).userns_mode = "host";
      },
    ],
    [
      "a mapped device",
      "devices",
      (value) => {
        service(value).devices = [{ source: "/dev/fuse", target: "/dev/fuse", permissions: "rwm" }];
      },
    ],
    [
      "volumes from another container",
      "volumes-from",
      (value) => {
        service(value).volumes_from = ["other"];
      },
    ],
    [
      "no pids limit",
      "pids-limit",
      (value) => {
        delete service(value).pids_limit;
      },
    ],
    [
      "an unlimited pids limit",
      "pids-limit",
      (value) => {
        service(value).pids_limit = -1;
      },
    ],
    [
      "an override adding a service published on every interface",
      "only-service",
      (value) => {
        value.services.sidecar = {
          image: "nginx:latest",
          ports: [{ host_ip: "0.0.0.0", target: 80, published: "8080" }],
        };
      },
    ],
    [
      "an override adding a service without an image",
      "only-service",
      (value) => {
        value.services.builder = { build: { context: "." } };
      },
    ],
    [
      "a writable ComfyUI CA bind",
      "mounts",
      (value) => void service(value).volumes?.push({ ...caVolume(), read_only: false }),
    ],
    [
      "a ComfyUI CA bind that may create its host path",
      "mounts",
      (value) =>
        void service(value).volumes?.push({ ...caVolume(), bind: { create_host_path: true } }),
    ],
    [
      "two ComfyUI CA binds",
      "mounts",
      (value) => void service(value).volumes?.push(caVolume(), caVolume()),
    ],
    [
      "a writable workflows bind",
      "mounts",
      (value) => setWorkflowsVolume(value, { ...workflowsVolume(), read_only: false }),
    ],
    [
      "a workflows bind that may create its host path",
      "mounts",
      (value) =>
        setWorkflowsVolume(value, { ...workflowsVolume(), bind: { create_host_path: true } }),
    ],
    [
      "a read-only workflows directory at another target",
      "mounts",
      (value) =>
        setWorkflowsVolume(value, {
          ...workflowsVolume(),
          target: "/app/apps/server/src/comfyui/workflows",
        }),
    ],
    [
      "a third read-only bind beside the CA and workflows binds",
      "mounts",
      (value) => void service(value).volumes?.push(caVolume(), workflowsVolume()),
    ],
  ];

  test("a read-only bind of the ComfyUI CA file passes", () => {
    const value = config();
    service(value).volumes?.push(caVolume());
    expect(checkConfig(value, imageUser(), EXPECTED.dataDir)).toEqual([]);
  });

  test("a read-only bind of a host workflows directory passes", () => {
    const value = config();
    setWorkflowsVolume(value, workflowsVolume());
    expect(checkConfig(value, imageUser(), EXPECTED.dataDir)).toEqual([]);
  });

  test("a configuration without the workflows bind passes", () => {
    const value = config();
    const target = service(value);
    target.volumes = target.volumes?.filter((volume) => volume.target !== "/run/workflows");
    expect(checkConfig(value, imageUser(), EXPECTED.dataDir)).toEqual([]);
  });

  test("a resolved configuration with an extra service parses and fails only that rule", () => {
    const resolved = json("compose-config.json") as { services: Record<string, unknown> };
    resolved.services.sidecar = {
      build: { context: "/srv/sidecar" },
      ports: [{ mode: "ingress", host_ip: "0.0.0.0", target: 80, published: "8080" }],
    };
    expect(checkConfig(composeConfigSchema.parse(resolved), imageUser(), EXPECTED.dataDir)).toEqual(
      ["only-service"],
    );
  });

  test.each(cases)("%s breaks %s", (_, rule, mutate, user) => {
    const value = config();
    mutate(value);
    expect(checkConfig(value, user ?? imageUser(), EXPECTED.dataDir)).toEqual([rule]);
  });
});

describe("container mode", () => {
  const caMount = {
    Type: "bind",
    Source: "/tmp/ephemera-fixture/comfyui-ca.pem",
    Destination: "/run/comfyui-ca.pem",
    RW: false,
  };
  const workflowsMount = {
    Type: "bind",
    Source: "/tmp/ephemera-fixture/workflows",
    Destination: "/run/workflows",
    RW: false,
  };
  /** Replaces the recorded placeholder workflows bind with `mount`. */
  const setWorkflowsMount = (value: ContainerInspect, mount: typeof workflowsMount) => {
    value.Mounts = value.Mounts.map((entry) =>
      entry.Destination === "/run/workflows" ? mount : entry,
    );
  };

  test("the recorded running container passes", () => {
    expect(checkContainer(container(), diff(), probe(), EXPECTED)).toEqual([]);
  });

  const cases: [
    string,
    Rule[],
    (value: ContainerInspect) => void,
    (string | undefined)?,
    Probe?,
  ][] = [
    [
      "a writable root",
      ["read-only-root"],
      (value) => {
        value.HostConfig.ReadonlyRootfs = false;
      },
    ],
    [
      "a /tmp tmpfs without nodev",
      ["tmp-tmpfs"],
      (value) => {
        value.HostConfig.Tmpfs = { "/tmp": "size=64m,mode=1777,noexec,nosuid" };
      },
    ],
    [
      "root",
      ["non-root-user"],
      (value) => {
        value.Config.User = "0:0";
      },
    ],
    [
      "the image default user",
      ["non-root-user"],
      (value) => {
        value.Config.User = "";
      },
    ],
    [
      "unlimited swap",
      ["memory-no-swap"],
      (value) => {
        value.HostConfig.MemorySwap = -1;
      },
    ],
    [
      "no memory limit",
      ["memory-no-swap"],
      (value) => {
        value.HostConfig.Memory = 0;
        value.HostConfig.MemorySwap = 0;
      },
    ],
    [
      "the json-file driver",
      ["logging-none"],
      (value) => {
        value.HostConfig.LogConfig = { Type: "json-file" };
      },
    ],
    [
      "a port on every interface",
      ["loopback-ports"],
      (value) => {
        value.HostConfig.PortBindings = {
          "8790/tcp": [{ HostIp: "", HostPort: "8000" }],
        };
      },
    ],
    [
      "published exposed ports",
      ["loopback-ports"],
      (value) => {
        value.HostConfig.PublishAllPorts = true;
      },
    ],
    [
      "the host network",
      ["loopback-ports"],
      (value) => {
        value.HostConfig.NetworkMode = "host";
      },
    ],
    [
      "an anonymous volume",
      ["mounts"],
      (value) => value.Mounts.push({ Type: "volume", Source: "", Destination: "/app" }),
    ],
    [
      "a bind from another directory",
      ["data-source"],
      (value) => {
        const [data] = value.Mounts;
        if (data) data.Source = "/tmp/ephemera-fixture/other";
      },
    ],
    [
      "an image other than the one the deploy built",
      ["image"],
      (value) => {
        value.Image = `sha256:${"0".repeat(64)}`;
      },
    ],
    [
      "a second tmpfs",
      ["mounts"],
      (value) => {
        value.HostConfig.Tmpfs = {
          "/tmp": "size=64m,mode=1777,noexec,nosuid,nodev",
          "/run": "size=1m,noexec,nosuid,nodev",
        };
      },
    ],
    [
      "kept capabilities",
      ["cap-drop-all"],
      (value) => {
        value.HostConfig.CapDrop = null;
      },
    ],
    [
      "an added capability",
      ["cap-drop-all"],
      (value) => {
        value.HostConfig.CapAdd = ["SYS_ADMIN"];
      },
    ],
    [
      "privileged",
      ["not-privileged"],
      (value) => {
        value.HostConfig.Privileged = true;
      },
    ],
    [
      "the host PID namespace",
      ["namespaces"],
      (value) => {
        value.HostConfig.PidMode = "host";
      },
    ],
    [
      "the host IPC namespace",
      ["namespaces"],
      (value) => {
        value.HostConfig.IpcMode = "host";
      },
    ],
    [
      "the host user namespace",
      ["namespaces"],
      (value) => {
        value.HostConfig.UsernsMode = "host";
      },
    ],
    [
      "a mapped device",
      ["devices"],
      (value) => {
        value.HostConfig.Devices = [
          { PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" },
        ];
      },
    ],
    [
      "volumes from another container",
      ["volumes-from"],
      (value) => {
        value.HostConfig.VolumesFrom = ["other"];
      },
    ],
    [
      "no pids limit",
      ["pids-limit"],
      (value) => {
        value.HostConfig.PidsLimit = null;
      },
    ],
    [
      "an unlimited pids limit",
      ["pids-limit"],
      (value) => {
        value.HostConfig.PidsLimit = 0;
      },
    ],
    [
      "no no-new-privileges",
      ["no-new-privileges"],
      (value) => {
        value.HostConfig.SecurityOpt = null;
      },
    ],
    [
      "an unhealthy container",
      ["healthy"],
      (value) => {
        value.State.Health = { Status: "unhealthy" };
      },
    ],
    [
      "a stopped container",
      ["healthy"],
      (value) => {
        value.State.Running = false;
      },
    ],
    ["a file written to /app", ["empty-diff"], () => {}, "C /app\nA /app/notes.txt\n"],
    [
      "the init mount point without init",
      ["empty-diff"],
      (value) => {
        value.HostConfig.Init = false;
      },
    ],
    ["a writable /", ["probe-root"], () => {}, undefined, { root: "written", app: "EROFS" }],
    ["a writable /app", ["probe-app"], () => {}, undefined, { root: "EROFS", app: "written" }],
    [
      "a writable ComfyUI CA bind",
      ["mounts"],
      (value) => void value.Mounts.push({ ...caMount, RW: true }),
    ],
    [
      "a second bind at the CA's place",
      ["mounts"],
      (value) => void value.Mounts.push(caMount, caMount),
    ],
    [
      "a writable workflows bind",
      ["mounts"],
      (value) => setWorkflowsMount(value, { ...workflowsMount, RW: true }),
    ],
    [
      "a read-only workflows directory at another target",
      ["mounts"],
      (value) =>
        setWorkflowsMount(value, {
          ...workflowsMount,
          Destination: "/app/apps/server/src/comfyui/workflows",
        }),
    ],
    [
      "a third read-only bind beside the CA and workflows binds",
      ["mounts"],
      (value) => void value.Mounts.push(caMount, workflowsMount),
    ],
  ];

  test("a read-only bind of the ComfyUI CA file passes", () => {
    const value = container();
    value.Mounts.push(caMount);
    expect(checkContainer(value, diff(), probe(), EXPECTED)).toEqual([]);
  });

  test("read-only binds of the CA file and a host workflows directory pass", () => {
    const value = container();
    setWorkflowsMount(value, workflowsMount);
    value.Mounts.push(caMount);
    expect(checkContainer(value, diff(), probe(), EXPECTED)).toEqual([]);
  });

  test("a container without the workflows bind passes", () => {
    const value = container();
    value.Mounts = value.Mounts.filter((mount) => mount.Destination !== "/run/workflows");
    expect(checkContainer(value, diff(), probe(), EXPECTED)).toEqual([]);
  });

  test.each(cases)("%s breaks %j", (_, rules, mutate, changes, result) => {
    const value = container();
    mutate(value);
    expect(checkContainer(value, changes ?? diff(), result ?? probe(), EXPECTED)).toEqual(rules);
  });

  test("a probe that could not run proves neither write fails", () => {
    expect(checkContainer(container(), diff(), undefined, EXPECTED)).toEqual([
      "probe-root",
      "probe-app",
    ]);
  });
});

test("the compose file names the container ephemera, as the runbook's commands do", () => {
  const compose = z
    .object({ services: z.object({ ephemera: z.object({ container_name: z.string() }) }) })
    .parse(YAML.parse(readFileSync(join(import.meta.dirname, "docker-compose.yml"), "utf8")));
  expect(compose.services.ephemera.container_name).toBe("ephemera");
  const runbook = readFileSync(join(import.meta.dirname, "../../docs/ARCHITECTURE.md"), "utf8");
  expect(runbook).toContain("docker container inspect --format '{{json .State.Health}}' ephemera");
});

test("the compose file binds extra workflows read-only and pins no platform", () => {
  const text = readFileSync(join(import.meta.dirname, "docker-compose.yml"), "utf8");
  const volume = z.object({
    source: z.string(),
    target: z.string(),
    read_only: z.boolean().optional(),
    bind: z.object({ create_host_path: z.boolean() }).optional(),
  });
  const compose = z
    .object({
      services: z.object({
        ephemera: z.looseObject({
          build: z.looseObject({}),
          environment: z.record(z.string(), z.string()),
          volumes: z.array(volume),
        }),
      }),
    })
    .parse(YAML.parse(text));
  const { ephemera } = compose.services;
  // The container sees the read-only copy's path, never the host path.
  expect(ephemera.environment.EPHEMERA_WORKFLOWS_DIR).toBe(
    `\${EPHEMERA_WORKFLOWS_DIR:+/run/workflows}`,
  );
  expect(ephemera.volumes.filter((entry) => entry.target === "/run/workflows")).toEqual([
    {
      source: `\${EPHEMERA_WORKFLOWS_DIR:-./no-workflows}`,
      target: "/run/workflows",
      read_only: true,
      bind: { create_host_path: false },
    },
  ]);
  expect(readdirSync(join(import.meta.dirname, "no-workflows"))).toEqual([".keep"]);
  expect("platform" in ephemera).toBe(false);
  expect("platforms" in ephemera.build).toBe(false);
  const dockerfile = readFileSync(join(import.meta.dirname, "Dockerfile"), "utf8");
  expect(dockerfile).toMatch(/install -d -m 0755 [^\n]*\/run\/workflows/);
});

describe("command line", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ephemera-contract-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const secret = `secret-${crypto.randomUUID()}`;

  /**
   * A directory holding a stub `docker` that serves the recorded fixtures, with
   * a secret where Docker would put one; returns it for PATH.
   */
  function stubDocker(name: string, composeFixture: string, composeFails = false): string {
    const bin = join(scratch, name);
    mkdirSync(bin);
    const compose = json(composeFixture) as { services: Record<string, Record<string, unknown>> };
    const composeService = compose.services.ephemera;
    if (composeService) composeService.environment = { EPHEMERA_PROXY_KEY: secret };
    const inspected = json("container-inspect.json") as { Config: { Env: string[] } }[];
    for (const entry of inspected) entry.Config.Env = [`EPHEMERA_PROXY_KEY=${secret}`];
    const files: Record<string, string> = {
      "compose.json": JSON.stringify(compose),
      "image.json": fixture("image-inspect.json"),
      "inspect.json": JSON.stringify(inspected),
      "diff.txt": diff(),
      "probe.json": fixture("probe.json"),
    };
    for (const [file, text] of Object.entries(files)) writeFileSync(join(bin, file), text);
    const script = [
      "#!/bin/sh",
      'here="$(dirname "$0")"',
      'case "$1 $2" in',
      composeFails
        ? `  "compose config") echo 'unterminated quoted value "${secret}' >&2; exit 15 ;;`
        : '  "compose config") cat "$here/compose.json" ;;',
      '  "image inspect") cat "$here/image.json" ;;',
      '  "ps --quiet") echo 0123456789ab ;;',
      '  "inspect 0123456789ab") cat "$here/inspect.json" ;;',
      '  "diff 0123456789ab") cat "$here/diff.txt" ;;',
      '  "exec 0123456789ab") cat "$here/probe.json" ;;',
      "  *) exit 64 ;;",
      "esac",
      "",
    ].join("\n");
    writeFileSync(join(bin, "docker"), script, { mode: 0o755 });
    return bin;
  }

  const expectations = {
    EPHEMERA_EXPECTED_DATA_DIR: EXPECTED.dataDir,
    EPHEMERA_EXPECTED_IMAGE_ID: EXPECTED.imageId,
  };

  function run(bin: string, args: string[], env: Record<string, string> = expectations) {
    const result = Bun.spawnSync(["bun", join(import.meta.dirname, "contract.ts"), ...args], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  }

  test("both modes pass on the recorded stack and print no secret", () => {
    const bin = stubDocker("pass", "compose-config.json");
    for (const args of [["config"], ["config", "ephemera:candidate"], ["container"]]) {
      const { exitCode, output } = run(bin, args);
      expect(exitCode).toBe(0);
      expect(output).toContain("passed");
      expect(output).not.toContain(secret);
    }
  });

  test("a violated rule exits non-zero and names the rule, not the values", () => {
    const { exitCode, output } = run(stubDocker("fail", "compose-config-no-override.json"), [
      "config",
    ]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("memory-no-swap");
    expect(output).not.toContain(secret);
  });

  test("a failing compose config prints a fixed message with the exit status, never Docker's error", () => {
    const { exitCode, output } = run(stubDocker("echo", "compose-config.json", true), ["config"]);
    expect(exitCode).toBe(1);
    expect(output).toContain("docker compose failed with exit status 15");
    expect(output).not.toContain(secret);
  });

  test("each mode refuses to run without its expectations", () => {
    const bin = stubDocker("expectations", "compose-config.json");
    const { EPHEMERA_EXPECTED_DATA_DIR } = expectations;
    for (const [args, env] of [
      [["config"], {}],
      [["container"], {}],
      [["container"], { EPHEMERA_EXPECTED_DATA_DIR }],
    ] as const) {
      const { exitCode, output } = run(bin, [...args], env);
      expect(exitCode).toBe(2);
      expect(output).toMatch(/EPHEMERA_EXPECTED_/);
    }
  });

  test("an unknown mode is refused", () => {
    expect(run(stubDocker("usage", "compose-config.json"), ["deploy"]).exitCode).not.toBe(0);
  });
});
