import { describe, expect, it } from "vitest";
import {
  addressAction,
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
} from "./pictures.ts";

describe("address remedies", () => {
  it.each<[Parameters<typeof addressAction>[0], ReturnType<typeof addressAction>]>([
    [undefined, null],
    ["checking", null],
    ["failed", null],
    [{ state: "off" }, "add"],
    [{ state: "ready" }, null],
    [{ state: "missing", nodes: [], models: [] }, null],
    [{ state: "unavailable", reason: "not_allowed" }, "edit"],
    [{ state: "unavailable", reason: "insecure" }, "edit"],
    [{ state: "unavailable", reason: "unreachable" }, "edit"],
    [{ state: "unavailable", reason: "invalid_response" }, "edit"],
    [{ state: "unavailable", reason: "unauthorized" }, null],
    [{ state: "unavailable", reason: "not_ready" }, null],
  ])("offers the remedy for %j", (status, action) => {
    expect(addressAction(status)).toBe(action);
  });
});

describe("the portrait status in Settings", () => {
  it("says plainly when portraits are off or ready", () => {
    expect(portraitStatusLine({ state: "off" })).toEqual({
      tone: "off",
      text: "Off. Add your picture server's address to make portraits for cards written with AI.",
      missing: null,
    });
    expect(portraitStatusLine({ state: "ready" })).toEqual({
      tone: "ready",
      text: "Ready. Cards written with AI get four portraits to choose from.",
      missing: null,
    });
  });

  it.each([
    [
      "unreachable",
      "Unavailable. The picture server did not answer at this address. Check that it runs and the address is right.",
    ],
    [
      "insecure",
      "Unavailable. This address must start with https, since this server sends its picture server a token. Change the address to https.",
    ],
    [
      "unauthorized",
      "Unavailable. The picture server refused this server's token. Its owner can check COMFYUI_API_KEY.",
    ],
    [
      "not_ready",
      "Unavailable. The picture server answered but is not ready yet. Try again in a moment.",
    ],
    [
      "invalid_response",
      "Unavailable. Something answered at this address, but not as a ComfyUI picture server does. Check the address.",
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
      text: "Unavailable. The picture server lacks parts the chosen workflow needs: install them, or choose another workflow.",
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
    ["failed", { tone: "off", words: "Couldn't check", missing: null, reason: null }],
    [{ state: "off" }, { tone: "off", words: "No address", missing: null, reason: null }],
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
        reason:
          "The picture server did not answer at this address. Check that it runs and the address is right.",
      },
    ],
  ])("puts words beside every dot: %j", (status, row) => {
    expect(workflowStatus(status)).toEqual(row);
  });

  it.each([
    ["krea2", "Krea 2"],
    ["moss", "MOSS"],
    ["h3", "MiniMax H3"],
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
