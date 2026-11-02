import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "./graph.ts";
import {
  applySlots,
  type WorkflowSlots,
  workflowChoicesSchema,
  workflowSlotsSchema,
} from "./slots.ts";

const graph: WorkflowGraph = {
  4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "a lighthouse" } },
  6: { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1536, batch_size: 1 } },
  7: { class_type: "KSampler", inputs: { seed: 42, steps: 8, positive: ["4", 0] } },
  9: { class_type: "SaveImageWebsocket", inputs: { images: ["8", 0] } },
};

const slots: WorkflowSlots = {
  prompt: [{ node: "4", input: "text" }],
  seed: [{ node: "7", input: "seed" }],
  width: [{ node: "6", input: "width" }],
  height: [{ node: "6", input: "height" }],
  count: [{ node: "6", input: "batch_size" }],
  output: "9",
};

describe("workflowSlotsSchema and workflowChoicesSchema", () => {
  it("accept a mapping and refuse nine prompt targets", () => {
    expect(workflowSlotsSchema.parse(slots)).toEqual(slots);
    const nine = Array.from({ length: 9 }, (_, i) => ({ node: String(i), input: "text" }));
    expect(workflowSlotsSchema.safeParse({ ...slots, prompt: nine }).success).toBe(false);
    expect(workflowSlotsSchema.safeParse({ ...slots, seed: [] }).success).toBe(false);
  });

  it("take node ids only, every field optional", () => {
    expect(workflowChoicesSchema.parse({})).toEqual({});
    expect(workflowChoicesSchema.safeParse({ output: "9", prompt: ["4", "5"] }).success).toBe(true);
    expect(workflowChoicesSchema.safeParse({ prompt: [] }).success).toBe(false);
    expect(workflowChoicesSchema.safeParse({ seed: ["7"] }).success).toBe(false);
  });
});

describe("applySlots", () => {
  it("writes the five whole-string placeholders and leaves the input graph alone", () => {
    const result = applySlots(graph, slots);
    expect(result).toEqual({
      ok: true,
      graph: {
        ...graph,
        4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "{{prompt}}" } },
        6: {
          class_type: "EmptySD3LatentImage",
          inputs: { width: "{{width}}", height: "{{height}}", batch_size: "{{count}}" },
        },
        7: { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: 8, positive: ["4", 0] } },
      },
    });
    expect(graph["4"]?.inputs.text).toBe("a lighthouse");
  });

  it("refuses embedded_placeholder for any other placeholder text, naming the node", () => {
    const negative: WorkflowGraph = {
      ...graph,
      5: { class_type: "CLIPTextEncode", inputs: { text: "blurry, {{char}}" } },
    };
    expect(applySlots(negative, slots)).toEqual({
      ok: false,
      refusal: { error: "embedded_placeholder", nodes: ["5"] },
    });
    const nested: WorkflowGraph = {
      ...graph,
      5: { class_type: "LoraStack", inputs: { loras: [{ name: "{{seed}}" }] } },
    };
    expect(applySlots(nested, slots)).toMatchObject({ ok: false });
    const stray: WorkflowGraph = {
      ...graph,
      5: { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } },
    };
    expect(applySlots(stray, slots)).toMatchObject({ ok: false });
  });

  it("throws on a target the graph does not have", () => {
    expect(() => applySlots(graph, { ...slots, output: "99" })).toThrow();
    expect(() =>
      applySlots(graph, { ...slots, seed: [{ node: "7", input: "noise_seed" }] }),
    ).toThrow();
  });
});
