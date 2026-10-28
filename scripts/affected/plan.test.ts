import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALWAYS_SPECS, AREAS, SOURCE_AREAS, SPEC_AREAS } from "../../e2e/areas.ts";
import { importersOf, usersOf } from "./graph.ts";
import { areasOf, isHub, specsFor } from "./plan.ts";

const ROOT = join(import.meta.dirname, "../..");
const onDisk = readdirSync(join(ROOT, "e2e")).filter((name) => name.endsWith(".spec.ts"));
const plan = (...changed: string[]) => specsFor(changed, changed);
const importers = importersOf(ROOT);
/** The plan as the runner makes it: with the source's real import graph. */
const graphed = (...changed: string[]) =>
  specsFor(changed, changed, [], (path) => usersOf(importers, path, isHub));

describe("the area tables", () => {
  it("place every spec file, and name none that is gone", () => {
    expect([...Object.keys(SPEC_AREAS), ...ALWAYS_SPECS].sort()).toEqual(onDisk.sort());
  });

  it("give every area a spec and a source path that exist", () => {
    for (const area of AREAS) {
      expect(
        Object.values(SPEC_AREAS).some((areas) => areas.includes(area)),
        area,
      ).toBe(true);
      expect(
        SOURCE_AREAS.some(([, areas]) => areas !== "all" && areas.includes(area)),
        area,
      ).toBe(true);
    }
    // A prefix names a folder, a file, or the start of file names in a folder.
    for (const [prefix] of SOURCE_AREAS) {
      const folder = prefix.endsWith("/") ? prefix : dirname(prefix);
      const found =
        existsSync(join(ROOT, prefix)) ||
        (existsSync(join(ROOT, folder)) &&
          readdirSync(join(ROOT, folder)).some((name) => join(folder, name).startsWith(prefix)));
      expect(found, prefix).toBe(true);
    }
  });
});

