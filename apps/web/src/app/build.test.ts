import { BUILD_HEADER } from "@ephemera/server/build";
import { afterEach, describe, expect, it, vi } from "vitest";
import { behindServer, noteBuild } from "./build.ts";

const answer = (build?: string) =>
  new Response(null, {
    status: 204,
    headers: build === undefined ? {} : { [BUILD_HEADER]: build },
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the tab's build against the server's", () => {
  it("is behind once a response names another build, and stays so", () => {
    vi.stubEnv("EPHEMERA_BUILD", "952d2f7");
    noteBuild(answer());
    noteBuild(answer("952d2f7"));
    expect(behindServer()).toBe(false);
    noteBuild(answer("a1b2c3d"));
    expect(behindServer()).toBe(true);
    noteBuild(answer("952d2f7"));
    noteBuild(answer());
    expect(behindServer()).toBe(true);
  });
});
