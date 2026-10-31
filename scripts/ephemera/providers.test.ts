import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "./env.ts";
import { PROVIDERS } from "./providers.ts";

it("offers the providers README § Model providers lists, at the same addresses", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Model providers"));
  const rows = [...section.matchAll(/^\| ([^|]+?) \| `([^`]+)` \|/gm)].map(([, name, url]) => ({
    name,
    baseUrl: url,
  }));
  expect(rows.length).toBeGreaterThan(0);
  expect(
    PROVIDERS.map(({ name, baseUrl }) => ({ name, baseUrl })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ),
  ).toEqual(rows.toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? "")));
});
