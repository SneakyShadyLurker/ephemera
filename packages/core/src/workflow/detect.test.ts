import { describe, expect, it } from "vitest";
import bundled from "../../../../apps/server/src/comfyui/workflows/krea2-gonzalomo.json" with {
  type: "json",
};
import { detectWorkflow } from "./detect.ts";
import { type Detection, finalizeWorkflow, type Normalized } from "./finalize.ts";
import type { WorkflowGraph } from "./graph.ts";
import type { NodeMeta, NodeMetaMap } from "./meta.ts";
import { normalizeWorkflow } from "./normalize.ts";

const isOutputClass = (classType: string) => classType === "SaveImageWebsocket";
const isRefused = (classType: string) =>
  classType !== "SaveImageWebsocket" && /^(Save|Preview)|Save$/.test(classType);

const metaOf = (entries: Record<string, Partial<NodeMeta>>): NodeMetaMap =>
  new Map(
    Object.entries(entries).map(([classType, meta]) => [
      classType,
      { outputNode: false, inputs: {}, ...meta },
    ]),
  );

/** Normalized, then detected; a refusal throws. */
function detect(
  graph: WorkflowGraph,
  meta?: NodeMetaMap,
): { normalized: Normalized; detection: Detection } {
  const normalized = normalizeWorkflow(graph, meta, isOutputClass, isRefused);
  const result = detectWorkflow(normalized, meta);
  if (!result.ok) throw new Error(result.refusal.error);
  return { normalized, detection: result.detection };
}

/** The node feeding a save's `images`. */
function feederOf(graph: WorkflowGraph, save: string): string {
  const images = graph[save]?.inputs.images;
  if (!Array.isArray(images) || typeof images[0] !== "string") throw new Error("no images link");
  return images[0];
}

const refusalOf = (graph: WorkflowGraph, meta?: NodeMetaMap) => {
  const result = detectWorkflow(normalizeWorkflow(graph, meta, isOutputClass, isRefused), meta);
  return result.ok ? undefined : result.refusal.error;
};

/** The bundled graph as a user's export carries it: literal values, no placeholders. */
function krea(): WorkflowGraph {
  const graph: WorkflowGraph = structuredClone(bundled);
  Object.assign(graph["4"]?.inputs ?? {}, { text: "a lighthouse at dusk, oil on canvas" });
  Object.assign(graph["6"]?.inputs ?? {}, { width: 1024, height: 1536, batch_size: 1 });
  Object.assign(graph["7"]?.inputs ?? {}, { seed: 1234567 });
  return graph;
}

/** An SDXL export: one checkpoint, a positive and a longer negative encoder, a saver and a preview. */
function sdxl(): WorkflowGraph {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
        seed: 42,
        steps: 25,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "a cat" } },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["4", 1], text: "blurry, low quality, watermark" },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "ComfyUI" } },
    "12": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
  };
}

/** SDXL with a second, hires pass sampling the upscaled latent again. */
function hires(): WorkflowGraph {
  const graph = sdxl();
  graph["10"] = {
    class_type: "LatentUpscaleBy",
    inputs: { samples: ["3", 0], upscale_method: "nearest-exact", scale_by: 1.5 },
  };
  graph["11"] = {
    class_type: "KSampler",
    inputs: { ...graph["3"]?.inputs, latent_image: ["10", 0], seed: 43, denoise: 0.5 },
  };
  Object.assign(graph["8"]?.inputs ?? {}, { samples: ["11", 0] });
  return graph;
}

/** A Flux dev graph: custom sampling, guidance between the encoder and the guider. */
function flux(): WorkflowGraph {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
    },
    "2": {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: "t5xxl_fp16.safetensors",
        clip_name2: "clip_l.safetensors",
        type: "flux",
      },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "a fox in snow" } },
    "26": { class_type: "FluxGuidance", inputs: { conditioning: ["6", 0], guidance: 3.5 } },
    "22": { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["26", 0] } },
    "25": { class_type: "RandomNoise", inputs: { noise_seed: 7 } },
    "16": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "17": {
      class_type: "BasicScheduler",
      inputs: { model: ["1", 0], scheduler: "simple", steps: 20, denoise: 1 },
    },
    "27": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    "13": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["25", 0],
        guider: ["22", 0],
        sampler: ["16", 0],
        sigmas: ["17", 0],
        latent_image: ["27", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "flux" } },
  };
}

