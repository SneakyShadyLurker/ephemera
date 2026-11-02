import {
  detectWorkflow,
  type Inspection,
  inspectionSchema,
  type WorkflowGraph,
} from "@ephemera/core";

/*
 * Inspections for the panel's tests, detected by core from a small graph:
 * a checkpoint, two encoders, a latent, one sampler, a decoder and two image
 * outputs (a saver and a preview), so the output waits for a choice.
 */

const GRAPH: WorkflowGraph = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl-base.safetensors" } },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: { text: "A candid photo of a woman in a harbour at dusk\nfilm grain", clip: ["1", 1] },
  },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1536, batch_size: 4 } },
  "5": {
    class_type: "KSampler",
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: { __value__: ["normal", "karras"] },
      denoise: 1,
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0],
    },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { filename_prefix: "portrait", images: ["6", 0] } },
  "8": { class_type: "PreviewImage", inputs: { images: ["6", 0] } },
};

const TITLES: Record<string, string> = {
  "1": "Load Checkpoint",
  "2": "CLIP Text Encode",
  "3": "Negative",
  "4": "Empty Latent Image",
  "5": "KSampler",
  "6": "VAE Decode",
  "7": "Save Image",
  "8": "Preview Image",
};

/** The inspection of the test graph; `output` stands in for a detected output. */
export function testInspection(
  overrides: Partial<Omit<Inspection, "detection">> & { output?: string } = {},
  source: WorkflowGraph = GRAPH,
): Inspection {
  const { output, ...rest } = overrides;
  const titles = new Map(Object.entries(TITLES));
  const detected = detectWorkflow({ graph: source, changed: [], skipped: [] }, undefined, titles);
  if (!detected.ok) throw new Error("the test graph is detected");
  const detection = {
    ...detected.detection,
    output: { ...detected.detection.output, chosen: output ?? null },
  };
  return inspectionSchema.parse({
    format: "ui",
    checked: true,
    graph: source,
    nodes: Object.entries(source).map(([id, node]) => ({
      id,
      title: TITLES[id] ?? node.class_type,
      classType: node.class_type,
    })),
    detection,
    report: { changed: [], skipped: [] },
    blocked: [],
    live: { state: "ready" },
    nameSuggestion: "Flux Dev Portrait",
    ...rest,
  });
}

/**
 * The test graph with a second branch of its own latent, sampler, decoder
 * and saver: neither the size nor the output is settled until an output is chosen.
 */
export const twoBranchInspection = (): Inspection =>
  testInspection(
    {},
    {
      ...GRAPH,
      "9": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "10": {
        class_type: "KSampler",
        inputs: {
          ...GRAPH["5"]?.inputs,
          latent_image: ["9", 0],
        },
      },
      "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
      "12": { class_type: "SaveImage", inputs: { filename_prefix: "small", images: ["11", 0] } },
    },
  );
