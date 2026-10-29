import { describe, expect, it } from "vitest";
import {
  loadWorkflowFixture,
  loadWorkflowFixtures,
  type WorkflowFixture,
  withoutMeta,
} from "../../test-fixtures/workflows.ts";
import {
  CONVERT_REFUSALS,
  type ConvertRefusalCode,
  type ConvertResult,
  convertCounting,
  convertWorkflow,
  detectFormat,
} from "./convert.ts";
import { WORKFLOW_LIMITS } from "./graph.ts";
import { type NodeMetaMap, nodeMetaFrom, objectInfoSchema } from "./meta.ts";

const metaOf = (fixture: WorkflowFixture): NodeMetaMap =>
  nodeMetaFrom(objectInfoSchema.parse(fixture.objectInfo));

/** Numbers as JSON carries them, so `7` and `7.0` compare equal. */
const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const converted = (result: ConvertResult) => {
  if (!result.ok) throw new Error(`refused ${result.refusal.error}`);
  return result;
};

const refusedWith = (result: ConvertResult): ConvertRefusalCode | undefined =>
  result.ok ? undefined : (result.refusal.error as ConvertRefusalCode);

/** A fixture's UI file, cloned for a test to edit. */
const uiOf = (name: string) => structuredClone(loadWorkflowFixture(name).ui) as UiFile;
const metaNamed = (name: string) => metaOf(loadWorkflowFixture(name));

interface UiFile {
  nodes: UiNodeFile[];
  links: unknown[];
  definitions?: { subgraphs: Record<string, unknown>[] };
  [key: string]: unknown;
}
interface UiNodeFile {
  id: number;
  type: string;
  mode?: number;
  title?: string | null;
  inputs?: { name: string; type?: string; link: number | null; widget?: { name: string } }[];
  outputs?: { name?: string; type: string; links?: number[] | null }[];
  widgets_values?: unknown;
  widgets_values_named?: Record<string, unknown> | null;
  [key: string]: unknown;
}

const nodeIn = (file: UiFile, id: number): UiNodeFile => {
  const node = file.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
};

/** Without the named values, so the positional `widgets_values` are read. */
const positionalOnly = (file: UiFile) => {
  const strip = (nodes: UiNodeFile[]) => {
    for (const node of nodes) delete node.widgets_values_named;
  };
  strip(file.nodes);
  for (const definition of file.definitions?.subgraphs ?? []) {
    strip(definition.nodes as UiNodeFile[]);
  }
  return file;
};

describe("detectFormat", () => {
  it("tells a UI file, an API file and anything else apart", () => {
    const fixture = loadWorkflowFixture("sdxl-basic");
    expect(detectFormat(fixture.ui)).toBe("ui");
    expect(detectFormat(loadWorkflowFixture("sdxl-basic-v1").ui)).toBe("ui");
    expect(detectFormat(fixture.api)).toBe("api");
    expect(detectFormat({ ...(withoutMeta(fixture.api) as object), ephemera: { name: "A" } })).toBe(
      "api",
    );
    expect(detectFormat({})).toBeUndefined();
    expect(detectFormat([])).toBeUndefined();
    expect(detectFormat({ nodes: [], links: [], version: 2 })).toBeUndefined();
    expect(detectFormat({ "1": { class_type: "KSampler" } })).toBeUndefined();
  });
});