describe("detectWorkflow on the bundled graph", () => {
  it("detects every place with no choice needed and no changes", () => {
    const { normalized, detection } = detect(krea());
    expect(normalized.changed).toEqual([]);
    expect(normalized.skipped).toEqual([]);
    expect(detection.output.chosen).toBe("9");
    expect(detection.latent.chosen).toBe("6");
    expect(detection.prompt.chosen).toEqual([{ node: "4", input: "text" }]);
    expect(detection.seed).toEqual([{ node: "7", input: "seed" }]);
    expect(detection.familyGuess).toBe("krea2");
  });

  it("finalizes with only the ImageScale added", () => {
    const { normalized, detection } = detect(krea());
    const result = finalizeWorkflow(normalized, detection, {});
    if (!result.ok) throw new Error(result.refusal.error);
    const { 11: scale, ...rest } = result.template;
    expect(scale?.class_type).toBe("ImageScale");
    expect(rest).toEqual({
      ...bundled,
      9: { class_type: "SaveImageWebsocket", inputs: { images: ["11", 0] } },
    });
    expect(result.skipped).toEqual([]);
  });
});

describe("detectWorkflow on an SDXL graph", () => {
  it("swaps the saver, drops the preview and chooses the positive encoder by trace", () => {
    const { normalized, detection } = detect(sdxl());
    expect(normalized.graph["9"]?.class_type).toBe("SaveImageWebsocket");
    expect(normalized.graph["12"]).toBeUndefined();
    expect(detection.output).toEqual({
      chosen: "9",
      candidates: [
        {
          node: "9",
          title: "SaveImageWebsocket",
          classType: "SaveImageWebsocket",
          inputs: ["images"],
        },
      ],
    });
    expect(detection.prompt.chosen).toEqual([{ node: "6", input: "text" }]);
    expect(detection.prompt.candidates.map((candidate) => candidate.node)).toEqual(["7", "6"]);
    expect(detection.latent.chosen).toBe("5");
    expect(detection.familyGuess).toBe("general");
  });

  it("finds seed and noise_seed and swaps SaveImage without meta", () => {
    const graph = sdxl();
    const { seed: _seed, ...base } = graph["3"]?.inputs ?? {};
    graph["11"] = {
      class_type: "KSamplerAdvanced",
      inputs: { ...base, latent_image: ["3", 0], noise_seed: 9 },
    };
    Object.assign(graph["8"]?.inputs ?? {}, { samples: ["11", 0] });
    const { normalized, detection } = detect(graph);
    expect(normalized.graph["9"]?.class_type).toBe("SaveImageWebsocket");
    expect(detection.seed).toEqual([
      { node: "3", input: "seed" },
      { node: "11", input: "noise_seed" },
    ]);
    expect(detect(flux()).detection.seed).toEqual([{ node: "25", input: "noise_seed" }]);
  });

  it("takes any INT input meta marks with a seed control, only when meta is present", () => {
    const graph = sdxl();
    graph["30"] = { class_type: "NoiseMaker", inputs: { noise: 5, strength: 2 } };
    const meta = metaOf({
      NoiseMaker: {
        inputs: { noise: { kind: "INT", controlAfterGenerate: true }, strength: { kind: "INT" } },
      },
    });
    expect(detect(graph, meta).detection.seed).toEqual([
      { node: "3", input: "seed" },
      { node: "30", input: "noise" },
    ]);
    expect(detect(graph).detection.seed).toEqual([{ node: "3", input: "seed" }]);
  });

  it("chooses both encoders combined into the positive", () => {
    const graph = sdxl();
    graph["13"] = { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "golden hour" } };
    graph["14"] = {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: ["6", 0], conditioning_2: ["13", 0] },
    };
    Object.assign(graph["3"]?.inputs ?? {}, { positive: ["14", 0] });
    expect(detect(graph).detection.prompt.chosen).toEqual([
      { node: "6", input: "text" },
      { node: "13", input: "text" },
    ]);
  });

  it("chooses every text input of a multi-text encoder", () => {
    const graph = sdxl();
    graph["6"] = {
      class_type: "CLIPTextEncodeSDXL",
      inputs: { clip: ["4", 1], text_g: "a cat", text_l: "a cat", width: 1024, height: 1024 },
    };
    expect(detect(graph).detection.prompt.chosen).toEqual([
      { node: "6", input: "text_g" },
      { node: "6", input: "text_l" },
    ]);
  });

  it("leaves the prompt to the user when no path reaches the positive, longest text first with previews", () => {
    const graph = sdxl();
    const long = "x".repeat(100);
    Object.assign(graph["7"]?.inputs ?? {}, { text: long });
    graph["20"] = {
      class_type: "ControlNetApply",
      inputs: { conditioning: ["6", 0], strength: 1 },
    };
    graph["21"] = { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "" } };
    Object.assign(graph["3"]?.inputs ?? {}, { positive: ["20", 0] });
    const { prompt } = detect(graph).detection;
    expect(prompt.chosen).toBeNull();
    expect(prompt.candidates).toEqual([
      {
        node: "7",
        title: "CLIPTextEncode",
        classType: "CLIPTextEncode",
        inputs: ["text"],
        preview: "x".repeat(80),
      },
      {
        node: "6",
        title: "CLIPTextEncode",
        classType: "CLIPTextEncode",
        inputs: ["text"],
        preview: "a cat",
      },
      {
        node: "21",
        title: "CLIPTextEncode",
        classType: "CLIPTextEncode",
        inputs: ["text"],
        preview: "",
      },
    ]);
  });

  it("does not trace through ConditioningZeroOut", () => {
    const graph = sdxl();
    graph["20"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } };
    Object.assign(graph["3"]?.inputs ?? {}, { positive: ["20", 0] });
    expect(detect(graph).detection.prompt.chosen).toBeNull();
  });

  it("titles candidates by display name when meta has one", () => {
    const meta = metaOf({ CLIPTextEncode: { displayName: "CLIP Text Encode (Prompt)" } });
    expect(detect(sdxl(), meta).detection.prompt.candidates[0]?.title).toBe(
      "CLIP Text Encode (Prompt)",
    );
  });

  it("chooses the latent the output's sampler chain reaches", () => {
    const graph = sdxl();
    graph["40"] = {
      class_type: "EmptySD3LatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    };
    const { latent } = detect(graph).detection;
    expect(latent.chosen).toBe("5");
    expect(latent.candidates.map((candidate) => candidate.node)).toEqual(["5", "40"]);
  });

  it("accepts any Empty...LatentImage class with the three inputs", () => {
    const graph = sdxl();
    graph["5"] = {
      class_type: "EmptyHunyuanLatentImage",
      inputs: { width: 1, height: 1, batch_size: 1 },
    };
    expect(detect(graph).detection.latent.chosen).toBe("5");
  });
});

