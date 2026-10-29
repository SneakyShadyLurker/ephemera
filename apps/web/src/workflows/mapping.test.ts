import { describe, expect, it } from "vitest";
import { fileValue, mappingRows, otherNodes } from "./mapping.ts";
import { type Draft, INITIAL_PANEL, type PanelAction, panelReducer } from "./panel-state.ts";
import { testInspection } from "./test-inspection.ts";

const draftAfter = (output: string | undefined, ...actions: PanelAction[]): Draft => {
  const state = [
    { type: "read", request: 1, controller: new AbortController(), fileName: "f.json" } as const,
    { type: "parsed", request: 1, file: { fileName: "f.json", source: {} } } as const,
    {
      type: "inspected",
      request: 1,
      inspection: testInspection(output === undefined ? {} : { output }),
      target: { mode: "create", id: "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b" },
    } as const,
    ...actions,
  ].reduce(panelReducer, INITIAL_PANEL);
  if (!("draft" in state)) throw new Error("no draft");
  return state.draft;
};

describe("the mapping rows", () => {
  it("lists the four places with their targets, the file's values and what Ephemera does", () => {
    const rows = mappingRows(draftAfter("7"));
    expect(rows.map((row) => row.label)).toEqual([
      "Prompt",
      "Size and count",
      "Seed",
      "Image output",
    ]);
    expect(rows.map((row) => row.choice)).toEqual([null, null, null, null]);
    const [prompt, size, seed, output] = rows;
    expect(prompt).toMatchObject({
      targets: [{ title: "CLIP Text Encode", node: "2", inputs: ["text"] }],
      inFile: '"A candid photo of a woman in a harbour at dusk"',
      does: "Replaced by the card's image prompt.",
    });
    expect(size).toMatchObject({
      targets: [
        { title: "Empty Latent Image", node: "4", inputs: ["width", "height", "batch_size"] },
      ],
      inFile: "1024 x 1536, batch 4",
      does: "Set to 1024 x 1536 and the batch Ephemera asks for.",
    });
    expect(seed).toMatchObject({
      targets: [{ title: "KSampler", node: "5", inputs: ["seed"] }],
      inFile: "42",
      does: "Set for every batch.",
    });
    expect(output).toMatchObject({
      targets: [{ title: "Save Image", node: "7", inputs: [] }],
      inFile: null,
      does: "Now sends the picture to Ephemera instead of a file.",
    });
  });

  it("asks for the output while detection leaves it open, with a described Select", () => {
    const output = mappingRows(draftAfter(undefined))[3];
    expect(output?.targets).toEqual([]);
    expect(output?.choice).toEqual({
      place: "output",
      label: "Output node",
      ask: "Choose the output node",
      value: null,
      options: [
        { value: "7", title: "Save Image", description: "node 7, images" },
        { value: "8", title: "Preview Image", description: "node 8, images" },
      ],
    });
    const chosen = mappingRows(
      draftAfter(undefined, { type: "choose", place: "output", node: "8" }),
    )[3];
    expect(chosen?.choice?.value).toBe("8");
    expect(chosen?.targets).toEqual([{ title: "Preview Image", node: "8", inputs: [] }]);
  });

  it("describes prompt candidates by the first line of their text", () => {
    const draft = draftAfter("7");
    const unsettled: Draft = {
      ...draft,
      inspection: {
        ...draft.inspection,
        detection: {
          ...draft.inspection.detection,
          prompt: { ...draft.inspection.detection.prompt, chosen: null },
        },
      },
    };
    const prompt = mappingRows(unsettled)[0];
    expect(prompt?.choice?.label).toBe("Prompt node");
    expect(prompt?.choice?.options[0]).toEqual({
      value: "2",
      title: "CLIP Text Encode",
      description: 'node 2, text: "A candid photo of a woman in a harbour at dusk"',
    });
  });

  it("counts the nodes that keep their settings, without the mapped and left-out ones", () => {
    expect(otherNodes(draftAfter("7"))).toEqual([
      { id: "1", title: "Load Checkpoint", classType: "CheckpointLoaderSimple" },
      { id: "3", title: "Negative", classType: "CLIPTextEncode" },
      { id: "6", title: "VAE Decode", classType: "VAEDecode" },
    ]);
  });

  it("shows a list value's inner list and a link by its node", () => {
    const titles = new Map([["4", "Empty Latent Image"]]);
    expect(fileValue({ __value__: ["normal", "karras"] }, titles)).toBe("normal, karras");
    expect(fileValue(["4", 0], titles)).toBe("from Empty Latent Image (node 4)");
    expect(fileValue("", titles)).toBe("no text");
  });
});
