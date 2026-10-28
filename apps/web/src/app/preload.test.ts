import type { AnyRouter } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preloadChunks } from "./preload.ts";

const routesById = { __root__: {}, "/": {}, "/characters": {} };

function fakeRouter() {
  const loadRouteChunk = vi.fn(async () => undefined);
  return { router: { routesById, loadRouteChunk } as unknown as AnyRouter, loadRouteChunk };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preloading every chunk after the first paint", () => {
  it("waits for idle time where the browser reports it", () => {
    let idle: () => void = () => {};
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idle = callback;
    });
    const { router, loadRouteChunk } = fakeRouter();
    preloadChunks(router);
    expect(loadRouteChunk).not.toHaveBeenCalled();
    idle();
    expect(loadRouteChunk).toHaveBeenCalledTimes(Object.keys(routesById).length);
  });
});
