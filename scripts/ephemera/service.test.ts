import { join } from "node:path";
import { expect, it } from "vitest";
import { HOME_DIR } from "./env.ts";
import { dataDir, runEnv, STATIC_DIR } from "./service.ts";

it("serves the built app, behind the gateway on loopback when it is on", () => {
  const local = runEnv({
    EPHEMERA_LOCAL_USER: "theo",
    EPHEMERA_LOCAL_PORT: "9001",
    EPHEMERA_ORIGIN: "http://localhost:5173",
    EPHEMERA_HOST: "0.0.0.0",
  });
  expect(local.EPHEMERA_STATIC_DIR).toBe(STATIC_DIR);
  expect(local.EPHEMERA_ORIGIN).toBe("http://localhost:9001");
  expect(local.EPHEMERA_HOST).toBe("127.0.0.1");

  const proxied = runEnv({
    EPHEMERA_ORIGIN: "https://ephemera.example",
    EPHEMERA_HOST: "10.0.0.2",
  });
  expect(proxied.EPHEMERA_ORIGIN).toBe("https://ephemera.example");
  expect(proxied.EPHEMERA_HOST).toBe("10.0.0.2");
});

it("reads a relative data directory from the install's home, never from the code's folder", () => {
  expect(dataDir({ EPHEMERA_DATA_DIR: "library" })).toBe(join(HOME_DIR, "library"));
  expect(dataDir({})).toBe(join(HOME_DIR, "data"));
  expect(runEnv({ EPHEMERA_DATA_DIR: "library" }).EPHEMERA_DATA_DIR).toBe(
    join(HOME_DIR, "library"),
  );
});
