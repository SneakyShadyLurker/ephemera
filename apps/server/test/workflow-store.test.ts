import { Database } from "bun:sqlite";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storedWorkflowSchema,
  userWorkflowId,
  WORKFLOW_LIMITS,
  type WorkflowFields,
  workflowSummarySchema,
} from "@ephemera/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
  type Stores,
} from "../src/persistence/index.ts";

const DEFAULT = "krea2-fixture";

const graph = (nodes = 1): WorkflowFields["graph"] =>
  Object.fromEntries(
    Array.from({ length: nodes }, (_, index) => [
      String(index + 1),
      { class_type: "SaveImage", inputs: { filename_prefix: "ephemera" } },
    ]),
  );

const fields = (name: string, nodes = 1): WorkflowFields => ({
  name,
  family: "general",
  graph: graph(nodes),
});

function fresh(): { stores: Stores; client: Database } {
  const database = openUserDatabase(undefined);
  return {
    stores: createStores(database.db, createMemoryPortraitFiles(), { defaultWorkflow: DEFAULT }),
    client: database.client,
  };
}

describe("workflow store", () => {
  let s: Stores;
  let client: Database;
  beforeEach(() => {
    ({ stores: s, client } = fresh());
  });

  it("creates under the client's id, and a repeat of the same create is a no-op", () => {
    const id = crypto.randomUUID();
    expect(s.workflows.create(fields("  Portrait  ", 2), id)).toBe("created");
    expect(s.workflows.create(fields("Portrait", 2), id)).toBe("created");
    const stored = storedWorkflowSchema.parse(s.workflows.get(id));
    expect(stored).toMatchObject({ id, name: "Portrait", family: "general", revision: 0 });
    expect(Object.keys(stored.graph)).toEqual(["1", "2"]);
    expect(s.workflows.list()).toHaveLength(1);
  });

  it("refuses a name that differs only in case", () => {
    s.workflows.create(fields("Portrait"), crypto.randomUUID());
    expect(s.workflows.create(fields("PORTRAIT"), crypto.randomUUID())).toBe("name_taken");
    expect(s.workflows.list()).toHaveLength(1);
  });

  it("refuses the create past the per-user limit, but not a repeat of one stored", () => {
    const first = crypto.randomUUID();
    s.workflows.create(fields("Workflow 0"), first);
    for (let index = 1; index < WORKFLOW_LIMITS.workflows; index++) {
      expect(s.workflows.create(fields(`Workflow ${index}`), crypto.randomUUID())).toBe("created");
    }
    expect(s.workflows.create(fields("One more"), crypto.randomUUID())).toBe("full");
    expect(s.workflows.create(fields("Workflow 0"), first)).toBe("created");
    expect(s.workflows.list()).toHaveLength(WORKFLOW_LIMITS.workflows);
  });

  it("parses every write with the core schema", () => {
    expect(() => s.workflows.create(fields(""), crypto.randomUUID())).toThrow();
    expect(() => s.workflows.create(fields("Portrait"), "not-a-uuid")).toThrow();
    expect(() =>
      s.workflows.create({ ...fields("Portrait"), graph: {} }, crypto.randomUUID()),
    ).toThrow();
    expect(s.workflows.list()).toEqual([]);
  });

  it("lists summaries by name, case-insensitively, without the graph", () => {
    const id = crypto.randomUUID();
    s.workflows.create(fields("beta", 3), id);
    s.workflows.create(fields("Alpha"), crypto.randomUUID());
    s.workflows.create(fields("gamma"), crypto.randomUUID());
    const list = s.workflows.list();
    expect(list.map((row) => row.name)).toEqual(["Alpha", "beta", "gamma"]);
    for (const row of list) {
      expect(workflowSummarySchema.parse(row)).toEqual(row);
      expect(row).not.toHaveProperty("graph");
    }
    expect(list[1]).toMatchObject({ id, nodes: 3, revision: 0 });
  });

  it("never reads the graph column for the list", () => {
    s.workflows.create(fields("Portrait"), crypto.randomUUID());
    // A graph column that cannot be read as JSON would throw if the list selected it.
    client.run("UPDATE workflows SET graph = 'not json'");
    expect(s.workflows.list().map((row) => row.name)).toEqual(["Portrait"]);
  });

  it("edits the name and family at the current revision, and answers a stale retry", () => {
    const id = crypto.randomUUID();
    s.workflows.create(fields("Portrait"), id);
    const renamed = s.workflows.update(id, { name: "Scene", family: "moss" }, 0);
    expect(renamed).toMatchObject({
      status: "updated",
      value: { name: "Scene", family: "moss", revision: 1 },
    });
    expect(s.workflows.update(id, { name: "Other" }, 0)).toEqual({
      status: "conflict",
      revision: 1,
    });
    expect(s.workflows.update(id, { name: "Scene", family: "moss" }, 0)).toMatchObject({
      status: "updated",
      value: { name: "Scene", revision: 1 },
    });
    expect(s.workflows.update(crypto.randomUUID(), { name: "Gone" }, 0)).toEqual({
      status: "missing",
    });
  });

  it("refuses a rename onto another workflow's name, but not onto its own in another case", () => {
    const id = crypto.randomUUID();
    s.workflows.create(fields("Portrait"), id);
    s.workflows.create(fields("Scene"), crypto.randomUUID());
    expect(s.workflows.update(id, { name: "scene" }, 0)).toBe("name_taken");
    expect(s.workflows.update(id, { name: "PORTRAIT" }, 0)).toMatchObject({
      status: "updated",
      value: { name: "PORTRAIT", revision: 1 },
    });
  });

  it("cannot change the graph through a metadata edit", () => {
    const id = crypto.randomUUID();
    s.workflows.create(fields("Portrait"), id);
    expect(() =>
      s.workflows.update(
        id,
        {
          name: "Portrait",
          // @ts-expect-error the metadata edit takes no graph
          graph: graph(5),
        },
        0,
      ),
    ).toThrow();
    expect(Object.keys(s.workflows.get(id)?.graph ?? {})).toEqual(["1"]);
    expect(s.workflows.get(id)?.revision).toBe(0);
  });

  it("replaces the graph at the current revision with its node count", () => {
    const id = crypto.randomUUID();
    s.workflows.create(fields("Portrait"), id);
    const before = s.workflows.get(id)?.updatedAt ?? 0;
    const replaced = s.workflows.replaceGraph(id, graph(4), 0);
    expect(replaced).toMatchObject({ status: "updated", value: { name: "Portrait", revision: 1 } });
    expect(Object.keys(s.workflows.get(id)?.graph ?? {})).toHaveLength(4);
    expect(s.workflows.list()[0]).toMatchObject({ nodes: 4, revision: 1 });
    expect(s.workflows.get(id)?.updatedAt).toBeGreaterThanOrEqual(before);

    expect(s.workflows.replaceGraph(id, graph(2), 0)).toEqual({ status: "conflict", revision: 1 });
    expect(s.workflows.replaceGraph(id, graph(4), 0)).toMatchObject({
      status: "updated",
      value: { revision: 1 },
    });
    expect(() => s.workflows.replaceGraph(id, {}, 1)).toThrow();
    expect(s.workflows.list()[0]).toMatchObject({ nodes: 4, revision: 1 });
  });

  it("removes a workflow and returns the settings that named it to the default", () => {
    const id = crypto.randomUUID();
    s.workflows.create(fields("Portrait"), id);
    expect(s.settings.update({ comfyuiWorkflow: userWorkflowId(id) })?.comfyuiWorkflow).toBe(
      userWorkflowId(id),
    );
    expect(s.workflows.remove(id)).toBe(true);
    expect(s.workflows.get(id)).toBeUndefined();
    expect(s.settings.get().comfyuiWorkflow).toBe(DEFAULT);
    expect(s.workflows.remove(id)).toBe(false);
  });

  it("leaves the settings alone when removing a workflow they do not name", () => {
    const kept = crypto.randomUUID();
    const other = crypto.randomUUID();
    s.workflows.create(fields("Portrait"), kept);
    s.workflows.create(fields("Scene"), other);
    s.settings.update({ comfyuiWorkflow: userWorkflowId(kept) });
    const before = client.query("SELECT updated_at FROM settings WHERE id = 1").get();
    expect(s.workflows.remove(other)).toBe(true);
    expect(s.settings.get().comfyuiWorkflow).toBe(userWorkflowId(kept));
    expect(client.query("SELECT updated_at FROM settings WHERE id = 1").get()).toEqual(before);
  });
});

