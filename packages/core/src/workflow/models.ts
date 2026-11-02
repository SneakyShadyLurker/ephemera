/*
 * Which graph inputs name a model file. ComfyUI's loaders offer their files
 * as a combo whose input name ends in `_name` or `_path`; this table holds
 * the exceptions to that convention, so the rule that reads it
 * (apps/server/src/comfyui/workflow.ts) stays one line. A LoRA stack's
 * `loras.<row>.lora_name` follows the convention. VAELoader's `pixel_space`
 * is a choice inside `vae_name`, always among its choices, so never missing.
 * Verified against ComfyUI 0df1646a on 2026-10-28.
 */

export interface ModelInputExceptions {
  /** `_name` or `_path` combos that choose a setting, not a file, on any class. */
  notFiles: ReadonlySet<string>;
  /** Inputs that hold a model file under another name, by node class. */
  files: Readonly<Record<string, readonly string[]>>;
}

export const MODEL_INPUT_EXCEPTIONS: ModelInputExceptions = {
  notFiles: new Set(["sampler_name"]),
  files: {
    DualCLIPLoader: ["clip_name1", "clip_name2"],
    TripleCLIPLoader: ["clip_name1", "clip_name2", "clip_name3"],
    QuadrupleCLIPLoader: ["clip_name1", "clip_name2", "clip_name3", "clip_name4"],
    ModelPatchLoader: ["name"],
  },
};
