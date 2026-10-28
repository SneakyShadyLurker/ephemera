import { describe, expect, it } from "vitest";
import { type Level, meterStage } from "./meter-stage.ts";

const WINDOW = 100_000;
const at = (share: number, trimmed = 0): Level => ({
  estimate: share * WINDOW,
  window: WINDOW,
  reserve: 1_000,
  trimmed,
});

describe("meterStage", () => {
  it("stays quiet below three quarters of the window", () => {
    expect(meterStage(at(0), "quiet")).toBe("quiet");
    expect(meterStage(at(0.74), "quiet")).toBe("quiet");
  });

  it("shows the level from three quarters of the window", () => {
    expect(meterStage(at(0.75), "quiet")).toBe("near");
    expect(meterStage(at(0.9), "quiet")).toBe("near");
  });

  it("keeps the level until the share drops below 70 percent", () => {
    expect(meterStage(at(0.74), "near")).toBe("near");
    expect(meterStage(at(0.7), "near")).toBe("near");
    expect(meterStage(at(0.69), "near")).toBe("quiet");
    expect(meterStage(at(0.72), "full")).toBe("near");
  });

  it("is full once history is left out, whatever the estimate", () => {
    expect(meterStage(at(0.1, 1), "quiet")).toBe("full");
    expect(meterStage(at(0.8, 3), "near")).toBe("full");
  });
});