describe("workflows migration", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("applies on a database from before it, with references intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ephemera-workflows-"));
    dirs.push(dir);
    const source = join(import.meta.dirname, "../drizzle");
    await mkdir(join(dir, "meta"), { recursive: true });
    for (const file of await readdir(source)) {
      if (file.endsWith(".sql")) await copyFile(join(source, file), join(dir, file));
    }
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    const last = journal.entries.at(-1);
    expect(last.tag).toMatch(/workflows/);
    journal.entries = journal.entries.slice(0, -1);
    await writeFile(join(dir, "meta/_journal.json"), JSON.stringify(journal));

    const old = new Database(":memory:", { strict: true });
    migrate(drizzle({ client: old }), { migrationsFolder: dir });
    old
      .query(
        "INSERT INTO settings (id, theme, comfyui_workflow, updated_at) VALUES (1, 'dark', 'krea2-moss', 1)",
      )
      .run();
    const upgraded = openUserDatabase(old.serialize());
    old.close();
    expect(upgraded.client.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const stores = createStores(upgraded.db, createMemoryPortraitFiles(), {
      defaultWorkflow: DEFAULT,
    });
    expect(stores.settings.get().comfyuiWorkflow).toBe("krea2-moss");
    const id = crypto.randomUUID();
    expect(stores.workflows.create(fields("Portrait"), id)).toBe("created");
    expect(stores.workflows.create(fields("portrait"), crypto.randomUUID())).toBe("name_taken");
  });
});
