import { describe, expect, it } from "vitest";
import {
  apiGraphSchema,
  classTypeSchema,
  inputNameSchema,
  inputValueSchema,
  nodeIdSchema,
  stripEphemeraKey,
  WORKFLOW_LIMITS,
  walkDepth,
} from "./graph.ts";

const node = (inputs: Record<string, unknown> = {}) => ({ class_type: "KSampler", inputs });
const FORBIDDEN = ["__proto__", "constructor", "prototype"];

/** A graph as JSON.parse builds it, so `__proto__` is an own key and not the prototype. */
const parsed = (json: string): unknown => JSON.parse(json);

describe("node ids, input names and class types", () => {
  it("accept ComfyUI's ids, including flattened subgraph ids", () => {
    for (const id of ["1", "12:3", "a.b-c_d"])
      expect(nodeIdSchema.safeParse(id).success).toBe(true);
    expect(inputNameSchema.safeParse("noise_seed").success).toBe(true);
    expect(classTypeSchema.safeParse("CLIPTextEncode").success).toBe(true);
  });

  it("refuse a 65-character node id, empty names and other characters", () => {
    expect(nodeIdSchema.safeParse("1".repeat(64)).success).toBe(true);
    expect(nodeIdSchema.safeParse("1".repeat(65)).success).toBe(false);
    expect(nodeIdSchema.safeParse("").success).toBe(false);
    expect(inputNameSchema.safeParse("a b").success).toBe(false);
    expect(classTypeSchema.safeParse("A".repeat(129)).success).toBe(false);
  });

  it.each(FORBIDDEN)("refuse %s as a node id", (key) => {
    expect(nodeIdSchema.safeParse(key).success).toBe(false);
    expect(apiGraphSchema.safeParse(parsed(`{"${key}": ${JSON.stringify(node())}}`)).success).toBe(
      false,
    );
  });

  it.each(FORBIDDEN)("refuse %s as an input name", (key) => {
    expect(inputNameSchema.safeParse(key).success).toBe(false);
    const graph = parsed(`{"1": {"class_type": "KSampler", "inputs": {"${key}": 1}}}`);
    expect(apiGraphSchema.safeParse(graph).success).toBe(false);
  });

  it.each(FORBIDDEN)("refuse %s as a key of a nested object", (key) => {
    expect(inputValueSchema.safeParse(parsed(`{"${key}": 1}`)).success).toBe(false);
    expect(inputValueSchema.safeParse(parsed(`[{"a": {"${key}": "x"}}]`)).success).toBe(false);
    const graph = parsed(`{"1": {"class_type": "K", "inputs": {"loras": {"${key}": {}}}}}`);
    expect(apiGraphSchema.safeParse(graph).success).toBe(false);
  });
});

describe("input values", () => {
  it("accept literals, links and nested values", () => {
    for (const value of ["text", 1.5, true, null, ["4", 0], { on: true, strength: [1, 2] }]) {
      expect(inputValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it("refuse a 17 KiB string and an over-long array", () => {
    expect(inputValueSchema.safeParse("x".repeat(WORKFLOW_LIMITS.stringLength)).success).toBe(true);
    expect(inputValueSchema.safeParse("x".repeat(17 * 1024)).success).toBe(false);
    expect(inputValueSchema.safeParse(["x".repeat(17 * 1024)]).success).toBe(false);
    expect(inputValueSchema.safeParse(Array(WORKFLOW_LIMITS.arrayLength + 1).fill(0)).success).toBe(
      false,
    );
    expect(inputValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

describe("apiGraphSchema", () => {
  const graphOf = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), node()]));

  it("accepts up to 200 nodes and refuses more, or none", () => {
    expect(apiGraphSchema.safeParse(graphOf(WORKFLOW_LIMITS.nodes)).success).toBe(true);
    expect(apiGraphSchema.safeParse(graphOf(WORKFLOW_LIMITS.nodes + 1)).success).toBe(false);
    expect(apiGraphSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a node over the input limit and unknown node keys", () => {
    const inputs = Object.fromEntries(
      Array.from({ length: WORKFLOW_LIMITS.inputsPerNode + 1 }, (_, i) => [`i${i}`, 0]),
    );
    expect(apiGraphSchema.safeParse({ 1: node(inputs) }).success).toBe(false);
    expect(apiGraphSchema.safeParse({ 1: { ...node(), _meta: { title: "x" } } }).success).toBe(
      false,
    );
  });

  it("refuses a 17 KiB string input", () => {
    expect(apiGraphSchema.safeParse({ 1: node({ text: "x".repeat(17 * 1024) }) }).success).toBe(
      false,
    );
  });
});

describe("walkDepth", () => {
  const nested = (depth: number): unknown => {
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = i % 2 === 0 ? { a: value } : [value];
    return value;
  };

  it("passes values within the limit and refuses one level more", () => {
    expect(walkDepth(1, 0)).toBe(true);
    expect(walkDepth(nested(WORKFLOW_LIMITS.jsonDepth), WORKFLOW_LIMITS.jsonDepth)).toBe(true);
    expect(walkDepth(nested(WORKFLOW_LIMITS.jsonDepth + 1), WORKFLOW_LIMITS.jsonDepth)).toBe(false);
  });

  it("stops on a very deep value without exhausting the stack", () => {
    expect(walkDepth(nested(200_000), WORKFLOW_LIMITS.jsonDepth)).toBe(false);
  });
});

describe("stripEphemeraKey", () => {
  const graph = { 1: node() };

  it("returns the graph without the reserved key and its declaration", () => {
    expect(
      stripEphemeraKey({ ephemera: { family: "general", name: "Flux Dev" }, ...graph }),
    ).toEqual({ graph, meta: { family: "general", name: "Flux Dev" } });
    expect(stripEphemeraKey({ ephemera: {}, ...graph })).toEqual({ graph, meta: {} });
  });

  it("passes a graph without the key unchanged", () => {
    expect(stripEphemeraKey(graph)).toEqual({ graph, meta: {} });
    expect(stripEphemeraKey("text")).toEqual({ graph: "text", meta: {} });
  });

  it("refuses an invalid declaration", () => {
    for (const ephemera of [
      { family: "flux" },
      { name: "" },
      { name: "x".repeat(WORKFLOW_LIMITS.nameLength + 1) },
      { name: "a\u0007b" },
      { family: "moss", extra: true },
      "general",
    ]) {
      expect(() => stripEphemeraKey({ ephemera, ...graph })).toThrow();
    }
  });
});
