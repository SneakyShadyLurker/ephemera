import { afterEach, describe, expect, it } from "vitest";
import { setSessionOpen, uiStore } from "@/app/ui.ts";
import { openInspector } from "./open-inspector.ts";

afterEach(() => {
  uiStore.setState({ inspectorOpen: false, inspectorUnavailable: false, sessionOpen: false });
});

describe("opening the inspector", () => {
  it("opens once its code is here", async () => {
    await openInspector(async () => undefined);
    expect(uiStore.getState().inspectorOpen).toBe(true);
  });

  it("opens nothing when the owner moved on while it loaded", async () => {
    let arrive: () => void = () => {};
    const opening = openInspector(() => new Promise<void>((resolve) => (arrive = resolve)));
    setSessionOpen(true);
    arrive();
    await opening;
    expect(uiStore.getState().inspectorOpen).toBe(false);
  });

  it("code that cannot load marks it unavailable and leaves it closed", async () => {
    await openInspector(async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    expect(uiStore.getState()).toMatchObject({ inspectorOpen: false, inspectorUnavailable: true });
    await openInspector(async () => undefined);
    expect(uiStore.getState().inspectorOpen).toBe(false);
  });
});
