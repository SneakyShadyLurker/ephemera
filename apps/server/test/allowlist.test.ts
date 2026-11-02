import { readFileSync } from "node:fs";
import { MODEL_INPUT_EXCEPTIONS } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import {
  CURATED_NODE_CLASSES,
  createAllowlist,
  OUTPUT_CLASS,
  REFUSED_NODE_CLASSES,
  REFUSED_PATTERN,
} from "../src/comfyui/allowlist.ts";

const contexts = ["file", "import"] as const;

describe("the node allowlist", () => {
  const allowlist = createAllowlist([]);

  it.each(contexts)("admits the one output class, SaveImageWebsocket, in %s context", (context) => {
    expect(OUTPUT_CLASS).toBe("SaveImageWebsocket");
    expect(allowlist.allows(OUTPUT_CLASS, context)).toBe(true);
    expect(allowlist.why(OUTPUT_CLASS, context)).toBeUndefined();
  });

  it.each(["SaveImage", "SaveLatent", "PreviewAny", "MyCustomSave", "PreviewSomething"])(
    "refuses %s as a node that writes, in both contexts",
    (classType) => {
      for (const context of contexts) {
        expect(allowlist.allows(classType, context)).toBe(false);
        expect(allowlist.why(classType, context)).toBe("refused_writes");
      }
    },
  );

  it("admits LoadImage for server files and keeps it out of imported graphs", () => {
    expect(allowlist.allows("LoadImage", "file")).toBe(true);
    expect(allowlist.why("LoadImage", "file")).toBeUndefined();
    expect(allowlist.allows("LoadImage", "import")).toBe(false);
    expect(allowlist.why("LoadImage", "import")).toBe("reference_only");
  });

  it("refuses a class on no list as not allowed", () => {
    for (const context of contexts) {
      expect(allowlist.allows("MyNode", context)).toBe(false);
      expect(allowlist.why("MyNode", context)).toBe("not_allowed");
    }
  });

  it("admits a class of the extra list in both contexts", () => {
    const extended = createAllowlist(["MyNode"]);
    for (const context of contexts) {
      expect(extended.allows("MyNode", context)).toBe(true);
      expect(extended.why("MyNode", context)).toBeUndefined();
    }
  });

  it("lets the refused list and the pattern win over the extra list", () => {
    const extended = createAllowlist(["SaveImage", "LoadLatent", "MyCustomSave"]);
    for (const classType of ["SaveImage", "LoadLatent", "MyCustomSave"]) {
      expect(extended.allows(classType, "file")).toBe(false);
      expect(extended.why(classType, "file")).toBe("refused_writes");
    }
  });

  it("curates no class the pattern or the refused list would refuse, the output class aside", () => {
    expect(CURATED_NODE_CLASSES.has(OUTPUT_CLASS)).toBe(true);
    const patterned = [...CURATED_NODE_CLASSES].filter(
      (classType) => classType !== OUTPUT_CLASS && REFUSED_PATTERN.test(classType),
    );
    expect(patterned).toEqual([]);
    expect(
      [...REFUSED_NODE_CLASSES].filter((classType) => CURATED_NODE_CLASSES.has(classType)),
    ).toEqual([]);
  });

  it("admits every curated class in server files", () => {
    for (const classType of CURATED_NODE_CLASSES) {
      expect(allowlist.why(classType, "file")).toBeUndefined();
    }
  });

  it("names the ComfyUI source file above every group of curated classes", () => {
    const source = readFileSync(new URL("../src/comfyui/allowlist.ts", import.meta.url), "utf8");
    const body = /CURATED_NODE_CLASSES[^=]*= new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1];
    expect(body).toBeDefined();
    let file: string | undefined;
    const named: string[] = [];
    for (const line of (body ?? "").split("\n")) {
      const comment = /^\s*\/\/ (nodes\.py|(?:comfy_extras|custom_nodes)\/\S+)/.exec(line);
      if (comment) file = comment[1];
      const entry = /^\s*(?:"([^"]+)"|(OUTPUT_CLASS)),/.exec(line);
      const classType = entry?.[2] === undefined ? entry?.[1] : OUTPUT_CLASS;
      if (classType !== undefined) {
        expect(file, `${classType} has no source file comment`).toBeDefined();
        named.push(classType);
      }
    }
    expect(named.sort()).toEqual([...CURATED_NODE_CLASSES].sort());
  });

  it("names only curated classes in the model input exceptions", () => {
    for (const classType of Object.keys(MODEL_INPUT_EXCEPTIONS.files)) {
      expect(CURATED_NODE_CLASSES.has(classType)).toBe(true);
    }
  });
});