describe("convertWorkflow on the exported fixtures", () => {
  const fixtures = loadWorkflowFixtures().filter(
    (fixture) => fixture.expect.ui.ok || fixture.expect.ui.stage === "gate",
  );

  it.each(fixtures.map((fixture): [string, WorkflowFixture] => [fixture.name, fixture]))(
    "%s converts to its API export",
    (_, fixture) => {
      const result = converted(convertWorkflow(fixture.ui, metaOf(fixture)));
      expect(normalized(result.graph)).toEqual(normalized(withoutMeta(fixture.api)));
      expect(result.skipped).toEqual([]);
    },
  );

  it.each(fixtures.map((fixture): [string, WorkflowFixture] => [fixture.name, fixture]))(
    "%s converts the same from positional widget values",
    (_, fixture) => {
      const result = converted(
        convertWorkflow(positionalOnly(structuredClone(fixture.ui) as UiFile), metaOf(fixture)),
      );
      expect(normalized(result.graph)).toEqual(normalized(withoutMeta(fixture.api)));
      expect(result.skipped).toEqual([]);
    },
  );

  it("converts the version 0.4 and version 1 files of one graph identically", () => {
    const legacy = loadWorkflowFixture("sdxl-basic");
    const v1 = loadWorkflowFixture("sdxl-basic-v1");
    expect(convertWorkflow(v1.ui, metaOf(v1))).toEqual(convertWorkflow(legacy.ui, metaOf(legacy)));
  });

  it("lists each node with the file's title, else the display name, else the class", () => {
    const fixture = loadWorkflowFixture("qwen21-dynamic");
    const { nodes } = converted(convertWorkflow(fixture.ui, metaOf(fixture)));
    expect(nodes).toContainEqual({
      id: "3",
      title: "Positive",
      classType: "TextEncodeQwenImage21",
    });
    expect(nodes).toContainEqual({ id: "1", title: "UNETLoader", classType: "UNETLoader" });
    // No title in the file: the display name, else (display_name null) the class.
    expect(nodes).toContainEqual({ id: "7", title: "KSampler", classType: "KSampler" });
    expect(nodes).toContainEqual({
      id: "6",
      title: "EmptySD3LatentImage",
      classType: "EmptySD3LatentImage",
    });
    const file = uiOf("sdxl-basic");
    delete nodeIn(file, 7).title;
    const saver = converted(convertWorkflow(file, metaNamed("sdxl-basic"))).nodes;
    expect(saver).toContainEqual({ id: "7", title: "Save Image", classType: "SaveImage" });
    expect(saver.map((node) => node.id).sort()).toEqual(
      Object.keys(withoutMeta(loadWorkflowFixture("sdxl-basic").api) as object).sort(),
    );
  });

  it("flattens subgraph-promoted to the execution ids of its expect.json", () => {
    const fixture = loadWorkflowFixture("subgraph-promoted");
    const { graph, nodes } = converted(convertWorkflow(fixture.ui, metaOf(fixture)));
    expect(Object.keys(graph).sort()).toEqual(Object.values(fixture.expect.apiToUi).sort());
    expect(nodes).toContainEqual({ id: "9:2", title: "Positive", classType: "CLIPTextEncode" });
  });

  it("drops the bypassed and muted nodes, passing links through the bypassed one", () => {
    const fixture = loadWorkflowFixture("bypass-mute");
    const { graph } = converted(convertWorkflow(fixture.ui, metaOf(fixture)));
    for (const id of Object.keys(fixture.expect.omitted)) expect(graph[id]).toBeUndefined();
    expect(graph["5"]?.inputs.model).toEqual(["1", 0]);
    expect(graph["2"]?.inputs.clip).toEqual(["1", 1]);
  });

  it("passes each output of a bypassed node the input at its own slot when the types fit", () => {
    const file = uiOf("sdxl-basic");
    const links = file.links as [number, number, number, number, number, string][];
    for (const link of links) {
      if (link[0] === 4) [link[3], link[4]] = [9, 0];
      if (link[0] === 5) [link[3], link[4]] = [9, 1];
    }
    links.push([11, 9, 0, 5, 1, "CONDITIONING"], [12, 9, 1, 5, 2, "CONDITIONING"]);
    file.nodes.push({
      id: 9,
      type: "ControlNetApplyAdvanced",
      mode: 4,
      inputs: [
        { name: "positive", type: "CONDITIONING", link: 4 },
        { name: "negative", type: "CONDITIONING", link: 5 },
        { name: "control_net", type: "CONTROL_NET", link: null },
        { name: "image", type: "IMAGE", link: null },
      ],
      outputs: [
        { name: "positive", type: "CONDITIONING", links: [11] },
        { name: "negative", type: "CONDITIONING", links: [12] },
      ],
      widgets_values: [1, 0, 1],
    });
    const sampler = nodeIn(file, 5);
    for (const input of sampler.inputs ?? []) {
      if (input.name === "positive") input.link = 11;
      if (input.name === "negative") input.link = 12;
    }
    const { graph } = converted(convertWorkflow(file, metaNamed("sdxl-basic")));
    expect(graph["9"]).toBeUndefined();
    expect(graph["5"]?.inputs.positive).toEqual(["2", 0]);
    expect(graph["5"]?.inputs.negative).toEqual(["3", 0]);
  });

  it("follows a Reroute and copies a PrimitiveNode's value; native reroutes are decoration", () => {
    const fixture = loadWorkflowFixture("reroute-primitive");
    const { graph } = converted(convertWorkflow(fixture.ui, metaOf(fixture)));
    expect(graph["5"]?.inputs.model).toEqual(["1", 0]);
    expect(graph["5"]?.inputs.steps).toBe(24);
    expect(graph["9"]).toBeUndefined();
    expect(graph["10"]).toBeUndefined();
  });

  it("emits linked growing sockets under their API keys and leaves the empty one out", () => {
    const fixture = loadWorkflowFixture("qwen21-dynamic");
    const { graph } = converted(convertWorkflow(fixture.ui, metaOf(fixture)));
    expect(graph["3"]?.inputs).toMatchObject({
      "images.image_1": ["11", 0],
      "images.image_2": ["12", 0],
    });
    expect(Object.hasOwn(graph["3"]?.inputs ?? {}, "images.image_3")).toBe(false);
    expect(Object.hasOwn(graph["3"]?.inputs ?? {}, "images")).toBe(false);
  });
});

