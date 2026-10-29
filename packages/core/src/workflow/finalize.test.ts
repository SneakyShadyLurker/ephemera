import { describe, expect, it } from "vitest";
import bundled from "../../../../apps/server/src/comfyui/workflows/krea2-gonzalomo.json" with {
  type: "json",
};
import { type Candidate, type Detection, finalizeWorkflow, type Normalized } from "./finalize.ts";
import type { WorkflowGraph } from "./graph.ts";

const TEMPLATE: WorkflowGraph = bundled;

/** The bundled template with its placeholders replaced by values a user's export would carry. */
function literal(): WorkflowGraph {
  const graph = structuredClone(TEMPLATE);
  Object.assign(graph["4"]?.inputs ?? {}, { text: "a lighthouse at dusk, oil on canvas" });
  Object.assign(graph["6"]?.inputs ?? {}, { width: 1024, height: 1536, batch_size: 1 });
  Object.assign(graph["7"]?.inputs ?? {}, { seed: 1234567 });
  return graph;
}

const candidate = (node: string, classType: string, inputs: string[]): Candidate => ({
  node,
  title: classType,
  classType,
  inputs,
});

/** What detection finds in the bundled graph: one encoder, one latent, one sampler, one saver. */
function detection(overrides: Partial<Detection> = {}): Detection {
  return {
    prompt: {
      chosen: [{ node: "4", input: "text" }],
      candidates: [candidate("4", "CLIPTextEncode", ["text"])],
    },
    latent: { chosen: "6", candidates: [candidate("6", "EmptySD3LatentImage", ["width"])] },
    seed: [{ node: "7", input: "seed" }],
    output: { chosen: "9", candidates: [candidate("9", "SaveImageWebsocket", ["images"])] },
    familyGuess: "krea2",
    ...overrides,
  };
}

const normalized = (graph: WorkflowGraph): Normalized => ({ graph, changed: [], skipped: [] });

