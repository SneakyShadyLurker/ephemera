import { WORKFLOW_REFUSALS } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_COPY,
  FAMILY_HELP,
  fileRefusalText,
  INSPECT_BUSY,
  refusalText,
  SAVE_FULL,
  unchosenSummary,
} from "./copy.ts";

describe("refusal copy", () => {
  it.each(WORKFLOW_REFUSALS)("says what is wrong with %s and a way out", (code) => {
    const text = refusalText(code, []);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toMatch(/—|->|→/);
    // Only the refusals an API export fixes suggest it.
    expect(text.includes("API format")).toBe(code === "too_large" || code === "too_deep");
  });

  it("keeps the fixed sentences", () => {
    expect(refusalText("linked_prompt", ["Text (node 4)"])).toBe(
      "The prompt comes from another node that also feeds something else. Give the prompt its own text in ComfyUI and import again.",
    );
    expect(refusalText("too_large", [])).toBe(
      "This file is too large or too complex to import. Remove nodes, or export it in API format from ComfyUI.",
    );
  });

  it("names the nodes a refusal lists", () => {
    expect(refusalText("unconnected_input", ["KSampler (node 3)", "VAE Decode (node 8)"])).toBe(
      "A node lacks an input it needs: KSampler (node 3) and VAE Decode (node 8). Connect it in ComfyUI and import again.",
    );
    expect(refusalText("unknown_node", ["MyNode"])).toContain("MyNode");
  });

  it("refuses in the tab before any request", () => {
    expect(fileRefusalText("flux-portrait.json", { kind: "not_json" })).toBe(
      "flux-portrait.json is not a JSON file.",
    );
    expect(fileRefusalText("big.json", { kind: "too_large" })).toBe(refusalText("too_large", []));
  });
});

describe("panel copy", () => {
  it("counts the unchosen mappings in words", () => {
    expect(unchosenSummary(1)).toBe("Choose one mapping before saving.");
    expect(unchosenSummary(2)).toBe("Choose two mappings before saving.");
    expect(unchosenSummary(3)).toBe("Choose three mappings before saving.");
  });

  it("explains every blocked reason in plain words, the allowlist by its variable", () => {
    expect(BLOCKED_COPY.not_allowed).toContain("EPHEMERA_COMFYUI_EXTRA_NODES");
    expect(BLOCKED_COPY.refused_writes).toBe(
      "This node writes files or shows output in ComfyUI. Remove it in ComfyUI and import again.",
    );
    expect(BLOCKED_COPY.output_node).toBe(BLOCKED_COPY.refused_writes);
    expect(BLOCKED_COPY.reference_only).toBe(
      "This node loads a reference image, which imported workflows cannot use yet. Remove it in ComfyUI and import again.",
    );
  });

  it("helps with each family", () => {
    expect(FAMILY_HELP).toEqual({
      general: "General uses plain-language image prompts.",
      krea2: "Krea 2 prompts are written for Krea 2 models.",
      moss: "MOSS prompts are written for MOSS Image models.",
    });
    expect(INSPECT_BUSY).toBe("Another import is still being read. Try again in a moment.");
    expect(SAVE_FULL).toBe("24 workflows is the most Ephemera keeps. Delete one, then save.");
  });
});