describe("widget values", () => {
  it("skips control_after_generate and the upload widget, from names and from positions", () => {
    for (const file of [uiOf("qwen-edit-images"), positionalOnly(uiOf("qwen-edit-images"))]) {
      const { graph, skipped } = converted(convertWorkflow(file, metaNamed("qwen-edit-images")));
      expect(graph["7"]?.inputs.seed).toBe(42);
      expect(graph["7"]?.inputs.steps).toBe(20);
      expect(graph["7"]?.inputs).not.toHaveProperty("control_after_generate");
      expect(graph["11"]?.inputs).toEqual({ image: "fixture.png" });
      expect(skipped).toEqual([]);
    }
  });

  it("orders positional values by input_order over the listed order", () => {
    const fixture = loadWorkflowFixture("sdxl-basic");
    const info = structuredClone(fixture.objectInfo) as Record<string, Record<string, unknown>>;
    const latent = info.EmptyLatentImage as { input: { required: Record<string, unknown> } };
    const { width, height, batch_size } = latent.input.required;
    latent.input.required = { batch_size, height, width };
    const meta = nodeMetaFrom(objectInfoSchema.parse(info));
    const file = positionalOnly(uiOf("sdxl-basic"));
    nodeIn(file, 4).widgets_values = [1024, 768, 2];
    expect(converted(convertWorkflow(file, meta)).graph["4"]?.inputs).toEqual({
      width: 1024,
      height: 768,
      batch_size: 2,
    });
  });

  it("reports surplus trailing values under Left out", () => {
    const file = positionalOnly(uiOf("sdxl-basic"));
    nodeIn(file, 4).widgets_values = [1024, 1024, 1, "extra", 3];
    const result = converted(convertWorkflow(file, metaNamed("sdxl-basic")));
    expect(result.graph["4"]?.inputs).toEqual({ width: 1024, height: 1024, batch_size: 1 });
    expect(result.skipped).toEqual(["EmptyLatentImage (node 4), 2 values the node does not use."]);
  });

  it("skips the controls the frontend adds without asking, and a combo's two", () => {
    const meta = nodeMetaFrom(
      objectInfoSchema.parse({
        CustomSampler: {
          input: {
            required: {
              seed: ["INT", {}],
              steps: ["INT", {}],
              mode: [["a", "b"], { control_after_generate: true }],
              cfg: ["FLOAT", {}],
            },
          },
        },
      }),
    );
    const file = {
      version: 0.4,
      nodes: [
        {
          id: 1,
          type: "CustomSampler",
          inputs: [],
          outputs: [],
          widgets_values: [42, "randomize", 24, "b", "fixed", "", 7],
        },
      ],
      links: [],
    };
    const result = converted(convertWorkflow(file, meta));
    expect(result.graph["1"]?.inputs).toEqual({ seed: 42, steps: 24, mode: "b", cfg: 7 });
    expect(result.skipped).toEqual([]);
  });

  it("skips only the control after a multi-select combo, which has no filter list", () => {
    const meta = nodeMetaFrom(
      objectInfoSchema.parse({
        CustomPicker: {
          input: {
            required: {
              mode: [["a", "b"], { multi_select: true, control_after_generate: true }],
              cfg: ["FLOAT", {}],
            },
          },
        },
      }),
    );
    const file = {
      version: 0.4,
      nodes: [{ id: 1, type: "CustomPicker", widgets_values: [["a"], "fixed", 7] }],
      links: [],
    };
    expect(converted(convertWorkflow(file, meta)).graph["1"]?.inputs).toEqual({
      mode: ["a"],
      cfg: 7,
    });
  });

  it("takes a link over a widget value for the same input", () => {
    const file = uiOf("reroute-primitive");
    expect(nodeIn(file, 5).widgets_values_named?.steps).toBe(24);
    nodeIn(file, 10).widgets_values = [31, "fixed"];
    const { graph } = converted(convertWorkflow(file, metaNamed("reroute-primitive")));
    expect(graph["5"]?.inputs.steps).toBe(31);
  });
});