describe("detectWorkflow's refusals", () => {
  it("refuses a graph with no image output", () => {
    const graph = sdxl();
    delete graph["9"];
    delete graph["12"];
    expect(refusalOf(graph)).toBe("no_output");
  });

  it("refuses a graph with no text encoder", () => {
    const graph = sdxl();
    delete graph["6"];
    delete graph["7"];
    expect(refusalOf(graph)).toBe("no_prompt_slot");
  });

  it("refuses a graph with no empty latent", () => {
    const graph = sdxl();
    graph["15"] = { class_type: "LoadImage", inputs: { image: "photo.png" } };
    graph["5"] = { class_type: "VAEEncode", inputs: { pixels: ["15", 0], vae: ["4", 2] } };
    expect(refusalOf(graph)).toBe("no_size_slot");
  });

  it("refuses a graph with no seed", () => {
    const graph = sdxl();
    delete graph["3"]?.inputs.seed;
    expect(refusalOf(graph)).toBe("no_seed_slot");
  });

  it("refuses more than eight encoders feeding the positive", () => {
    const graph = sdxl();
    let positive: [string, number] = ["6", 0];
    for (let index = 0; index < 8; index++) {
      graph[`5${index}`] = {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["4", 1], text: `p${index}` },
      };
      graph[`6${index}`] = {
        class_type: "ConditioningConcat",
        inputs: { conditioning_to: positive, conditioning_from: [`5${index}`, 0] },
      };
      positive = [`6${index}`, 0];
    }
    Object.assign(graph["3"]?.inputs ?? {}, { positive });
    expect(refusalOf(graph)).toBe("too_many_targets");
  });
});

