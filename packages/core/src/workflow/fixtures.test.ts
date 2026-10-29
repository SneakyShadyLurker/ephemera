import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadWorkflowFixtures,
  type WorkflowFixture,
  type WorkflowFixtureOutcome,
  withoutMeta,
} from "../../test-fixtures/workflows.ts";
import { apiGraphSchema } from "./graph.ts";

/*
 * The exported ComfyUI fixtures stay consistent with themselves: each set
 * loads, its API file is a graph Ephemera accepts, and `expect.json` maps
 * every API node to exactly one UI node (or subgraph inner node) without
 * assuming the ids are equal.
 */

const OK: WorkflowFixtureOutcome = { ok: true };

/** Each fixture and its expected outcome per format. */
const OUTCOMES: Record<string, { ui: WorkflowFixtureOutcome; api: WorkflowFixtureOutcome }> = {
  "bypass-mute": { ui: OK, api: OK },
  "flux-guidance": { ui: OK, api: OK },
  "hires-two-samplers": { ui: OK, api: OK },
  "qwen-edit-images": {
    ui: { ok: false, stage: "gate", code: "reference_only" },
    api: { ok: false, stage: "gate", code: "reference_only" },
  },
  "qwen-text": { ui: OK, api: OK },
  "qwen21-dynamic": {
    ui: { ok: false, stage: "gate", code: "reference_only" },
    api: { ok: false, stage: "gate", code: "reference_only" },
  },
  "reroute-primitive": { ui: OK, api: OK },
  "sdxl-basic": { ui: OK, api: OK },
  "sdxl-basic-v1": { ui: OK, api: OK },
  "subgraph-promoted": { ui: OK, api: OK },
};

/** Only what the mapping check reads from a UI file; everything else passes through. */
const uiNodeSchema = z.looseObject({ id: z.number(), type: z.string() });
const uiGraphSchema = z.looseObject({
  version: z.number(),
  nodes: z.array(uiNodeSchema),
  links: z.array(z.unknown()),
  definitions: z
    .looseObject({
      subgraphs: z.array(z.looseObject({ id: z.string(), nodes: z.array(uiNodeSchema) })),
    })
    .optional(),
});
type UiNode = z.infer<typeof uiNodeSchema>;

/** Every UI execution id with its node type: root ids, and `<instance>:<inner>` inside subgraphs. */
function uiExecutionIds(source: unknown): Map<string, string> {
  const ui = uiGraphSchema.parse(source);
  const definitions = new Map(
    (ui.definitions?.subgraphs ?? []).map((definition) => [definition.id, definition.nodes]),
  );
  const ids = new Map<string, string>();
  const visit = (nodes: UiNode[], prefix: string) => {
    for (const node of nodes) {
      const id = `${prefix}${node.id}`;
      ids.set(id, node.type);
      const inner = definitions.get(node.type);
      if (inner !== undefined) visit(inner, `${id}:`);
    }
  };
  visit(ui.nodes, "");
  return ids;
}

const apiClassTypes = (api: unknown): Map<string, string> =>
  new Map(
    Object.entries(apiGraphSchema.parse(withoutMeta(api))).map(([id, node]) => [
      id,
      node.class_type,
    ]),
  );

const sorted = (values: Iterable<string>) => [...values].sort();

describe("workflow fixtures", () => {
  const fixtures = loadWorkflowFixtures();

  it("loads every fixture set", () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual(sorted(Object.keys(OUTCOMES)));
  });

  describe.each(fixtures.map((fixture): [string, WorkflowFixture] => [fixture.name, fixture]))(
    "%s",
    (name, fixture) => {
      it("has an API file core accepts once `_meta` is dropped", () => {
        expect(apiGraphSchema.safeParse(withoutMeta(fixture.api)).success).toBe(true);
      });

      it("has a UI file in version 0.4 or 1 with nodes and links", () => {
        expect([0.4, 1]).toContain(uiGraphSchema.parse(fixture.ui).version);
      });

      it("maps every API node to one UI node of the same class", () => {
        const api = apiClassTypes(fixture.api);
        const ui = uiExecutionIds(fixture.ui);
        const mapping = Object.entries(fixture.expect.apiToUi);
        expect(sorted(mapping.map(([apiId]) => apiId))).toEqual(sorted(api.keys()));
        const uiIds = mapping.map(([, uiId]) => uiId);
        expect(new Set(uiIds).size).toBe(uiIds.length);
        for (const [apiId, uiId] of mapping) {
          expect(ui.get(uiId), `${apiId} -> ${uiId}`).toBe(api.get(apiId));
        }
      });

      it("accounts for every other UI node as omitted", () => {
        const ui = uiExecutionIds(fixture.ui);
        const mapped = Object.values(fixture.expect.apiToUi);
        const omitted = Object.keys(fixture.expect.omitted);
        expect(sorted([...mapped, ...omitted])).toEqual(sorted(ui.keys()));
      });

      it("has object_info for every API class", () => {
        const objectInfo = z.record(z.string(), z.unknown()).parse(fixture.objectInfo);
        for (const classType of new Set(apiClassTypes(fixture.api).values())) {
          expect(Object.hasOwn(objectInfo, classType), classType).toBe(true);
        }
      });

      it("carries its expected outcome per format", () => {
        expect({ ui: fixture.expect.ui, api: fixture.expect.api }).toEqual(OUTCOMES[name]);
      });
    },
  );
});