describe("the plan for a change", () => {
  it("runs nothing in a browser for prose, unit tests and tooling", () => {
    expect(plan("docs/PRODUCT.md")).toEqual([]);
    expect(plan("packages/core/src/creator/creator.test.ts", "scripts/cards/check.ts")).toEqual([]);
    expect(plan("e2e/areas.ts")).toEqual([]);
    expect(plan("vitest.config.ts")).toEqual([]);
  });

  it("takes the specs of the areas a source change serves, and the page-wide one", () => {
    expect(plan("apps/web/src/rework/tracked.ts")).toEqual([
      "csp.spec.ts",
      "rework-retention.spec.ts",
      "rework.spec.ts",
    ]);
    expect(plan("apps/server/src/creator.ts")).toEqual(
      expect.arrayContaining(["creator.spec.ts", "creator-retention.spec.ts", "rework.spec.ts"]),
    );
  });

  it("takes the library's specs and the lorebook's guards for a change to the library", () => {
    for (const path of [
      "apps/web/src/lorebooks/BookRow.tsx",
      "apps/web/src/routes/lorebooks.$id.tsx",
      "apps/server/src/lorebooks.ts",
      "apps/server/src/persistence/lorebooks.ts",
    ]) {
      expect(plan(path), path).toEqual(
        expect.arrayContaining(["lorebooks.spec.ts", "lorebook.spec.ts", "retention.spec.ts"]),
      );
    }
  });

  it("gives a nested path its closest owner", () => {
    expect(areasOf("packages/core/src/creator/rework/parse.ts")).toEqual(["rework"]);
    expect(areasOf("packages/core/src/creator/parse.ts")).toEqual(["creator", "rework"]);
  });

  it("follows the import graph to the areas of the code that uses a changed file", () => {
    // The Markdown renderer lives with the chat and also renders a created card.
    expect(graphed("apps/web/src/chat/Markdown.tsx")).toEqual(
      expect.arrayContaining(["chat.spec.ts", "creator.spec.ts"]),
    );
    // The creator's model choice is the rework composer's too.
    expect(graphed("apps/web/src/creator/Describe.tsx")).toEqual(
      expect.arrayContaining(["creator.spec.ts", "rework.spec.ts"]),
    );
    // A core module reaches the areas that import its names, through the package's index.
    const rework = graphed("packages/core/src/creator/rework/parse.ts");
    expect(rework).toEqual(expect.arrayContaining(["rework.spec.ts", "rework-retention.spec.ts"]));
    expect(rework).not.toContain("chat.spec.ts");
    // What the shell imports reaches the spec that visits every page.
    expect(graphed("apps/web/src/settings/settings.ts")).toEqual(
      expect.arrayContaining(["settings.spec.ts", "design.spec.ts", "rework.spec.ts"]),
    );
  });

  it("follows multiple importer hops to another area's specs", () => {
    const source = "apps/web/src/settings/settings.ts";
    const creator = "apps/web/src/creator/Describe.tsx";
    const rework = "apps/web/src/rework/Composer.tsx";
    const graph = new Map([
      [source, new Set([creator])],
      [creator, new Set([rework])],
    ]);
    expect(usersOf(graph, source, isHub)).toEqual([creator, rework]);
    expect(specsFor([source], [source], [], (path) => usersOf(graph, path, isHub))).toEqual(
      expect.arrayContaining(["settings.spec.ts", "creator.spec.ts", "rework.spec.ts"]),
    );
  });

  it("deduplicates diamond-shaped importer paths in sorted order", () => {
    const graph = new Map([
      ["source", new Set(["right", "left"])],
      ["left", new Set(["top"])],
      ["right", new Set(["top"])],
    ]);
    expect(usersOf(graph, "source", () => false)).toEqual(["left", "right", "top"]);
  });

  it("terminates importer cycles without returning the changed file", () => {
    const graph = new Map([
      ["source", new Set(["source", "middle"])],
      ["middle", new Set(["last"])],
      ["last", new Set(["source", "middle"])],
    ]);
    expect(usersOf(graph, "source", () => false)).toEqual(["last", "middle"]);
  });

  it("stops before hubs so their other consumers stay unselected", () => {
    const source = "apps/web/src/rework/tracked.ts";
    const unrelated = "apps/web/src/personas/Gallery.tsx";
    for (const hub of [
      "apps/web/src/app/query.ts",
      "apps/web/src/api.ts",
      "apps/web/src/routes/index.tsx",
    ]) {
      const graph = new Map([
        [source, new Set([hub])],
        [hub, new Set([unrelated])],
      ]);
      expect(usersOf(graph, source, isHub), hub).toEqual([]);
      expect(
        specsFor([source], [source], [], (path) => usersOf(graph, path, isHub)),
        hub,
      ).toEqual(plan(source));
    }
  });

  it("runs the specs about a change, not every spec that passes through its area", () => {
    // Opening a chat alone does not make the lorebook spec about its renderer.
    const chat = graphed("apps/web/src/chat/Markdown.tsx");
    expect(chat).not.toContain("lorebook.spec.ts");
    // Settings uses CardProse in its palette editor, which uses the same renderer.
    expect(chat).toContain("settings.spec.ts");
    // A guard is the main test of each area it guards.
    expect(plan("apps/web/src/signin/renewal.ts")).toEqual(
      expect.arrayContaining(["signin.spec.ts", "retention.spec.ts"]),
    );
  });

  it("takes direct and indirect users of a change, stopping before hubs", () => {
    for (const file of ["apps/web/src/chat/ChatScreen.tsx", "packages/core/src/prompt/macros.ts"]) {
      expect(usersOf(importers, file, isHub).filter(isHub), file).toEqual([]);
    }
    expect(usersOf(importers, "apps/web/src/chat/ChatScreen.tsx", () => false)).toEqual(
      expect.arrayContaining(["apps/web/src/routes/index.tsx"]),
    );
    expect(isHub("apps/web/src/api.ts")).toBe(true);
    expect(isHub("apps/web/src/app/query.ts")).toBe(true);
    expect(isHub("apps/web/src/app/Screen.tsx")).toBe(false);
  });

  it("takes the whole suite for a change to the shared query client", () => {
    expect(areasOf("apps/web/src/app/query.ts")).toBe("all");
    expect(graphed("apps/web/src/app/query.ts")).toBe("all");
  });

  it("keeps the guards of what a change protects", () => {
    // An import without an extension still ties a shared component to the screens that use it.
    expect(graphed("apps/web/src/components/ui/alert-dialog.tsx")).toEqual(
      expect.arrayContaining(["creator-retention.spec.ts", "retention.spec.ts"]),
    );
    // Accepted rework edits save through the sheets' autosave.
    expect(graphed("apps/web/src/sheet/autosave-controller.ts")).toContain(
      "rework-retention.spec.ts",
    );
    // The router's override keeps an open chat when a chunk fails to load.
    expect(graphed("apps/web/src/app/router-package.ts")).toContain("signin.spec.ts");
    // A hostile reply is rendered by the chat's Markdown.
    expect(graphed("apps/web/src/chat/Markdown.tsx")).toContain("hostile-entities.spec.ts");
  });

  it("gives the shell, the shared components and the stylesheet on their own to the design spec", () => {
    for (const path of [
      "apps/web/src/app/Screen.tsx",
      "apps/web/src/components/ui/popover.tsx",
      "apps/web/src/styles.css",
    ]) {
      expect(plan(path), path).toEqual(["csp.spec.ts", "design.spec.ts"]);
    }
  });

  it("takes the whole suite for the mock servers' own imports", () => {
    expect(plan("apps/server/test/fake-upstream.ts")).toBe("all");
    expect(plan("apps/server/test/fake-comfyui.ts")).toBe("all");
  });

  it("takes the whole suite for source no area owns", () => {
    for (const path of [
      "apps/web/src/api.ts",
      "apps/server/src/boundary.ts",
      "e2e/support/env.ts",
      "playwright.config.ts",
      "apps/web/src/brand-new/Thing.tsx",
    ]) {
      expect(plan(path), path).toBe("all");
    }
  });

  it("takes the whole suite when dependencies or the compiler's configuration change", () => {
    for (const path of ["bun.lock", "apps/web/package.json", "tsconfig.base.json"]) {
      expect(plan(path), path).toBe("all");
    }
  });

  it("runs a changed spec, a spec that imports a changed file, and no deleted one", () => {
    expect(plan("e2e/chat.spec.ts")).toEqual(["chat.spec.ts", "csp.spec.ts"]);
    expect(specsFor(["apps/server/test/image-fixtures.ts"], [], ["design.spec.ts"])).toEqual([
      "csp.spec.ts",
      "design.spec.ts",
    ]);
    // A spec that is gone took its retention rows with it.
    expect(specsFor(["e2e/old.spec.ts"], [])).toBe("all");
  });
});
