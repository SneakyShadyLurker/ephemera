import { describe, expect, it } from "vitest";
import bundled from "../../../../apps/server/src/comfyui/workflows/krea2-gonzalomo.json" with {
  type: "json",
};
import type { WorkflowGraph } from "./graph.ts";
import type { NodeMeta, NodeMetaMap } from "./meta.ts";
import { normalizeWorkflow } from "./normalize.ts";

const isOutputClass = (classType: string) => classType === "SaveImageWebsocket";
const isRefused = (classType: string) =>
  classType !== "SaveImageWebsocket" &&
  (["LoadLatent", "SaveLatent"].includes(classType) || /^(Save|Preview)|Save$/.test(classType));
const normalize = (graph: WorkflowGraph, meta?: NodeMetaMap) =>
  normalizeWorkflow(graph, meta, isOutputClass, isRefused);

/** An SDXL export: one checkpoint, a positive and a negative encoder, a saver and a preview. */
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

const metaOf = (entries: Record<string, Partial<NodeMeta>>): NodeMetaMap =>
  new Map(
    Object.entries(entries).map(([classType, meta]) => [
      classType,
      { outputNode: false, inputs: {}, ...meta },
    ]),
  );

describe("normalizeWorkflow", () => {
  it("leaves the bundled graph as it is", () => {
    const graph: WorkflowGraph = structuredClone(bundled);
    const result = normalize(graph);
    expect(result).toEqual({ graph: bundled, changed: [], skipped: [] });
  });

  it("swaps the one saver for SaveImageWebsocket and drops a leaf preview, without meta", () => {
    const source = sdxl();
    const result = normalize(source);
    expect(result.graph["9"]).toEqual({
      class_type: "SaveImageWebsocket",
      inputs: { images: ["8", 0] },
    });
    expect(result.graph["12"]).toBeUndefined();
    expect(Object.keys(result.graph).sort()).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
    expect(result.changed).toEqual([
      "SaveImage (node 9) now sends the picture to Ephemera instead of a file.",
    ]);
    expect(result.skipped).toEqual(["PreviewImage (node 12), nothing depended on it."]);
    expect(source["9"]?.class_type).toBe("SaveImage");
  });

  it("names nodes by their display names when meta has them", () => {
    const meta = metaOf({
      SaveImage: { outputNode: true, displayName: "Save Image" },
      PreviewImage: { outputNode: true, displayName: "Preview Image" },
    });
    const result = normalize(sdxl(), meta);
    expect(result.changed).toEqual([
      "Save Image (node 9) now sends the picture to Ephemera instead of a file.",
    ]);
    expect(result.skipped).toEqual(["Preview Image (node 12), nothing depended on it."]);
  });

  it("keeps a linked SaveImageWebsocket and drops every other leaf output", () => {
    const graph = sdxl();
    graph["20"] = { class_type: "SaveImageWebsocket", inputs: { images: ["8", 0] } };
    graph["21"] = { class_type: "SaveLatent", inputs: { samples: ["3", 0] } };
    const result = normalize(graph);
    expect(result.graph["20"]?.class_type).toBe("SaveImageWebsocket");
    expect(Object.keys(result.graph)).not.toContain("9");
    expect(Object.keys(result.graph)).not.toContain("12");
    expect(Object.keys(result.graph)).not.toContain("21");
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([
      "SaveImage (node 9), nothing depended on it.",
      "PreviewImage (node 12), nothing depended on it.",
      "SaveLatent (node 21), nothing depended on it.",
    ]);
  });

  it("leaves several savers for the output choice", () => {
    const graph = sdxl();
    graph["10"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "b" } };
    const result = normalize(graph);
    expect(result.graph["9"]?.class_type).toBe("SaveImage");
    expect(result.graph["10"]?.class_type).toBe("SaveImage");
    expect(result.graph["12"]).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  it("swaps a lone preview, and an image output only meta knows", () => {
    const preview = sdxl();
    delete preview["9"];
    expect(normalize(preview).graph["12"]).toEqual({
      class_type: "SaveImageWebsocket",
      inputs: { images: ["8", 0] },
    });

    const custom = sdxl();
    delete custom["12"];
    custom["9"] = { class_type: "ImageOutputPro", inputs: { images: ["8", 0], quality: 90 } };
    const meta = metaOf({ ImageOutputPro: { outputNode: true } });
    expect(normalize(custom, meta).graph["9"]).toEqual({
      class_type: "SaveImageWebsocket",
      inputs: { images: ["8", 0] },
    });
    expect(normalize(custom).graph["9"]?.class_type).toBe("ImageOutputPro");
  });

  it("keeps an output node something depends on", () => {
    const graph = sdxl();
    graph["30"] = { class_type: "LoadLatent", inputs: { latent: "x.latent" } };
    Object.assign(graph["3"]?.inputs ?? {}, { latent_image: ["30", 0] });
    const result = normalize(graph);
    expect(result.graph["30"]?.class_type).toBe("LoadLatent");
    expect(result.skipped).toEqual(["PreviewImage (node 12), nothing depended on it."]);
  });
});
