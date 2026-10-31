import { expect, it } from "vitest";
import { runEnv, STATIC_DIR } from "./service.ts";

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
