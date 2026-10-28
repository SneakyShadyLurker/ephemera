import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPEC_AREAS } from "../../e2e/areas.ts";
import { MATRIX_ROWS, type RowLabel, retentionRowPolicy } from "../../e2e/retention-matrix.ts";
import { parseFocusedSpecs } from "../../e2e/support/env.ts";

describe("focused e2e selection", () => {
  it("takes the whole suite when unset or empty", () => {
    for (const value of [undefined, "", ",,"]) {
      expect(parseFocusedSpecs(value)).toBeUndefined();
    }
  });

  it("preserves parallel, serial and page-wide spec selections", () => {
    expect(
      parseFocusedSpecs(
        "events.spec.ts,settings.spec.ts,personas.spec.ts,vast-lorebook.spec.ts,prompt-behavior.spec.ts,csp.spec.ts",
      ),
    ).toEqual([
      "events.spec.ts",
      "settings.spec.ts",
      "personas.spec.ts",
      "vast-lorebook.spec.ts",
      "prompt-behavior.spec.ts",
      "csp.spec.ts",
    ]);
  });

  it("ignores empty entries beside known filenames", () => {
    expect(parseFocusedSpecs("events.spec.ts,,csp.spec.ts,")).toEqual([
      "events.spec.ts",
      "csp.spec.ts",
    ]);
  });

  it("rejects an unknown filename even beside a known spec", () => {
    for (const value of ["typo.spec.ts", "events.spec.ts,typo.spec.ts"]) {
      expect(() => parseFocusedSpecs(value)).toThrow(
        "Unknown EPHEMERA_E2E_SPECS filenames: typo.spec.ts",
      );
    }
  });

  it("reports every unknown filename", () => {
    expect(() => parseFocusedSpecs("typo.spec.ts,events.spec.ts,other.spec.ts")).toThrow(
      "Unknown EPHEMERA_E2E_SPECS filenames: typo.spec.ts, other.spec.ts",
    );
  });
});

describe("retention gate row coverage", () => {
  const labels = Object.keys(MATRIX_ROWS) as RowLabel[];

  it("holds the rows of docs/ARCHITECTURE.md § Retention matrix", () => {
    const doc = readFileSync(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf8");
    const section = doc.slice(doc.indexOf("### Retention matrix"));
    const table = section.slice(section.indexOf("\n| Row") + 1).split("\n");
    const rows = table.slice(
      2,
      table.findIndex((line) => !line.startsWith("|")),
    );
    // The label column holds each row's canary label in backticks.
    const documented = rows.map((line) => line.split("|")[2]?.trim().replaceAll("`", ""));
    expect(documented.toSorted()).toEqual(labels.toSorted());
  });

  it("gives all 60 rows an existing, known producer spec", () => {
    expect(labels).toHaveLength(60);
    for (const { owner } of Object.values(MATRIX_ROWS)) {
      expect(Object.hasOwn(SPEC_AREAS, owner)).toBe(true);
      expect(existsSync(new URL(`../../e2e/${owner}`, import.meta.url))).toBe(true);
    }
  });

  it("fails when a selected producer omits a row's marker", () => {
    for (const label of labels) {
      expect(() =>
        retentionRowPolicy(label, [], [MATRIX_ROWS[label].owner, "csp.spec.ts"]),
      ).toThrow(`row did not run: ${MATRIX_ROWS[label].row}`);
    }
  });

  it("skips absent rows only when their producer was excluded", () => {
    for (const label of labels) {
      expect(retentionRowPolicy(label, [], ["csp.spec.ts"])).toBe("skip");
    }
  });

  it("fails on every missing marker in a full run", () => {
    for (const label of labels) {
      expect(() => retentionRowPolicy(label, [], undefined)).toThrow(
        `row did not run: ${MATRIX_ROWS[label].row}`,
      );
    }
  });

  it("scans a present marker even when its producer was excluded", () => {
    for (const label of labels) {
      expect(retentionRowPolicy(label, [label], ["csp.spec.ts"])).toBe("scan");
      expect(retentionRowPolicy(label, [label], undefined)).toBe("scan");
    }
  });

  it("requires selected parallel, serial and restart rows in a mixed focus", () => {
    const focus = parseFocusedSpecs(
      "retention.spec.ts,rework-retention.spec.ts,sheet-art-retention.spec.ts,restart.spec.ts,csp.spec.ts",
    );
    const markers = ["in", "rwok", "saok", "rst"];
    for (const label of ["in", "rwok", "saok", "rst"] as const) {
      expect(retentionRowPolicy(label, markers, focus)).toBe("scan");
      expect(() =>
        retentionRowPolicy(
          label,
          markers.filter((marker) => marker !== label),
          focus,
        ),
      ).toThrow(`row did not run: ${MATRIX_ROWS[label].row}`);
    }
    expect(retentionRowPolicy("crok", [], focus)).toBe("skip");
    expect(retentionRowPolicy("crrst", [], focus)).toBe("skip");
    expect(() => retentionRowPolicy("crrst", [], ["creator-retention.spec.ts"])).toThrow(
      "row did not run: creation drafts: server restart mid-generation",
    );
    expect(MATRIX_ROWS.rst.serverHops).toEqual(["S-repo"]);
    expect(MATRIX_ROWS.crrst.serverHops).toEqual(["S-repo"]);
  });
});
