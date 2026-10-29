/*
 * Which ComfyUI node classes a graph may use. No node may write to disk or
 * show output in ComfyUI, so an image leaves only through the one output
 * class, in memory. The curated list holds classes read in ComfyUI source as
 * keeping their output in memory; `EPHEMERA_COMFYUI_EXTRA_NODES` adds more
 * on the operator's responsibility; the refused list and pattern always win.
 * Verified against ComfyUI 0df1646a on 2026-10-28.
 *
 * Sampling (KSampler, KSamplerAdvanced, SamplerCustom, SamplerCustomAdvanced)
 * can reach ComfyUI's runtime writable-model cache (comfy/model_patcher.py,
 * comfy/anonymous_file.py: memfd on Linux, a delete-on-close temp file on
 * Windows), depending on model, device and cache settings; that is runtime
 * memory management common to every graph, not a property of a node.
 * TorchCompileModel is left out: torch.compile's Inductor can persist
 * artifacts to disk, so admitting it is the operator's call through
 * `EPHEMERA_COMFYUI_EXTRA_NODES`. No `*Save` merge class is ever admitted.
 */

/** The only sanctioned output: its binary frames are the batch. */
export const OUTPUT_CLASS = "SaveImageWebsocket";

/** Node classes every graph may use, grouped by the ComfyUI source file that defines them. */
export const CURATED_NODE_CLASSES: ReadonlySet<string> = new Set([
  // nodes.py
  "CLIPLoader",
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "ImageScaleBy",
  "KSampler",
  "LoadImage",
  "LoraLoaderModelOnly",
  "UNETLoader",
  "VAEDecode",
  "VAEEncode",
  "VAELoader",
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "DiffusersLoader",
  "unCLIPCheckpointLoader",
  "CLIPSetLastLayer",
  "LoraLoader",
  "DualCLIPLoader",
  "ControlNetLoader",
  "DiffControlNetLoader",
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  "StyleModelLoader",
  "StyleModelApply",
  "CLIPVisionLoader",
  "CLIPVisionEncode",
  "unCLIPConditioning",
  "GLIGENLoader",
  "GLIGENTextBoxApply",
  "EmptyLatentImage",
  "LatentUpscale",
  "LatentUpscaleBy",
  "LatentFromBatch",
  "RepeatLatentBatch",
  "LatentComposite",
  "LatentBlend",
  "LatentRotate",
  "LatentFlip",
  "LatentCrop",
  "SetLatentNoiseMask",
  "InpaintModelConditioning",
  "VAEEncodeForInpaint",
  "VAEDecodeTiled",
  "VAEEncodeTiled",
  "ImageScale",
  "ImageInvert",
  "ImageBatch",
  "ImagePadForOutpaint",
  "EmptyImage",
  "ConditioningAverage",
  "ConditioningCombine",
  "ConditioningConcat",
  "ConditioningMultiply",
  "ConditioningSetArea",
  "ConditioningSetAreaPercentage",
  "ConditioningSetAreaStrength",
  "ConditioningSetMask",
  "ConditioningSetTimestepRange",
  "KSamplerAdvanced",
  // custom_nodes/websocket_image_save.py
  OUTPUT_CLASS,
  // custom_nodes/ComfyUI-Krea2-Ostris-Edit: not stock ComfyUI, a custom node
  // pack the bundled Krea 2 reference graph uses
  "Krea2OstrisEditModelPatch",
  "TextEncodeKrea2OstrisEdit",
  // comfy_extras/nodes_slg.py: patches the model's sampling in memory
  "SkipLayerGuidanceDiTSimple",
  "SkipLayerGuidanceDiT",
  // comfy_extras/nodes_tcfg.py: patches the model's CFG function in memory
  "TCFG",
  // comfy_extras/nodes_apg.py: patches the model's CFG function in memory
  "APG",
  // comfy_extras/nodes_fresca.py: patches the model's CFG function in memory
  "FreSca",
  // comfy_extras/nodes_align_your_steps.py: returns sigmas computed in memory
  "AlignYourStepsScheduler",
  // comfy_extras/nodes_gits.py: returns sigmas computed in memory
  "GITSScheduler",
  // comfy_extras/nodes_sag.py: patches the model's attention in memory
  "SelfAttentionGuidance",
  // comfy_extras/nodes_hypertile.py: patches the model's attention in memory
  "HyperTile",
  // comfy_extras/nodes_tomesd.py: patches the model's attention in memory
  "TomePatchModel",
  // comfy_extras/nodes_model_downscale.py: patches the model's blocks in memory
  "PatchModelAddDownscale",
  // comfy_extras/nodes_cond.py: returns conditioning built in memory
  "CLIPTextEncodeControlnet",
  // comfy_extras/nodes_canny.py: returns an edge image computed in memory
  "Canny",
  // comfy_extras/nodes_sdupscale.py: returns conditioning and a latent built in memory
  "SD_4XUpscale_Conditioning",
  // comfy_extras/nodes_easycache.py: patches the model with an in-memory step cache
  "EasyCache",
  // comfy_extras/nodes_compositing.py: return images and masks computed in memory
  "PorterDuffImageComposite",
  "SplitImageWithAlpha",
  "JoinImageWithAlpha",
  // comfy_extras/nodes_model_merging.py: return a merged model patched in memory
  // (not CheckpointSave, ModelSave, CLIPSave or VAESave)
  "ModelMergeSimple",
  "ModelMergeBlocks",
  "ModelMergeSubtract",
  "ModelMergeAdd",
  // comfy_extras/nodes_model_merging_model_specific.py: return a merged model
  // patched in memory
  "ModelMergeSD1",
  "ModelMergeSD2",
  "ModelMergeSDXL",
  "ModelMergeSD3_2B",
  "ModelMergeAuraflow",
  "ModelMergeFlux1",
  "ModelMergeSD35_Large",
  "ModelMergeMochiPreview",
  "ModelMergeLTXV",
  "ModelMergeCosmos7B",
  "ModelMergeCosmos14B",
  "ModelMergeWAN2_1",
  "ModelMergeCosmosPredict2_2B",
  "ModelMergeCosmosPredict2_14B",
  "ModelMergeQwenImage",
  "ModelMergeKrea2",
  "ModelMergeMOSSImage",
  // comfy_extras/nodes_upscale_model.py
  "UpscaleModelLoader",
  "ImageUpscaleWithModel",
  // comfy_extras/nodes_custom_sampler.py
  "BasicScheduler",
  "KarrasScheduler",
  "ExponentialScheduler",
  "PolyexponentialScheduler",
  "LaplaceScheduler",
  "SDTurboScheduler",
  "BetaSamplingScheduler",
  "VPScheduler",
  "SplitSigmas",
  "SplitSigmasDenoise",
  "FlipSigmas",
  "SetFirstSigma",
  "ExtendIntermediateSigmas",
  "SamplingPercentToSigma",
  "KSamplerSelect",
  "SamplerDPMPP_3M_SDE",
  "SamplerDPMPP_2M_SDE",
  "SamplerDPMPP_SDE",
  "SamplerDPMPP_2S_Ancestral",
  "SamplerEulerAncestral",
  "SamplerEulerAncestralCFGPP",
  "SamplerLMS",
  "SamplerDPMAdaptative",
  "SamplerER_SDE",
  "SamplerSASolver",
  "SamplerSEEDS2",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "BasicGuider",
  "CFGGuider",
  "DualCFGGuider",
  "DualModelGuider",
  "CFGOverride",
  "RandomNoise",
  "DisableNoise",
  "AddNoise",
  "ManualSigmas",
  // comfy_extras/nodes_model_advanced.py
  "ModelAttentionBackend",
  "ModelSamplingDiscrete",
  "ModelSamplingContinuousEDM",
  "ModelSamplingContinuousV",
  "ModelSamplingStableCascade",
  "ModelSamplingSD3",
  "ModelSamplingAuraFlow",
  "ModelSamplingFlux",
  "ModelNoiseScale",
  "RescaleCFG",
  "ModelComputeDtype",
  // comfy_extras/nodes_flux.py
  "EmptyFlux2LatentImage",
  "FluxKontextMultiReferenceLatentMethod",
  "CLIPTextEncodeFlux",
  "FluxGuidance",
  "FluxDisableGuidance",
  "FluxKontextImageScale",
  "Flux2Scheduler",
  "FluxKVCache",
  // comfy_extras/nodes_sd3.py
  "EmptySD3LatentImage",
  "TripleCLIPLoader",
  "CLIPTextEncodeSD3",
  "SkipLayerGuidanceSD3",
  // comfy_extras/nodes_hidream.py
  "QuadrupleCLIPLoader",
  "CLIPTextEncodeHiDream",
  // comfy_extras/nodes_clip_sdxl.py
  "CLIPTextEncodeSDXL",
  "CLIPTextEncodeSDXLRefiner",
  // comfy_extras/nodes_lumina2.py
  "CLIPTextEncodeLumina2",
  "RenormCFG",
  // comfy_extras/nodes_qwen.py
  "TextEncodeQwenImageEdit",
  "TextEncodeQwenImageEditPlus",
  "TextEncodeQwenImage21",
  "EmptyQwenImageLayeredLatentImage",
  // comfy_extras/nodes_moss_image.py
  "MOSSImageLayoutPrompt",
  "MOSSImageControl",
  "TextEncodeMOSSImageEdit",
  // comfy_extras/nodes_edit_model.py
  "ReferenceLatent",
  "ReferenceMultiLatent",
  // comfy_extras/nodes_lora_stack.py
  "LoadLoraModel",
  "LoadLoraTextEncoder",
  // comfy_extras/nodes_model_patch.py
  "ModelPatchLoader",
  // comfy_extras/nodes_cfg.py
  "CFGZeroStar",
  "CFGNorm",
  // comfy_extras/nodes_pag.py
  "PerturbedAttentionGuidance",
  // comfy_extras/nodes_freelunch.py
  "FreeU",
  "FreeU_V2",
  // comfy_extras/nodes_differential_diffusion.py
  "DifferentialDiffusion",
  // comfy_extras/nodes_latent.py
  "LatentAdd",
  "LatentSubtract",
  "LatentMultiply",
  "LatentInterpolate",
  "LatentConcat",
  "LatentCut",
  "LatentCutToBatch",
  "LatentBatch",
  "LatentBatchSeedBehavior",
  "LatentApplyOperation",
  "LatentApplyOperationCFG",
  "LatentOperationBlend",
  "LatentOperationTonemapReinhard",
  "LatentOperationSharpen",
  // comfy_extras/nodes_post_processing.py
  "ImageScaleToTotalPixels",
  "ImageBlend",
  "ImageBlur",
  "ImageQuantize",
  "ImageSharpen",
  "ResizeImageMaskNode",
  "BatchImagesNode",
  "BatchMasksNode",
  "BatchLatentsNode",
  "ColorTransfer",
  // comfy_extras/nodes_images.py (in-memory only; not ImageCropV2, which sends a UI preview)
  "ImageCrop",
  "RepeatImageBatch",
  "ImageFromBatch",
  "ImageAddNoise",
  "ImageStitch",
  "ResizeAndPadImage",
  "PadImageNode",
  "GetImageSize",
  "ImageRotate",
  "ImageFlip",
  "ImageScaleToMaxDimension",
  // comfy_extras/nodes_mask.py (not MaskPreview, an output node)
  "LatentCompositeMasked",
  "ImageCompositeMasked",
  "MaskToImage",
  "ImageToMask",
  "ImageColorToMask",
  "SolidMask",
  "InvertMask",
  "CropMask",
  "MaskComposite",
  "FeatherMask",
  "GrowMask",
  "ThresholdMask",
  // comfy_extras/nodes_rebatch.py
  "RebatchLatents",
  "RebatchImages",
  // comfy_extras/nodes_primitive.py
  "PrimitiveString",
  "PrimitiveStringMultiline",
  "PrimitiveInt",
  "PrimitiveFloat",
  "PrimitiveBoolean",
]);

