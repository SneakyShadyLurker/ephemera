# ComfyUI workflow fixtures

Workflows built in a stock ComfyUI and downloaded through its own menus, for
the UI-to-API conversion and the import tests. `../workflows.ts` loads them.

## Source

- ComfyUI commit `0df1646a9cd71d4c990a87014fb37797a2956ead`, no custom nodes.
- Frontend package `comfyui-frontend-package` 1.57.6.
- `<name>.ui.json`: Menu > File > Export. `<name>.api.json`: Menu > File >
  Export (API), from the same graph with nothing changed in between.
- `<name>.object_info.json`: that server's `/object_info` answer, keeping
  only the classes the fixture's UI or API file names. Frontend-only nodes
  (`Reroute`, `PrimitiveNode`) and subgraph instances have no entry.
- `<name>.expect.json`, written by hand from the exports: `apiToUi` maps each
  API node id to its UI execution id (the root node id, or
  `<instance>:<inner>` inside a subgraph); `omitted` names each UI node
  without an API node and why; `ui` and `api` give the expected outcome of
  importing each file, a success or a refusal code and the stage that
  refuses (`convert` for the conversion, `gate` for the node allowlist).

Every API file was accepted by that server's `POST /prompt` with no node
errors. Model files are generic placeholder names, prompts are generic text,
and every KSampler's `control_after_generate` is `randomize`.

## Edits to the exports

- No exported file needed a value replaced. They were checked for absolute
  paths, user, host and machine names, client ids and machine ids in
  `extra` (which holds only the canvas offset, `frontendVersion` and, in
  `reroute-primitive`, the native reroute). The workflow `id` values are
  random UUIDs the frontend generates.
- The repository formatter re-indented the JSON; the values are unchanged.
- `sdxl-basic-v1.ui.json` is hand-converted, not exported. This frontend
  writes version 0.4 with tuple links at the root and only writes version 1
  (object links) for subgraph definitions, so the root version 1 format
  comes from converting `sdxl-basic.ui.json`: `version` 1, `last_node_id`
  and `last_link_id` moved into `state`, and each link tuple
  `[id, origin_id, origin_slot, target_id, target_slot, type]` written as an
  object with those keys, following the version 1 subgraph definitions in
  `subgraph-promoted.ui.json`. Nodes are unchanged. Its API file is
  `sdxl-basic.api.json`.
- `qwen-edit-images` and `qwen21-dynamic` load `fixture.png`, a 16 by 16
  image in that server's input folder. It is not part of the repository.

## Fixtures

| Fixture | Covers |
|---|---|
| `sdxl-basic` | Checkpoint, two text encoders, empty latent, KSampler, decode, a SaveImage and a PreviewImage; version 0.4 with tuple links |
| `sdxl-basic-v1` | The same graph at root version 1 with object links (hand-converted) |
| `flux-guidance` | UNET, dual CLIP and VAE loaders, FluxGuidance on the positive, ConditioningZeroOut as the negative |
| `subgraph-promoted` | Both encoders and the sampler in a subgraph instance (node 9, type a UUID), with text, seed and steps promoted; inner nodes run as `9:2`, `9:3`, `9:5`; the definition is version 1 with object links inside a version 0.4 root |
| `bypass-mute` | A bypassed LoraLoader (mode 4) whose links pass through to the checkpoint, and a muted text encoder (mode 2) left out |
| `reroute-primitive` | A legacy Reroute node on the model link, a PrimitiveNode supplying steps 24, and a native reroute in `extra.reroutes` |
| `hires-two-samplers` | Two KSamplers with LatentUpscaleBy 1.5 between them, the second at denoise 0.5 |
| `qwen-text` | TextEncodeQwenImageEdit with no image input and an empty latent; a success |
| `qwen-edit-images` | A LoadImage into TextEncodeQwenImageEdit; refused `reference_only` in both formats |
| `qwen21-dynamic` | TextEncodeQwenImage21 with growing image inputs `images.image_1` and `images.image_2` (and an empty `images.image_3` slot in the UI file); the UI file refuses `dynamic_inputs`, the API file succeeds |