describe("subgraphs", () => {
  it("takes promoted values by position when the instance has no names", () => {
    const file = positionalOnly(uiOf("subgraph-promoted"));
    nodeIn(file, 9).widgets_values = ["a red door", "noise", 7, 30];
    const { graph } = converted(convertWorkflow(file, metaNamed("subgraph-promoted")));
    expect(graph["9:2"]?.inputs.text).toBe("a red door");
    expect(graph["9:3"]?.inputs.text).toBe("noise");
    expect(graph["9:5"]?.inputs).toMatchObject({ seed: 7, steps: 30, cfg: 7 });
  });

  it("falls back to the inner nodes' own values when the instance has none", () => {
    const file = positionalOnly(uiOf("subgraph-promoted"));
    nodeIn(file, 9).widgets_values = [];
    const fixture = loadWorkflowFixture("subgraph-promoted");
    const { graph } = converted(convertWorkflow(file, metaOf(fixture)));
    expect(normalized(graph)).toEqual(normalized(withoutMeta(fixture.api)));
  });

  it("refuses subgraph_widgets when the positional values do not line up", () => {
    const file = positionalOnly(uiOf("subgraph-promoted"));
    nodeIn(file, 9).widgets_values = ["a red door", 7, 30];
    expect(convertWorkflow(file, metaNamed("subgraph-promoted"))).toEqual({
      ok: false,
      refusal: { error: "subgraph_widgets", nodes: ["9"] },
    });
  });
});

/** One definition with `inner` CLIPTextEncode nodes chained to nothing, instanced `count` times. */
function instanced(count: number, inner: number): UiFile {
  const definition = {
    id: "0f0f0f0f-0000-4000-8000-000000000001",
    version: 1,
    inputs: [],
    outputs: [],
    nodes: Array.from({ length: inner }, (_, index) => ({
      id: index + 1,
      type: "CheckpointLoaderSimple",
      mode: 0,
      inputs: [],
      outputs: [],
      widgets_values: ["sdxl-base.safetensors"],
    })),
    links: [],
  };
  return {
    version: 0.4,
    nodes: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      type: definition.id,
      mode: 0,
      inputs: [],
      outputs: [],
    })),
    links: [],
    definitions: { subgraphs: [definition] },
  };
}

/** Definitions each holding one instance of the next, `depth` levels deep. */
function nested(depth: number): UiFile {
  const ids = Array.from(
    { length: depth },
    (_, level) => `0f0f0f0f-0000-4000-8000-${String(level).padStart(12, "0")}`,
  );
  const subgraphs = ids.map((id, level) => ({
    id,
    version: 1,
    inputs: [],
    outputs: [],
    nodes: [
      level + 1 < depth
        ? { id: 1, type: ids[level + 1], mode: 0, inputs: [], outputs: [] }
        : {
            id: 1,
            type: "CheckpointLoaderSimple",
            mode: 0,
            inputs: [],
            outputs: [],
            widgets_values: ["sdxl-base.safetensors"],
          },
    ],
    links: [],
  }));
  return {
    version: 0.4,
    nodes: [{ id: 1, type: ids[0] as string, mode: 0, inputs: [], outputs: [] }],
    links: [],
    definitions: { subgraphs },
  };
}

