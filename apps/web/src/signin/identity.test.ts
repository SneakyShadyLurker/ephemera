import { describe, expect, it, vi } from "vitest";
import { createIdentity } from "./identity.ts";

describe("the tab's identity", () => {
  it("reads the username once, and again only after a reset", () => {
    const read = vi.fn(() => "alice");
    const identity = createIdentity(read, () => {});
    expect(identity.bound()).toBe("alice");
    expect(identity.bound()).toBe("alice");
    expect(read).toHaveBeenCalledOnce();
    read.mockReturnValue("bob");
    identity.reset();
    expect(identity.bound()).toBe("bob");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a change drops every owner's state before leaving, once", () => {
    const steps: string[] = [];
    const identity = createIdentity(
      () => "alice",
      () => steps.push("leave"),
    );
    identity.onChanged(() => steps.push("drop"));
    identity.changed();
    identity.changed();
    expect(steps).toEqual(["drop", "leave"]);
    expect(identity.hasChanged()).toBe(true);
  });

  it("unload guards stop asking once the identity changed", () => {
    const identity = createIdentity(
      () => "alice",
      () => {},
    );
    const guarded = identity.guard(() => true);
    expect(guarded()).toBe(true);
    identity.changed();
    expect(guarded()).toBe(false);
  });
});
