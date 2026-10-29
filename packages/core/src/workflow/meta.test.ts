import { describe, expect, it } from "vitest";
import { nodeMetaFrom, objectInfoSchema } from "./meta.ts";

/** A trimmed `/object_info` answer in the shapes ComfyUI sends. */
const OBJECT_INFO = {
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT", { default: 0, min: 0, control_after_generate: true }],
        steps: ["INT", { default: 20 }],
        cfg: ["FLOAT", { default: 8 }],
        sampler_name: [["euler", "dpmpp_2m"]],
        positive: ["CONDITIONING"],
      },
      optional: { note: ["STRING", { multiline: true }] },
    },
    output: ["LATENT"],
    output_node: false,
    display_name: "KSampler",
    category: "sampling",
  },
  SaveImage: {
    input: {
      required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] },
      hidden: { prompt: "PROMPT" },
    },
    output_node: true,
    display_name: "Save Image",
  },
  ImageScale: {
    input: {
      required: {
        image: ["IMAGE"],
        upscale_method: ["COMBO", { options: ["nearest-exact", "lanczos"] }],
        width: ["INT", { default: 512 }],
        crop: ["COMBO", { options: ["disabled", "center"] }],
        flip: ["BOOLEAN", { default: false }],
        size: ["INT", { forceInput: true }],
      },
    },
  },
};

describe("nodeMetaFrom", () => {
  const meta = nodeMetaFrom(objectInfoSchema.parse(OBJECT_INFO));

  it("lists required then optional inputs in their order, with kinds", () => {
    const sampler = meta.get("KSampler");
    expect(Object.keys(sampler?.inputs ?? {})).toEqual([
      "model",
      "seed",
      "steps",
      "cfg",
      "sampler_name",
      "positive",
      "note",
    ]);
    expect(sampler?.inputs).toMatchObject({
      model: { kind: "LINK" },
      seed: { kind: "INT", controlAfterGenerate: true },
      steps: { kind: "INT" },
      cfg: { kind: "FLOAT" },
      note: { kind: "STRING" },
    });
    expect(sampler?.inputs.steps).toEqual({ kind: "INT" });
  });

  it("reads combo choices in both forms, booleans and forced inputs", () => {
    expect(meta.get("KSampler")?.inputs.sampler_name).toEqual({
      kind: "COMBO",
      choices: ["euler", "dpmpp_2m"],
    });
    const scale = meta.get("ImageScale");
    expect(scale?.inputs.upscale_method).toEqual({
      kind: "COMBO",
      choices: ["nearest-exact", "lanczos"],
    });
    expect(scale?.inputs.flip).toEqual({ kind: "BOOLEAN" });
    expect(scale?.inputs.size).toEqual({ kind: "LINK" });
  });

  it("reads output_node and display_name, defaulting to a non-output node", () => {
    expect(meta.get("SaveImage")).toMatchObject({ outputNode: true, displayName: "Save Image" });
    expect(Object.keys(meta.get("SaveImage")?.inputs ?? {})).toEqual(["images", "filename_prefix"]);
    expect(meta.get("ImageScale")?.outputNode).toBe(false);
    expect(meta.get("ImageScale")?.displayName).toBeUndefined();
  });

  it("leaves out classes and inputs whose names the graph schemas refuse", () => {
    const info = JSON.parse(
      '{"Image Blank": {"input": {}}, "K": {"input": {"required": {"__proto__": ["INT"], "a b": ["INT"], "steps": ["INT"]}}}}',
    );
    const read = nodeMetaFrom(objectInfoSchema.parse(info));
    expect([...read.keys()]).toEqual(["K"]);
    expect(read.get("K")?.inputs).toEqual({ steps: { kind: "INT" } });
    expect(Object.getPrototypeOf(read.get("K")?.inputs)).toBe(Object.prototype);
  });

  it("reads a dynamic group as the `<group>.<row>.<field>` inputs a graph submits", () => {
    const read = nodeMetaFrom(
      objectInfoSchema.parse({
        LoadLoraModel: {
          input: {
            required: {
              model: ["MODEL"],
              loras: [
                "COMFY_DYNAMICGROUP_V3",
                {
                  template: {
                    required: {
                      lora_name: [["a.safetensors", "b.safetensors"], {}],
                      strength: ["FLOAT", { default: 1 }],
                      enabled: ["BOOLEAN", { default: true }],
                    },
                  },
                  min: 1,
                  max: 2,
                  group_name: "LoRA",
                },
              ],
            },
          },
        },
      }),
    );
    expect(read.get("LoadLoraModel")?.inputs).toEqual({
      model: { kind: "LINK" },
      "loras.0.lora_name": { kind: "COMBO", choices: ["a.safetensors", "b.safetensors"] },
      "loras.0.strength": { kind: "FLOAT" },
      "loras.0.enabled": { kind: "BOOLEAN" },
      "loras.1.lora_name": { kind: "COMBO", choices: ["a.safetensors", "b.safetensors"] },
      "loras.1.strength": { kind: "FLOAT" },
      "loras.1.enabled": { kind: "BOOLEAN" },
    });
  });

  it("orders inputs by input_order and names the required ones", () => {
    const read = nodeMetaFrom(
      objectInfoSchema.parse({
        EmptyLatentImage: {
          input: {
            required: { batch_size: ["INT"], width: ["INT"], height: ["INT"] },
            optional: { note: ["STRING"] },
          },
          input_order: { required: ["width", "height", "batch_size"], optional: ["note"] },
        },
      }),
    );
    const latent = read.get("EmptyLatentImage");
    expect(Object.keys(latent?.inputs ?? {})).toEqual(["width", "height", "batch_size", "note"]);
    expect(latent?.required).toEqual(["width", "height", "batch_size"]);
  });

  it("reads growing inputs and the widgets only the UI saves", () => {
    const read = nodeMetaFrom(
      objectInfoSchema.parse({
        Encode: {
          input: {
            required: {
              images: [
                "COMFY_AUTOGROW_V3",
                {
                  template: {
                    input: { required: { image: ["IMAGE", {}] } },
                    names: ["image_1", "image_2"],
                    min: 1,
                  },
                },
              ],
              masks: [
                "COMFY_AUTOGROW_V3",
                { template: { input: { required: { strength: ["FLOAT", {}] } }, prefix: "m" } },
              ],
            },
          },
        },
        LoadImage: { input: { required: { image: [["a.png"], { image_upload: true }] } } },
      }),
    );
    expect(read.get("Encode")?.growing).toEqual({
      images: { kind: "sockets", min: 1, names: ["image_1", "image_2"] },
      masks: { kind: "unreadable" },
    });
    expect(read.get("LoadImage")?.uiOnlyWidgets).toBe(1);
    expect(read.get("Encode")?.uiOnlyWidgets).toBeUndefined();
  });
});