/**
 * A pass-through definition holding `filler` dangling links, instanced in a
 * chain `count` long that carries the loader's VAE to `decoders` VAEDecodes.
 */
function chained(count: number, filler: number, decoders: number): UiFile {
  const definition = {
    id: "0f0f0f0f-0000-4000-8000-000000000002",
    version: 1,
    inputs: [{ name: "in", type: "VAE" }],
    outputs: [{ name: "out", type: "VAE" }],
    nodes: [],
    links: [
      [1, -10, 0, -20, 0, "VAE"],
      ...Array.from({ length: filler }, (_, index) => [index + 2, 5, 0, 6, 0, "VAE"]),
    ],
  };
  const instances = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    type: definition.id,
    mode: 0,
    inputs: [{ name: "in", type: "VAE", link: 100_000 + index + 1 }],
    outputs: [{ name: "out", type: "VAE" }],
  }));
  const decodes = Array.from({ length: decoders }, (_, index) => ({
    id: 2000 + index,
    type: "VAEDecode",
    mode: 0,
    inputs: [
      { name: "samples", type: "LATENT", link: 300_000 + index },
      { name: "vae", type: "VAE", link: 400_000 + index },
    ],
    outputs: [{ type: "IMAGE" }],
  }));
  return {
    version: 0.4,
    nodes: [
      {
        id: 1000,
        type: "CheckpointLoaderSimple",
        mode: 0,
        widgets_values: ["sdxl-base.safetensors"],
      },
      { id: 1001, type: "EmptyLatentImage", mode: 0, widgets_values: [1024, 1024, 1] },
      ...instances,
      ...decodes,
    ],
    links: [
      ...instances.map((_, index) =>
        index === 0
          ? [100_001, 1000, 2, 1, 0, "VAE"]
          : [100_000 + index + 1, index, 0, index + 1, 0, "VAE"],
      ),
      ...decodes.flatMap((_, index) => [
        [300_000 + index, 1001, 0, 2000 + index, 0, "LATENT"],
        [400_000 + index, count, 0, 2000 + index, 1, "VAE"],
      ]),
    ],
    definitions: { subgraphs: [definition] },
  };
}

