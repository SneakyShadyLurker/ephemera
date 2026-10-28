import { describe, expect, it } from "vitest";
import type { ArtPhase } from "./art-slice.ts";
import { artProgress } from "./progress.ts";

const running = (
  phase: ArtPhase,
  value: number,
  max: number,
  noun: "portraits" | "picture" = "portraits",
) => artProgress({ status: "running", phase, value, max, started: 0, heard: 0 }, noun);

describe("art progress", () => {
  it("says nothing once no portraits are on their way", () => {
    expect(artProgress(null)).toBeNull();
    expect(artProgress({ status: "complete" })).toBeNull();
    expect(artProgress({ status: "stopped" })).toBeNull();
  });

  it("moves from the model to ComfyUI once the image prompt is written", () => {
    expect(running("prompt", 0, 1)?.quiet?.text).toBe("Still waiting for the model.");
    expect(running("prompt", 1, 1)).toMatchObject({
      label: "Sending it to ComfyUI",
      quiet: { text: "ComfyUI is slow to answer." },
    });
  });

  it("measures sampling by its steps, then finishes and receives without the line starting over", () => {
    expect(running("running", 12, 30)).toMatchObject({ detail: "Step 12 of 30", line: 0.4 });
    expect(running("running", 30, 30)).toMatchObject({
      label: "Finishing the portraits",
      line: "pending",
    });
    expect(running("receiving", 1, 4)).toMatchObject({ detail: "1 of 4", line: 1 });
  });

  it("names the portraits or a scene's one picture, counted as they arrive", () => {
    expect(running("running", 3, 8)).toMatchObject({ label: "Developing the portraits" });
    expect(running("running", 3, 8, "picture")).toMatchObject({
      label: "Developing the picture",
      detail: "Step 3 of 8",
      line: 3 / 8,
    });
    expect(running("running", 8, 8, "picture")).toMatchObject({
      label: "Finishing the picture",
      quiet: { text: "The picture is still on its way." },
    });
    expect(running("receiving", 2, 4)).toEqual({
      label: "Receiving the portraits",
      detail: "2 of 4",
      line: 1,
      quiet: { text: "The portraits are still on their way.", after: 20_000 },
    });
    expect(running("receiving", 1, 1, "picture")).toEqual({
      label: "Receiving the picture",
      detail: "1 of 1",
      line: 1,
      quiet: { text: "The picture is still on its way.", after: 20_000 },
    });
    expect(running("queued", 0, 1, "picture")?.label).toBe("Waiting in ComfyUI's queue");
  });

  it("says a busy ComfyUI's waiting-list place when the worker gives one", () => {
    const busy = (position?: number) =>
      artProgress({
        status: "running",
        phase: "busy",
        value: 0,
        max: 1,
        ...(position === undefined ? {} : { position }),
        started: 0,
        heard: 0,
      });
    expect(busy(1)).toEqual({
      label: "ComfyUI is busy with another job",
      detail: "Next in line",
      line: "pending",
      quiet: { text: "Still waiting for ComfyUI to free up.", after: 60_000 },
    });
    expect(busy(3)?.detail).toBe("Number 3 in line");
    expect(busy()).toEqual({
      label: "ComfyUI is busy with another job",
      line: "pending",
      quiet: { text: "Still waiting for ComfyUI to free up.", after: 60_000 },
    });
  });

  it("waits for ComfyUI while it starts up", () => {
    expect(running("starting", 0, 1, "picture")).toEqual({
      label: "ComfyUI is starting up",
      line: "pending",
      quiet: { text: "ComfyUI is taking a while to start.", after: 30_000 },
    });
  });

  it.each(["portraits", "picture"] as const)(
    "labels %s decoding and sending without sampler steps",
    (noun) => {
      for (const phase of ["decoding", "sending"] as const) {
        const progress = running(phase, 3, 4, noun);
        expect(progress?.label).toBe(
          `${phase === "decoding" ? "Decoding" : "Sending"} the ${noun}`,
        );
        expect(progress?.detail).toBeUndefined();
        expect(progress?.line).toBe("pending");
      }
    },
  );
});
