import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ROOT } from "./env.ts";
import { checkModels, PROVIDERS } from "./providers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

it("returns the listed model IDs sorted and once each, leaving out entries without a valid ID", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      data: [
        { id: "vendor/chat-small" },
        { id: "vendor/chat-large", owned_by: "vendor" },
        { id: "vendor/chat-small" },
        { id: "" },
        { id: 7 },
        { name: "no id" },
        null,
        "vendor/plain-string",
        { id: "x".repeat(201) },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await checkModels("https://api.example.com/v1/", "key")).toEqual({
    ok: true,
    models: ["vendor/chat-large", "vendor/chat-small"],
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/models");
});

it("treats an answer without a list as unexpected", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ models: [] }));
  expect(await checkModels("https://api.example.com/v1", undefined)).toEqual({
    ok: false,
    reason: "unexpected",
    status: 200,
  });
});
