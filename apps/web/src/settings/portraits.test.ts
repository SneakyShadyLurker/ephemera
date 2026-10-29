import { describe, expect, it } from "vitest";
import {
  deletedLine,
  EMPTY_WORKFLOWS,
  FAMILY_NAMES,
  listFailedLine,
  nodeCount,
  portraitStatusLabel,
  portraitStatusLine,
  renameProblem,
  WORKFLOWS_FULL,
  workflowStatus,
} from "./portraits.ts";

describe("the portrait status in Settings", () => {
  it("says plainly when portraits are off or ready", () => {
    expect(portraitStatusLine({ state: "off" })).toEqual({
      tone: "off",
      text: "Off. Add a ComfyUI address to make portraits for cards written with AI.",
      missing: null,
    });
    expect(portraitStatusLine({ state: "ready" })).toEqual({
      tone: "ready",
      text: "Ready. Cards written with AI get four portraits to choose from.",
      missing: null,
    });
  });

  it.each([
    ["unreachable", "Unavailable. ComfyUI did not answer at this address."],
    [
      "insecure",
      "Unavailable. A token is set, so the address must use https: the token is only sent over https.",
    ],
    [
      "unauthorized",
      "Unavailable. ComfyUI refused the token. Check COMFYUI_API_KEY in the server's environment.",
    ],
    ["not_ready", "Unavailable. The private worker answered but is not ready yet."],
    [
      "invalid_response",
      "Unavailable. Something answered at this address, but not the way ComfyUI does.",
    ],
  ] as const)("names why ComfyUI is unavailable: %s", (reason, text) => {
    expect(portraitStatusLine({ state: "unavailable", reason })).toEqual({
      tone: "problem",
      text,
      missing: null,
    });
  });

  it("lists the missing nodes and models by name", () => {
    expect(
      portraitStatusLine({
        state: "missing",
        nodes: ["ModelAttentionBackend"],
        models: ["qwen_image_vae.safetensors"],
      }),
    ).toEqual({
      tone: "problem",
      text: "Unavailable. ComfyUI lacks parts the chosen workflow needs.",
      missing: { nodes: ["ModelAttentionBackend"], models: ["qwen_image_vae.safetensors"] },
    });
  });

  it("has a short form for the create screen", () => {
    expect(portraitStatusLabel({ state: "ready" })).toBe("Portraits available");
    expect(portraitStatusLabel({ state: "off" })).toBe("Portraits off");
    expect(portraitStatusLabel({ state: "missing", nodes: [], models: ["a"] })).toBe(
      "Portraits unavailable",
    );
    expect(portraitStatusLabel({ state: "unavailable", reason: "unreachable" })).toBe(
      "Portraits unavailable",
    );
  });
});

describe("the workflows list in Settings", () => {
  it.each<[Parameters<typeof workflowStatus>[0], ReturnType<typeof workflowStatus>]>([
    ["checking", { tone: "unknown", words: "Checking", missing: null, reason: null }],
    ["failed", { tone: "off", words: "Unchecked", missing: null, reason: null }],
    [{ state: "off" }, { tone: "off", words: "Unchecked", missing: null, reason: null }],
    [{ state: "ready" }, { tone: "ready", words: "Ready", missing: null, reason: null }],
    [
      { state: "missing", nodes: ["TextEncodeMOSSImageEdit"], models: ["moss_v2.safetensors"] },
      {
        tone: "problem",
        words: "Missing requirements",
        missing: { nodes: ["TextEncodeMOSSImageEdit"], models: ["moss_v2.safetensors"] },
        reason: null,
      },
    ],
    [
      { state: "unavailable", reason: "unreachable" },
      {
        tone: "problem",
        words: "Unavailable",
        missing: null,
        reason: "ComfyUI did not answer at this address.",
      },
    ],
  ])("puts words beside every dot: %j", (status, row) => {
    expect(workflowStatus(status)).toEqual(row);
  });

  it.each([
    ["krea2", "Krea 2"],
    ["moss", "MOSS"],
    ["general", "General"],
  ] as const)("names the %s family as text", (family, name) => {
    expect(FAMILY_NAMES[family]).toBe(name);
  });

  it.each([
    [1, "1 node"],
    [38, "38 nodes"],
  ])("counts %i nodes", (nodes, text) => {
    expect(nodeCount(nodes)).toBe(text);
  });

  it.each([
    ["", "Give the workflow a name."],
    ["   ", "Give the workflow a name."],
    ["moss studio", "You already have a workflow called moss studio."],
    [" Moss Studio ", "You already have a workflow called Moss Studio."],
    ["Flux Dev Portrait", null],
    ["Moss Studio 2", null],
    ["a".repeat(64), null],
    ["a".repeat(65), "Keep the name to 64 characters."],
    ["Moss\u0007Studio", "Leave control characters out of the name."],
  ])("checks the new name %j against the list", (name, problem) => {
    expect(renameProblem(name, ["Moss Studio", "Krea 2 Gonzalomo"])).toBe(problem);
  });

  it("says once which workflow a deleted one in use falls back to", () => {
    expect(deletedLine("Flux Dev Portrait", "Krea 2 Gonzalomo")).toBe(
      "Flux Dev Portrait was deleted; back to Krea 2 Gonzalomo.",
    );
  });

  it("says why the list is full, empty or not refreshed", () => {
    expect(WORKFLOWS_FULL).toBe(
      "24 workflows is the most Ephemera keeps. Delete one to import another.",
    );
    expect(EMPTY_WORKFLOWS).toBe(
      "Nothing of yours yet. Import a workflow from ComfyUI and it appears here, ready to paint.",
    );
    expect(listFailedLine("Ephemera could not be reached")).toBe(
      "The list could not be refreshed: Ephemera could not be reached.",
    );
  });
});