/** Node classes that write files, show output in ComfyUI or read its outputs; nothing admits them. */
export const REFUSED_NODE_CLASSES: ReadonlySet<string> = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveLatent",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
  "SaveImageAdvanced",
  "SaveSVGNode",
  "MaskPreview",
  "PreviewAny",
  "LoadImageMask",
  "LoadImageOutput",
  "LoadLatent",
  "CheckpointSave",
  "ModelSave",
  "CLIPSave",
  "VAESave",
  "LoraSave",
  "SaveAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "PreviewAudio",
  "SaveVideo",
  "SaveWEBM",
  "SaveGLB",
  "Preview3D",
  "Preview3DAnimation",
  "ImageCropV2",
]);

/** Any class named like a save or preview node is refused, whatever list holds it, `OUTPUT_CLASS` aside. */
export const REFUSED_PATTERN = /^(Save|Preview)|Save$/;

/** Where a graph comes from: a server file at start, or a graph a user imports. */
export type AllowlistContext = "file" | "import";

/** Why a class is refused in a context. */
export type RefusalReason = "refused_writes" | "not_allowed" | "reference_only";

export interface NodeAllowlist {
  allows(classType: string, context?: AllowlistContext): boolean;
  /** Why a class is refused, in the given context; undefined when allowed. */
  why(classType: string, context: AllowlistContext): RefusalReason | undefined;
}

/** Whether nothing may admit the class: on the refused list, or named like a save or preview node. */
export function isRefusedNodeClass(classType: string): boolean {
  if (classType === OUTPUT_CLASS) return false;
  return REFUSED_NODE_CLASSES.has(classType) || REFUSED_PATTERN.test(classType);
}

/** The image input reference graphs read; an imported graph paints from text only. */
const REFERENCE_ONLY_CLASS = "LoadImage";

/** The curated classes plus `extra`, the operator's `EPHEMERA_COMFYUI_EXTRA_NODES`. */
export function createAllowlist(extra: readonly string[]): NodeAllowlist {
  const allowed: ReadonlySet<string> = new Set([...CURATED_NODE_CLASSES, ...extra]);
  const why = (classType: string, context: AllowlistContext): RefusalReason | undefined => {
    if (isRefusedNodeClass(classType)) return "refused_writes";
    if (!allowed.has(classType)) return "not_allowed";
    if (context === "import" && classType === REFERENCE_ONLY_CLASS) return "reference_only";
    return undefined;
  };
  return {
    allows: (classType, context = "file") => why(classType, context) === undefined,
    why,
  };
}
