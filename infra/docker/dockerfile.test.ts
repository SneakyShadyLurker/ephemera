import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const root = join(import.meta.dirname, "../..");
const dockerfile = readFileSync(join(import.meta.dirname, "Dockerfile"), "utf8");
const arg = (name: string) => new RegExp(`^ARG ${name}=(.+)$`, "m").exec(dockerfile)?.[1];

test("the image's Bun is the version the repository's types describe", () => {
  const manifest = z
    .object({ devDependencies: z.object({ "@types/bun": z.string() }) })
    .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  expect(arg("BUN_VERSION")).toBe(manifest.devDependencies["@types/bun"]);
});

test("every stage starts from the one pinned base image or an earlier stage", () => {
  expect(arg("BUN_DIGEST")).toMatch(/^sha256:[0-9a-f]{64}$/);
  const pinned = /^oven\/bun:\$\{BUN_VERSION\}-\$\{BUN_VARIANT\}@\$\{BUN_DIGEST\}$/;
  const stages: string[] = [];
  for (const line of dockerfile.split("\n").filter((text) => text.startsWith("FROM "))) {
    const [, image = "", , name = ""] = line.split(/\s+/);
    if (!stages.includes(image)) expect(image).toMatch(pinned);
    stages.push(name);
  }
  expect(stages).toContain("runtime");
});