describe("limits", () => {
  const meta = metaNamed("sdxl-basic");

  it("reads a definition's links once for all its instances and resolves each link once", () => {
    const file = chained(199, 25_000, 198);
    const started = performance.now();
    const { graph } = converted(convertWorkflow(file, meta));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(Object.keys(graph)).toHaveLength(200);
    expect(graph["2197"]?.inputs.vae).toEqual(["1000", 2]);
  });

  it("refuses as too_large a bypassed node whose long type lists would stall resolving", () => {
    // 255 characters, the longest type kept; no input fits the output, so each lookup scans all.
    const list = (member: string) => Array.from({ length: 128 }, () => member).join(",");
    const consumers = Array.from({ length: 198 }, (_, index) => index + 2000);
    const file = {
      version: 0.4,
      nodes: [
        { id: 1000, type: "CheckpointLoaderSimple", widgets_values: ["sdxl-base.safetensors"] },
        { id: 1001, type: "EmptyLatentImage", widgets_values: [1024, 1024, 1] },
        {
          id: 5000,
          type: "AnyCustomNode",
          mode: 4,
          inputs: Array.from({ length: 256 }, (_, index) => ({
            name: `in_${index}`,
            type: list("a"),
            link: index === 0 ? 1 : null,
          })),
          outputs: [{ type: list("b") }],
        },
        ...consumers.map((id) => ({
          id,
          type: "VAEDecode",
          inputs: [
            { name: "samples", type: "LATENT", link: id * 10 },
            { name: "vae", type: "VAE,c", link: id * 10 + 1 },
          ],
        })),
      ],
      links: [
        [1, 1000, 2, 5000, 0, "VAE"],
        ...consumers.flatMap((id) => [
          [id * 10, 1001, 0, id, 0, "LATENT"],
          [id * 10 + 1, 5000, 0, id, 1, "VAE"],
        ]),
      ],
    };
    const started = performance.now();
    expect(refusedWith(convertWorkflow(file, meta))).toBe("too_large");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("charges the node budget as instances expand, refusing before it is exceeded", () => {
    let materialized = 0;
    const result = convertCounting(instanced(50, 5), meta, () => {
      materialized++;
    });
    expect(refusedWith(result)).toBe("too_many_nodes");
    expect(materialized).toBeLessThanOrEqual(WORKFLOW_LIMITS.nodes);
    expect(materialized).toBeGreaterThan(0);
  });

  it("flattens instances within the budget with nested execution ids", () => {
    const { graph } = converted(convertWorkflow(instanced(2, 2), meta));
    expect(Object.keys(graph).sort()).toEqual(["1:1", "1:2", "2:1", "2:2"]);
    const deep = converted(convertWorkflow(nested(WORKFLOW_LIMITS.subgraphDepth), meta));
    expect(Object.keys(deep.graph)).toEqual(["1:1:1:1:1"]);
  });

  it("refuses nesting past subgraphDepth, and a definition that holds itself, before traversal", () => {
    let materialized = 0;
    const count = () => {
      materialized++;
    };
    expect(
      refusedWith(convertCounting(nested(WORKFLOW_LIMITS.subgraphDepth + 1), meta, count)),
    ).toBe("too_deep");
    const looped = nested(1);
    const [definition] = looped.definitions?.subgraphs ?? [];
    if (definition === undefined) throw new Error("no definition");
    definition.nodes = [{ id: 1, type: definition.id, mode: 0, inputs: [], outputs: [] }];
    expect(refusedWith(convertCounting(looped, meta, count))).toBe("too_deep");
    expect(materialized).toBe(0);
  });

  it("refuses past uiNodes and jsonDepth before traversal", () => {
    let materialized = 0;
    const count = () => {
      materialized++;
    };
    const many = instanced(WORKFLOW_LIMITS.uiNodes + 1, 0);
    expect(refusedWith(convertCounting(many, meta, count))).toBe("too_many_nodes");
    const inner = instanced(1, WORKFLOW_LIMITS.uiNodes);
    expect(refusedWith(convertCounting(inner, meta, count))).toBe("too_many_nodes");
    let deep: unknown = 1;
    for (let level = 0; level < WORKFLOW_LIMITS.jsonDepth; level++) deep = [deep];
    const file = uiOf("sdxl-basic");
    nodeIn(file, 1).properties = deep;
    expect(refusedWith(convertCounting(file, meta, count))).toBe("too_deep");
    expect(materialized).toBe(0);
  });
});

describe("refusals", () => {
  /** A test producing each conversion refusal, so none is left untested. */
  const cases: Record<ConvertRefusalCode, () => ConvertResult> = {
    not_a_workflow: () =>
      convertWorkflow({ nodes: "x", links: [], version: 0.4 }, metaNamed("sdxl-basic")),
    too_large: () => {
      const file = uiOf("sdxl-basic");
      nodeIn(file, 2).widgets_values_named = { text: "x".repeat(WORKFLOW_LIMITS.stringLength + 1) };
      return convertWorkflow(file, metaNamed("sdxl-basic"));
    },
    too_many_nodes: () => convertWorkflow(instanced(50, 5), metaNamed("sdxl-basic")),
    too_deep: () =>
      convertWorkflow(nested(WORKFLOW_LIMITS.subgraphDepth + 1), metaNamed("sdxl-basic")),
    unknown_node: () => {
      const file = uiOf("sdxl-basic");
      nodeIn(file, 4).type = "MysteryLatent";
      nodeIn(file, 6).type = "MysteryDecode";
      // A muted node of an unknown class is dropped, never checked.
      nodeIn(file, 8).type = "MysteryPreview";
      nodeIn(file, 8).mode = 2;
      return convertWorkflow(file, metaNamed("sdxl-basic"));
    },
    dynamic_inputs: () => {
      const fixture = loadWorkflowFixture("qwen21-dynamic");
      const file = structuredClone(fixture.ui) as UiFile;
      const encoder = nodeIn(file, 3);
      encoder.inputs?.push({ name: "images.picture", type: "IMAGE", link: null });
      return convertWorkflow(file, metaOf(fixture));
    },
    widget_values_short: () => {
      const file = positionalOnly(uiOf("sdxl-basic"));
      nodeIn(file, 4).widgets_values = [1024, 1024];
      return convertWorkflow(file, metaNamed("sdxl-basic"));
    },
    subgraph_widgets: () => {
      const file = positionalOnly(uiOf("subgraph-promoted"));
      nodeIn(file, 9).widgets_values = ["a red door"];
      return convertWorkflow(file, metaNamed("subgraph-promoted"));
    },
    muted_dependency: () => {
      const file = uiOf("sdxl-basic");
      nodeIn(file, 1).mode = 2;
      return convertWorkflow(file, metaNamed("sdxl-basic"));
    },
    bypass_dependency: () => {
      const file = uiOf("bypass-mute");
      const lora = nodeIn(file, 9);
      // Bypassed with nothing of the MODEL type to pass through.
      lora.inputs = (lora.inputs ?? []).filter((input) => input.type !== "MODEL");
      return convertWorkflow(file, metaNamed("bypass-mute"));
    },
    unconnected_input: () => {
      const file = uiOf("sdxl-basic");
      const decode = nodeIn(file, 6);
      for (const input of decode.inputs ?? []) if (input.name === "vae") input.link = null;
      return convertWorkflow(file, metaNamed("sdxl-basic"));
    },
  };

  it("has a case for every conversion refusal", () => {
    expect(Object.keys(cases).sort()).toEqual([...CONVERT_REFUSALS].sort());
  });

  it.each(Object.entries(cases))("refuses %s", (code, run) => {
    expect(refusedWith(run())).toBe(code);
  });

  it("names every unknown class at once, and the nodes a refusal is about", () => {
    expect(cases.unknown_node()).toEqual({
      ok: false,
      refusal: { error: "unknown_node", nodes: ["MysteryLatent", "MysteryDecode"] },
    });
    expect(cases.widget_values_short()).toEqual({
      ok: false,
      refusal: { error: "widget_values_short", nodes: ["4"] },
    });
    expect(cases.unconnected_input()).toEqual({
      ok: false,
      refusal: { error: "unconnected_input", nodes: ["6"] },
    });
    expect(cases.dynamic_inputs()).toEqual({
      ok: false,
      refusal: { error: "dynamic_inputs", nodes: ["TextEncodeQwenImage21"] },
    });
  });

  it("refuses a dynamic group, whose saved form is unverified, as dynamic_inputs", () => {
    const meta = nodeMetaFrom(
      objectInfoSchema.parse({
        LoadLoraModel: {
          input: {
            required: {
              model: ["MODEL"],
              loras: [
                "COMFY_DYNAMICGROUP_V3",
                { template: { required: { strength: ["FLOAT", {}] } }, min: 0, max: 2 },
              ],
            },
          },
        },
      }),
    );
    const file: UiFile = {
      version: 0.4,
      nodes: [
        { id: 1, type: "LoadLoraModel", mode: 0, inputs: [], outputs: [], widgets_values: [] },
      ],
      links: [],
    };
    expect(refusedWith(convertWorkflow(file, meta))).toBe("dynamic_inputs");
  });

  it("does not treat an optional input left unconnected as a refusal", () => {
    const fixture = loadWorkflowFixture("qwen-text");
    const file = structuredClone(fixture.ui) as UiFile;
    for (const input of nodeIn(file, 3).inputs ?? []) if (input.name === "vae") input.link = null;
    const { graph } = converted(convertWorkflow(file, metaOf(fixture)));
    expect(graph["3"]?.inputs).not.toHaveProperty("vae");
  });

  it("refuses an API file or a malformed UI file as not_a_workflow", () => {
    const fixture = loadWorkflowFixture("sdxl-basic");
    expect(refusedWith(convertWorkflow(fixture.api, metaOf(fixture)))).toBe("not_a_workflow");
    const file = uiOf("sdxl-basic");
    file.links = [[1, 1, "x", 2, 0, "CLIP"]];
    expect(refusedWith(convertWorkflow(file, metaOf(fixture)))).toBe("not_a_workflow");
  });
});
