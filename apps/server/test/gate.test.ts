import { describe, expect, it } from "vitest";
import { createGate } from "../src/gate.ts";

const never = new AbortController().signal;

describe("a gate", () => {
  it("lets its limit in at once and the rest in arrival order as turns end", async () => {
    const gate = createGate(2);
    const first = await gate.enter(never);
    const second = await gate.enter(never);
    const order: string[] = [];
    const third = gate.enter(never).then((release) => {
      order.push("third");
      return release;
    });
    const fourth = gate.enter(never).then((release) => {
      order.push("fourth");
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first?.();
    expect(await third).toBeTypeOf("function");
    expect(order).toEqual(["third"]);
    second?.();
    (await fourth)?.();
    (await third)?.();
    expect(order).toEqual(["third", "fourth"]);
    // Every turn ended: two more enter at once.
    expect(await gate.enter(never)).toBeTypeOf("function");
    expect(await gate.enter(never)).toBeTypeOf("function");
  });

  it("drops a waiter that gave up, without spending a turn on it", async () => {
    const gate = createGate(1);
    const held = await gate.enter(never);
    const gone = new AbortController();
    const left = gate.enter(gone.signal);
    const next = gate.enter(never);
    gone.abort();
    expect(await left).toBeUndefined();
    held?.();
    const release = await next;
    expect(release).toBeTypeOf("function");
    release?.();
    expect(await gate.enter(gone.signal)).toBeUndefined();
    expect(await gate.enter(never)).toBeTypeOf("function");
  });
});