describe("finalizeWorkflow on the bundled graph", () => {
  it("finds a free id for the ImageScale when a node id is past the safe integers", () => {
    const graph = literal();
    const huge = "10000000000000000";
    const save = graph["9"];
    if (save === undefined) throw new Error("the bundled graph has no node 9");
    delete graph["9"];
    graph[huge] = save;
    const result = finalizeWorkflow(
      normalized(graph),
      detection({
        output: { chosen: huge, candidates: [candidate(huge, "SaveImageWebsocket", ["images"])] },
      }),
      {},
    );
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.template[huge]?.inputs.images).toEqual(["9", 0]);
    expect(result.template["9"]?.class_type).toBe("ImageScale");
  });

  it("reproduces the bundled template, with the exact-size ImageScale inserted before the save", () => {
    const result = finalizeWorkflow(normalized(literal()), detection(), {});
    if (!result.ok) throw new Error(result.refusal.error);
    const { 11: scale, ...rest } = result.template;
    expect(scale).toEqual({
      class_type: "ImageScale",
      inputs: {
        image: ["8", 0],
        upscale_method: "lanczos",
        width: "{{width}}",
        height: "{{height}}",
        crop: "disabled",
      },
    });
    expect(rest["9"]?.inputs.images).toEqual(["11", 0]);
    Object.assign(rest["9"]?.inputs ?? {}, { images: ["8", 0] });
    expect(JSON.stringify(rest)).toBe(JSON.stringify(TEMPLATE));
    expect(result.slots).toEqual({
      prompt: [{ node: "4", input: "text" }],
      seed: [{ node: "7", input: "seed" }],
      width: [
        { node: "6", input: "width" },
        { node: "11", input: "width" },
      ],
      height: [
        { node: "6", input: "height" },
        { node: "11", input: "height" },
      ],
      count: [{ node: "6", input: "batch_size" }],
      output: "9",
    });
    expect(result.changed).toEqual([
      "Resized to the requested size before saving, so the picture arrives at 1024 x 1536.",
      "The written prompt of CLIPTextEncode (node 4), 35 characters, is replaced by the card's image prompt.",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("reproduces it byte for byte when a matching ImageScale already feeds the save", () => {
    const withScale = (width: unknown, height: unknown): WorkflowGraph => {
      const graph = literal();
      graph["11"] = {
        class_type: "ImageScale",
        inputs: { image: ["8", 0], upscale_method: "lanczos", width, height, crop: "disabled" },
      };
      Object.assign(graph["9"]?.inputs ?? {}, { images: ["11", 0] });
      return graph;
    };
    const expected = withScale("{{width}}", "{{height}}");
    Object.assign(expected["4"]?.inputs ?? {}, { text: "{{prompt}}" });
    Object.assign(expected["6"]?.inputs ?? {}, {
      width: "{{width}}",
      height: "{{height}}",
      batch_size: "{{count}}",
    });
    Object.assign(expected["7"]?.inputs ?? {}, { seed: "{{seed}}" });
    for (const [width, height] of [
      [1024, 1536],
      ["{{width}}", "{{height}}"],
    ]) {
      const result = finalizeWorkflow(normalized(withScale(width, height)), detection(), {});
      if (!result.ok) throw new Error(result.refusal.error);
      expect(JSON.stringify(result.template)).toBe(JSON.stringify(expected));
      expect(result.changed).not.toContain(
        "Resized to the requested size before saving, so the picture arrives at 1024 x 1536.",
      );
    }
  });

  it("inserts an ImageScale when the last image node scales to another size", () => {
    const graph = literal();
    graph["11"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["8", 0],
        upscale_method: "lanczos",
        width: 512,
        height: 1536,
        crop: "disabled",
      },
    };
    Object.assign(graph["9"]?.inputs ?? {}, { images: ["11", 0] });
    const result = finalizeWorkflow(normalized(graph), detection(), {});
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.template["12"]).toMatchObject({
      class_type: "ImageScale",
      inputs: { image: ["11", 0], width: "{{width}}" },
    });
    expect(result.template["9"]?.inputs.images).toEqual(["12", 0]);
    expect(result.template["11"]?.inputs.width).toBe(512);
  });

  it("passes normalization's report lines through ahead of its own", () => {
    const result = finalizeWorkflow(
      { graph: literal(), changed: ["fixed"], skipped: ["dropped"] },
      detection(),
      {},
    );
    expect(result).toMatchObject({ ok: true, skipped: ["dropped"] });
    if (result.ok) expect(result.changed[0]).toBe("fixed");
  });
});

describe("finalizeWorkflow refusals", () => {
  it("refuses no_size_slot when the output's walk does not reach the latent", () => {
    const graph = literal();
    graph["12"] = { class_type: "LoadImage", inputs: { image: "photo.png" } };
    Object.assign(graph["9"]?.inputs ?? {}, { images: ["12", 0] });
    expect(finalizeWorkflow(normalized(graph), detection(), {})).toEqual({
      ok: false,
      refusal: { error: "no_size_slot" },
    });
    const none = detection({ latent: { chosen: null, candidates: [] } });
    expect(finalizeWorkflow(normalized(literal()), none, {})).toMatchObject({
      refusal: { error: "no_size_slot" },
    });
  });

  it("refuses no_output when nothing is chosen", () => {
    const none = detection({ output: { chosen: null, candidates: [] } });
    expect(finalizeWorkflow(normalized(literal()), none, {})).toMatchObject({
      refusal: { error: "no_output" },
    });
  });

  it("refuses nine prompt targets and nine seeds with too_many_targets", () => {
    const graph = literal();
    const nine = Array.from({ length: 9 }, (_, i) => String(20 + i));
    for (const id of nine) graph[id] = { class_type: "CLIPTextEncode", inputs: { text: "x" } };
    const prompts = detection({
      prompt: {
        chosen: null,
        candidates: nine.map((node) => candidate(node, "CLIPTextEncode", ["text"])),
      },
    });
    expect(finalizeWorkflow(normalized(graph), prompts, { prompt: nine })).toMatchObject({
      refusal: { error: "too_many_targets" },
    });
    const flux = Array.from({ length: 5 }, (_, i) => String(30 + i));
    for (const id of flux)
      graph[id] = { class_type: "CLIPTextEncodeFlux", inputs: { clip_l: "", t5xxl: "" } };
    const chosenFlux = detection({
      prompt: {
        chosen: null,
        candidates: flux.map((node) => candidate(node, "CLIPTextEncodeFlux", ["clip_l", "t5xxl"])),
      },
    });
    expect(finalizeWorkflow(normalized(graph), chosenFlux, { prompt: flux })).toMatchObject({
      refusal: { error: "too_many_targets" },
    });
    for (const id of nine) graph[id] = { class_type: "KSampler", inputs: { seed: 1 } };
    const seeds = detection({ seed: nine.map((node) => ({ node, input: "seed" })) });
    expect(finalizeWorkflow(normalized(graph), seeds, {})).toMatchObject({
      refusal: { error: "too_many_targets" },
    });
  });

  it("refuses a chosen node that is not a candidate, naming it", () => {
    const graph = literal();
    expect(finalizeWorkflow(normalized(graph), detection(), { prompt: ["7"] })).toEqual({
      ok: false,
      refusal: { error: "not_a_candidate", nodes: ["7"] },
    });
    expect(finalizeWorkflow(normalized(graph), detection(), { output: "8" })).toMatchObject({
      refusal: { error: "not_a_candidate", nodes: ["8"] },
    });
    expect(finalizeWorkflow(normalized(graph), detection(), { latent: "7" })).toMatchObject({
      refusal: { error: "not_a_candidate", nodes: ["7"] },
    });
  });

  it("refuses no_seed_slot without a seed and embedded_placeholder for a stray one", () => {
    expect(finalizeWorkflow(normalized(literal()), detection({ seed: [] }), {})).toMatchObject({
      refusal: { error: "no_seed_slot" },
    });
    const graph = literal();
    Object.assign(graph["7"]?.inputs ?? {}, { sampler_name: "{{sampler}}" });
    expect(finalizeWorkflow(normalized(graph), detection(), {})).toEqual({
      ok: false,
      refusal: { error: "embedded_placeholder", nodes: ["7"] },
    });
  });
});

describe("finalizeWorkflow choices", () => {
  /** The bundled graph with a second saver behind its own upscale, the one a user picks between. */
  function twoOutputs(): { graph: WorkflowGraph; found: Detection } {
    const graph = literal();
    graph["12"] = { class_type: "ImageScaleBy", inputs: { image: ["8", 0], scale_by: 2 } };
    graph["13"] = { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "x" } };
    const found = detection({
      output: {
        chosen: null,
        candidates: [
          candidate("9", "SaveImageWebsocket", ["images"]),
          { ...candidate("13", "SaveImage", ["images"]), title: "Save Upscaled" },
        ],
      },
    });
    return { graph, found };
  }

  it("drops the outputs not chosen and every node only they consumed", () => {
    const { graph, found } = twoOutputs();
    const result = finalizeWorkflow(normalized(graph), found, { output: "9" });
    if (!result.ok) throw new Error(result.refusal.error);
    expect(Object.keys(result.template)).not.toContain("12");
    expect(Object.keys(result.template)).not.toContain("13");
    expect(result.template["8"]).toBeDefined();
    expect(result.skipped).toEqual([
      "Save Upscaled (node 13), not the chosen output.",
      "ImageScaleBy (node 12), only a left-out output used it.",
    ]);
  });

  it("makes a chosen saver of another class send the picture to Ephemera", () => {
    const { graph, found } = twoOutputs();
    const result = finalizeWorkflow(
      normalized(graph),
      found,
      { output: "13" },
      new Map([
        ["ImageScaleBy", { outputNode: false, displayName: "Upscale Image By", inputs: {} }],
      ]),
    );
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.template["13"]?.class_type).toBe("SaveImageWebsocket");
    // A dropped node's id stays unused: the ImageScale takes the next free one.
    expect(result.template["13"]?.inputs.images).toEqual(["11", 0]);
    expect(result.template["11"]?.inputs.image).toEqual(["12", 0]);
    expect(result.template["9"]).toBeUndefined();
    expect(result.slots.output).toBe("13");
    expect(result.changed).toContain(
      "Save Upscaled (node 13) now sends the picture to Ephemera instead of a file.",
    );
    expect(result.skipped).toEqual(["SaveImageWebsocket (node 9), not the chosen output."]);
  });

  it("drops the text node a linked prompt comes from, so its text is never stored", () => {
    const graph = literal();
    graph["20"] = { class_type: "PrimitiveStringMultiline", inputs: { value: "SECRET TEXT" } };
    Object.assign(graph["4"]?.inputs ?? {}, { text: ["20", 0] });
    const result = finalizeWorkflow(normalized(graph), detection(), {});
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.template["20"]).toBeUndefined();
    expect(result.template["4"]?.inputs.text).toBe("{{prompt}}");
    expect(JSON.stringify(result.template)).not.toContain("SECRET");
    expect(result.changed).toContain(
      "The prompt CLIPTextEncode (node 4) took from PrimitiveStringMultiline (node 20) is replaced by the card's image prompt.",
    );
    expect(result.skipped).toContain(
      "PrimitiveStringMultiline (node 20), its text is replaced by the card's image prompt.",
    );
  });

  it("refuses linked_prompt when the prompt's node feeds another or takes links itself", () => {
    const shared = literal();
    shared["20"] = { class_type: "PrimitiveStringMultiline", inputs: { value: "SECRET TEXT" } };
    Object.assign(shared["4"]?.inputs ?? {}, { text: ["20", 0] });
    shared["21"] = { class_type: "CLIPTextEncode", inputs: { text: ["20", 0], clip: ["2", 0] } };
    expect(finalizeWorkflow(normalized(shared), detection(), {})).toEqual({
      ok: false,
      refusal: { error: "linked_prompt", nodes: ["20"] },
    });
    const joined = literal();
    joined["20"] = { class_type: "StringConcatenate", inputs: { string_a: ["22", 0] } };
    joined["22"] = { class_type: "PrimitiveStringMultiline", inputs: { value: "SECRET TEXT" } };
    Object.assign(joined["4"]?.inputs ?? {}, { text: ["20", 0] });
    expect(finalizeWorkflow(normalized(joined), detection(), {})).toEqual({
      ok: false,
      refusal: { error: "linked_prompt", nodes: ["20"] },
    });
  });

  it("takes the prompt and latent from the chosen output's branch, not every output's", () => {
    const graph = literal();
    graph["20"] = { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "grainy" } };
    Object.assign(graph["7"]?.inputs ?? {}, { negative: ["20", 0] });
    graph["21"] = {
      class_type: "KSampler",
      inputs: { ...graph["7"]?.inputs, positive: ["20", 0], negative: ["4", 0] },
    };
    graph["22"] = { class_type: "VAEDecode", inputs: { samples: ["21", 0], vae: ["3", 0] } };
    graph["23"] = { class_type: "SaveImageWebsocket", inputs: { images: ["22", 0] } };
    const found = detection({
      prompt: {
        chosen: [
          { node: "4", input: "text" },
          { node: "20", input: "text" },
        ],
        candidates: [
          candidate("4", "CLIPTextEncode", ["text"]),
          candidate("20", "CLIPTextEncode", ["text"]),
        ],
      },
      seed: [
        { node: "7", input: "seed" },
        { node: "21", input: "seed" },
      ],
      output: {
        chosen: null,
        candidates: [
          candidate("9", "SaveImageWebsocket", ["images"]),
          candidate("23", "SaveImageWebsocket", ["images"]),
        ],
      },
    });
    const result = finalizeWorkflow(normalized(graph), found, { output: "9" });
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.slots.prompt).toEqual([{ node: "4", input: "text" }]);
    expect(result.template["20"]?.inputs.text).toBe("grainy");
    expect(result.template["21"]).toBeUndefined();
    expect(result.slots.count).toEqual([{ node: "6", input: "batch_size" }]);
  });

  it("writes the prompt into every text input of the chosen encoders", () => {
    const graph = literal();
    graph["20"] = { class_type: "CLIPTextEncodeFlux", inputs: { clip_l: "", t5xxl: "a cat" } };
    const found = detection({
      prompt: {
        chosen: null,
        candidates: [
          candidate("4", "CLIPTextEncode", ["text"]),
          candidate("20", "CLIPTextEncodeFlux", ["clip_l", "t5xxl"]),
        ],
      },
    });
    const result = finalizeWorkflow(normalized(graph), found, { prompt: ["20", "4"] });
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.slots.prompt).toEqual([
      { node: "20", input: "clip_l" },
      { node: "20", input: "t5xxl" },
      { node: "4", input: "text" },
    ]);
    expect(result.template["20"]?.inputs).toEqual({ clip_l: "{{prompt}}", t5xxl: "{{prompt}}" });
    expect(finalizeWorkflow(normalized(graph), found, {})).toMatchObject({
      refusal: { error: "no_prompt_slot" },
    });
  });
});
