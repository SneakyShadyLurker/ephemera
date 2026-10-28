import { describe, expect, it } from "vitest";
import { portraitStatusLabel, portraitStatusLine } from "./portraits.ts";

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