describe("detectWorkflow's family guess", () => {
  it("reads loader files and class names", () => {
    expect(detect(krea()).detection.familyGuess).toBe("krea2");
    expect(detect(flux()).detection.familyGuess).toBe("general");
    const moss = flux();
    Object.assign(moss["1"]?.inputs ?? {}, { unet_name: "MOSS-Image-v1.safetensors" });
    expect(detect(moss).detection.familyGuess).toBe("moss");
  });

  it("traces the prompt through FluxGuidance to the guider", () => {
    expect(detect(flux()).detection.prompt.chosen).toEqual([{ node: "6", input: "text" }]);
  });
});

describe("finalizing a detection", () => {
  it("gives both hires samplers the seed and inserts the ImageScale before the output", () => {
    const { normalized, detection } = detect(hires());
    expect(detection.seed).toEqual([
      { node: "3", input: "seed" },
      { node: "11", input: "seed" },
    ]);
    const result = finalizeWorkflow(normalized, detection, {});
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.template["3"]?.inputs.seed).toBe("{{seed}}");
    expect(result.template["11"]?.inputs.seed).toBe("{{seed}}");
    const scale = feederOf(result.template, "9");
    expect(result.template[scale]).toMatchObject({
      class_type: "ImageScale",
      inputs: { image: ["8", 0] },
    });
  });

  it("inserts the ImageScale after an ImageCrop between the decode and the output", () => {
    const graph = krea();
    graph["20"] = {
      class_type: "ImageCrop",
      inputs: { image: ["8", 0], width: 900, height: 1400, x: 0, y: 0 },
    };
    Object.assign(graph["9"]?.inputs ?? {}, { images: ["20", 0] });
    const { normalized, detection } = detect(graph);
    const result = finalizeWorkflow(normalized, detection, {});
    if (!result.ok) throw new Error(result.refusal.error);
    const scale = feederOf(result.template, "9");
    expect(result.template[scale]).toMatchObject({
      class_type: "ImageScale",
      inputs: { image: ["20", 0] },
    });
  });

  it("adds no ImageScale when the last node already scales to the latent's size", () => {
    const graph = krea();
    graph["20"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["8", 0],
        upscale_method: "lanczos",
        width: 1024,
        height: 1536,
        crop: "disabled",
      },
    };
    Object.assign(graph["9"]?.inputs ?? {}, { images: ["20", 0] });
    const { normalized, detection } = detect(graph);
    const result = finalizeWorkflow(normalized, detection, {});
    if (!result.ok) throw new Error(result.refusal.error);
    expect(Object.keys(result.template)).toHaveLength(Object.keys(graph).length);
    expect(result.template["20"]?.inputs).toMatchObject({
      width: "{{width}}",
      height: "{{height}}",
    });
  });

  it("leaves two savers for the choice, then drops the one not chosen", () => {
    const graph = sdxl();
    graph["10"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "b" } };
    const { normalized, detection } = detect(graph);
    expect(detection.output.chosen).toBeNull();
    expect(detection.output.candidates.map((candidate) => candidate.node)).toEqual(["9", "10"]);
    const result = finalizeWorkflow(normalized, detection, { output: "10" });
    if (!result.ok) throw new Error(result.refusal.error);
    expect(result.template["9"]).toBeUndefined();
    expect(result.template["10"]?.class_type).toBe("SaveImageWebsocket");
    expect(result.skipped).toEqual([
      "PreviewImage (node 12), nothing depended on it.",
      "SaveImage (node 9), not the chosen output.",
    ]);
    expect(finalizeWorkflow(normalized, detection, {})).toMatchObject({
      refusal: { error: "no_output" },
    });
  });
});
