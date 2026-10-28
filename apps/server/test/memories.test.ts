import { Database } from "bun:sqlite";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankCard, type MemoryOutput, settingsSchema } from "@ephemera/core";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/persistence/db.ts";
import {
  createMemoryPortraitFiles,
  createStores,
  openUserDatabase,
} from "../src/persistence/index.ts";

function setup() {
  const stores = createStores(openUserDatabase(undefined).db, createMemoryPortraitFiles());
  const characterId = stores.characters.create(blankCard("Maren"));
  return { stores, memory: stores.memory, characterId };
}

const output = (title: string, situation = "At the harbour.", opening = ""): MemoryOutput => ({
  title,
  summary: `${title} happened.`,
  cues: ["harbour"],
  notebook: {
    situation,
    relationships: ["Maren and Ash: friends since the regatta."],
    facts: ["Maren owns a boat."],
    threads: [],
    cast: [],
  },
  opening,
});

const OPENING = "> Location: The harbour, dusk\n\nMaren coils a rope beside {{user}} on the quay.";

describe("memory store", () => {
  it("migrates pre-cast notebook rows to an empty list and isolates remembered anchors", async () => {
    const migrations = await mkdtemp(join(tmpdir(), "ephemera-pre-cast-"));
    const first = new Database(":memory:", { strict: true });
    const id = crypto.randomUUID();
    let image: Uint8Array;
    try {
      const source = join(import.meta.dirname, "../drizzle");
      const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8")) as {
        entries: { idx: number; tag: string }[];
      };
      // 0022 adds notebook cast; later migrations must never enter this historical fixture.
      journal.entries = journal.entries.filter((entry) => entry.idx < 22);
      await mkdir(join(migrations, "meta"));
      await writeFile(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries)
        await copyFile(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
      const db = migrateDatabase(first, migrations);
      createStores(db, createMemoryPortraitFiles()).characters.create(
        blankCard("Maren"),
        undefined,
        id,
      );
      const notebook = output("A").notebook;
      first
        .query(
          "INSERT INTO memory_notebooks (character_id, enabled, situation, relationships, facts, threads, revision, updated_at) VALUES (?, 1, ?, ?, ?, ?, 1, 1)",
        )
        .run(
          id,
          notebook.situation,
          JSON.stringify(notebook.relationships),
          JSON.stringify(notebook.facts),
          JSON.stringify(notebook.threads),
        );
      image = first.serialize();
    } finally {
      first.close(true);
      await rm(migrations, { recursive: true, force: true });
    }
    const reopened = openUserDatabase(image);
    const memory = createStores(reopened.db, createMemoryPortraitFiles()).memory;
    expect(memory.state(id)?.notebook).toEqual(output("A").notebook);
    const cast = [JSON.stringify({ name: "Ilse Brandt", gender: "female" })];
    const next = { ...output("B"), notebook: { ...output("B").notebook, cast } };
    memory.remember(id, { output: next, turns: 2, notebookRevision: 1 });
    expect(memory.state(id)?.notebook.cast).toEqual(cast);
    const anotherUser = setup();
    expect(anotherUser.memory.state(id)).toBeUndefined();
    expect(anotherUser.memory.list(id)).toEqual([]);
    memory.setState(id, { enabled: false }, 2);
    expect(memory.state(id)?.notebook.cast).toEqual(cast);
    expect(memory.remember(id, { output: next, turns: 2, notebookRevision: 3 })).toBe("off");
    memory.forget(id);
    expect(memory.state(id)?.notebook.cast).toEqual([]);
    expect(memory.state(id)?.enabled).toBe(false);
    reopened.close();
  });

  it("stores the notebook's cast, empties it explicitly, and deletes it with the character", () => {
    const { memory, stores, characterId } = setup();
    const cast = [JSON.stringify({ name: "Ilse", gender: "female" }), "unfinished {"];
    memory.setState(characterId, { notebook: { ...output("A").notebook, cast } }, 0);
    expect(memory.state(characterId)?.notebook.cast).toEqual(cast);
    memory.setState(characterId, { notebook: { ...output("B").notebook, cast: [] } }, 1);
    expect(memory.state(characterId)?.notebook.cast).toEqual([]);
    stores.characters.remove(characterId);
    expect(memory.state(characterId)).toBeUndefined();
  });
  it("reads a character without a notebook row as on, and creates the row with the first write", () => {
    const { memory, characterId } = setup();
    expect(memory.state(characterId)).toBeUndefined();
    // Turning it off creates the row, off, as the first edit of a row at revision 0.
    expect(memory.setState(characterId, { enabled: false }, 0)).toMatchObject({
      status: "updated",
      value: { enabled: false, notebook: { situation: "", facts: [], threads: [] }, revision: 1 },
    });
    expect(
      memory.remember(characterId, { output: output("A"), turns: 2, notebookRevision: 1 }),
    ).toBe("off");
    // Back on: the opt-out round trip.
    expect(memory.setState(characterId, { enabled: true }, 1)).toMatchObject({
      status: "updated",
      value: { enabled: true, revision: 2 },
    });
    expect(memory.state(characterId)?.enabled).toBe(true);
    expect(memory.setState(crypto.randomUUID(), { enabled: false }, 0)).toEqual({
      status: "missing",
    });
  });

  it("answers a stale patch against a character without a row as revision 0 would", () => {
    const { memory, characterId } = setup();
    // Nothing to change: answered as saved, and still no row.
    expect(memory.setState(characterId, { enabled: true }, 3).status).toBe("updated");
    expect(memory.state(characterId)).toBeUndefined();
    expect(memory.setState(characterId, { enabled: false }, 3)).toEqual({
      status: "conflict",
      revision: 0,
    });
    expect(memory.state(characterId)).toBeUndefined();
  });

  it("resolves the first notebook edit racing the first memory, edit first, without a lost update", () => {
    const { memory, characterId } = setup();
    const owner = {
      situation: "Owner's words.",
      relationships: [],
      facts: [],
      threads: [],
      cast: [],
    };
    expect(memory.setState(characterId, { notebook: owner }, 0)).toMatchObject({
      status: "updated",
      value: { enabled: true, notebook: owner, revision: 1 },
    });
    // The memory call read the notebook at revision 0: its episode is written, the owner's edit stays.
    const result = memory.remember(characterId, {
      output: output("A"),
      turns: 2,
      notebookRevision: 0,
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.notebook).toMatchObject({ notebook: owner, revision: 1 });
    expect(memory.list(characterId)).toHaveLength(1);
  });

  it("resolves the first memory racing the first notebook edit, memory first, without a lost update", () => {
    const { memory, characterId } = setup();
    const result = memory.remember(characterId, {
      output: output("A"),
      turns: 2,
      notebookRevision: 0,
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.notebook).toMatchObject({
      enabled: true,
      notebook: { situation: "At the harbour." },
      revision: 1,
    });
    // The owner's edit made against revision 0 is refused, not written over the memory's notebook.
    const owner = {
      situation: "Owner's words.",
      relationships: [],
      facts: [],
      threads: [],
      cast: [],
    };
    expect(memory.setState(characterId, { notebook: owner }, 0)).toEqual({
      status: "conflict",
      revision: 1,
    });
    expect(memory.state(characterId)?.notebook.situation).toBe("At the harbour.");
  });

  it("writes episodes in seq order and the notebook with them", () => {
    const { memory, characterId } = setup();
    const first = memory.remember(characterId, {
      output: output("A"),
      turns: 4,
      notebookRevision: 0,
    });
    if (typeof first === "string") throw new Error(first);
    expect(first.episode).toMatchObject({ seq: 0, kind: "episode", turns: 4, chapterId: null });
    expect(first.notebook).toMatchObject({
      revision: 1,
      notebook: { situation: "At the harbour." },
    });
    const second = memory.remember(characterId, {
      output: output("B", "At sea."),
      turns: 6,
      notebookRevision: 1,
    });
    if (typeof second === "string") throw new Error(second);
    expect(second.episode.seq).toBe(1);
    expect(memory.list(characterId).map((episode) => episode.title)).toEqual(["A", "B"]);
    expect(memory.state(characterId)?.notebook.situation).toBe("At sea.");
  });

  it("writes nothing once memory is off", () => {
    const { memory, characterId } = setup();
    memory.setState(characterId, { enabled: false }, 0);
    expect(
      memory.remember(characterId, { output: output("A"), turns: 2, notebookRevision: 1 }),
    ).toBe("off");
    expect(memory.list(characterId)).toEqual([]);
  });

  it("writes a chapter and marks its members", () => {
    const { memory, characterId } = setup();
    const ids = ["A", "B", "C"].map((title, index) => {
      const result = memory.remember(characterId, {
        output: output(title),
        turns: 2 + index,
        notebookRevision: index,
      });
      if (typeof result === "string") throw new Error(result);
      return result.episode.id;
    });
    const read = () =>
      memory.list(characterId).map(({ id, revision, chapterId }) => ({ id, revision, chapterId }));
    const [first, second] = read();
    if (first === undefined || second === undefined) throw new Error("no episodes");
    // A member edited since it was read, or gone, refuses the chapter.
    const edited = memory.update(first.id, { pinned: true }, first.revision);
    expect(edited.status).toBe("updated");
    const part = { title: "Part one", summary: "A and B.", cues: ["harbour"] };
    expect(memory.chapter(characterId, { output: part, members: [first, second] })).toBe("stale");
    expect(
      memory.chapter(characterId, {
        output: part,
        members: [second, { id: crypto.randomUUID(), revision: 0, chapterId: null }],
      }),
    ).toBe("stale");
    // Nothing was written.
    expect(memory.list(characterId)).toHaveLength(3);
    const chapter = memory.chapter(characterId, {
      output: part,
      members: read().filter((episode) => ids.slice(0, 2).includes(episode.id)),
    });
    if (typeof chapter === "string") throw new Error(chapter);
    expect(chapter).toMatchObject({ kind: "chapter", seq: 3, turns: 5, chapterId: null });
    expect(memory.list(characterId).map((episode) => episode.chapterId)).toEqual([
      chapter.id,
      chapter.id,
      null,
      null,
    ]);
    // A member a chapter already holds is not merged again.
    expect(
      memory.chapter(characterId, {
        output: { title: "X", summary: "Y.", cues: [] },
        members: read().filter((episode) => ids.slice(0, 2).includes(episode.id)),
      }),
    ).toBe("stale");
    // Deleting the chapter frees its members.
    expect(memory.remove(chapter.id)).toBe(true);
    expect(memory.list(characterId).map((episode) => episode.chapterId)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("refuses stale edits that change something and answers stale retries as saved", () => {
    const { memory, characterId } = setup();
    const written = memory.remember(characterId, {
      output: output("A"),
      turns: 2,
      notebookRevision: 0,
    });
    if (typeof written === "string") throw new Error(written);
    const { id } = written.episode;
    const saved = memory.update(id, { title: "Renamed", pinned: true }, 0);
    expect(saved).toMatchObject({ status: "updated", value: { title: "Renamed", revision: 1 } });
    expect(memory.update(id, { title: "Renamed" }, 0)).toMatchObject({ status: "updated" });
    expect(memory.update(id, { title: "Other" }, 0)).toEqual({ status: "conflict", revision: 1 });
    expect(memory.update(crypto.randomUUID(), { title: "X" }, 0)).toEqual({ status: "missing" });
    expect(memory.setState(characterId, { enabled: false }, 0)).toEqual({
      status: "conflict",
      revision: 1,
    });
    expect(memory.setState(characterId, { enabled: true }, 0).status).toBe("updated");
  });

  it("forgets everything but the choice of on or off, and goes with its character", () => {
    const { stores, memory, characterId } = setup();
    // No row: forgetting writes nothing, and memory stays on.
    expect(memory.forget(characterId)).toBe(true);
    expect(memory.state(characterId)).toBeUndefined();
    expect(memory.forget(crypto.randomUUID())).toBe(false);

    memory.remember(characterId, { output: output("A"), turns: 2, notebookRevision: 0 });
    expect(memory.forget(characterId)).toBe(true);
    expect(memory.list(characterId)).toEqual([]);
    // On stays on; the notebook is empty and its revision moves, so an editor open before is stale.
    expect(memory.state(characterId)).toMatchObject({
      enabled: true,
      notebook: { situation: "", facts: [], threads: [] },
      revision: 2,
    });

    // Off stays off.
    memory.setState(characterId, { enabled: false }, 2);
    memory.forget(characterId);
    expect(memory.state(characterId)).toMatchObject({ enabled: false, revision: 4 });
    memory.setState(characterId, { enabled: true }, 4);

    const written = memory.remember(characterId, {
      output: output("B"),
      turns: 2,
      notebookRevision: 5,
    });
    if (typeof written === "string") throw new Error(written);
    expect(stores.characters.remove(characterId)).toBe(true);
    expect(memory.state(characterId)).toBeUndefined();
    expect(memory.get(written.episode.id)).toBeUndefined();
  });

  it("keeps the next chat's opening beside the notebook: written, edited and forgotten with it", () => {
    const { memory, characterId } = setup();
    // The row's first write gives it no opening.
    expect(memory.setState(characterId, { enabled: true }, 0)).toMatchObject({
      status: "updated",
      value: { opening: "", revision: 1 },
    });
    const written = memory.remember(characterId, {
      output: output("A", "At the harbour.", OPENING),
      turns: 2,
      notebookRevision: 1,
    });
    if (typeof written === "string") throw new Error(written);
    expect(written.notebook).toMatchObject({ opening: OPENING, revision: 2 });
    expect(memory.state(characterId)?.opening).toBe(OPENING);

    // An opening alone moves the revision and leaves the notebook.
    const notebook = memory.state(characterId)?.notebook;
    expect(memory.setState(characterId, { opening: "Ashore." }, 2)).toMatchObject({
      status: "updated",
      value: { opening: "Ashore.", notebook, revision: 3 },
    });
    // A patch without one leaves the stored one.
    const edited = {
      situation: "Ashore now.",
      relationships: [],
      facts: [],
      threads: [],
      cast: [],
    };
    expect(memory.setState(characterId, { notebook: edited }, 3)).toMatchObject({
      status: "updated",
      value: { opening: "Ashore.", notebook: edited, revision: 4 },
    });
    // A stale retry of the same opening is answered as saved; another one is a conflict.
    expect(memory.setState(characterId, { opening: "Ashore." }, 2).status).toBe("updated");
    expect(memory.setState(characterId, { opening: "Elsewhere." }, 2)).toEqual({
      status: "conflict",
      revision: 4,
    });

    // A memory that read an older revision leaves the owner's opening, as it leaves the notebook.
    const late = memory.remember(characterId, {
      output: output("B", "At sea.", OPENING),
      turns: 2,
      notebookRevision: 3,
    });
    if (typeof late === "string") throw new Error(late);
    expect(late.notebook).toMatchObject({ opening: "Ashore.", revision: 4 });
    // A memory without an opening empties it.
    const none = memory.remember(characterId, {
      output: output("C"),
      turns: 2,
      notebookRevision: 4,
    });
    if (typeof none === "string") throw new Error(none);
    expect(none.notebook).toMatchObject({ opening: "", revision: 5 });

    // Deleting one memory leaves it; forgetting everything empties it, on staying on.
    memory.setState(characterId, { opening: OPENING }, 5);
    expect(memory.remove(none.episode.id)).toBe(true);
    expect(memory.state(characterId)?.opening).toBe(OPENING);
    expect(memory.forget(characterId)).toBe(true);
    expect(memory.state(characterId)).toMatchObject({ enabled: true, opening: "", revision: 7 });
  });

  it("refuses an output past the core schema", () => {
    const { memory, characterId } = setup();
    expect(() =>
      memory.remember(characterId, {
        output: { ...output("A"), title: "" },
        turns: 2,
        notebookRevision: 0,
      }),
    ).toThrow();
  });

  it("keeps the memory settings with core's defaults", () => {
    const { stores } = setup();
    const settings = settingsSchema.parse(stores.settings.get());
    expect(settings).toMatchObject({
      memoryModel: null,
      memoryReasoning: null,
      memorySpanTokens: 6_000,
      memoryKeepTurns: 4,
      // Automatic: the call's window sets the recap budget until the owner caps it.
      memoryRecapTokens: null,
    });
    expect(stores.settings.update({ memoryModel: "m", memoryRecapTokens: 1_000 })).toMatchObject({
      memoryModel: "m",
      memoryRecapTokens: 1_000,
    });
    expect(stores.settings.update({ memoryRecapTokens: null })).toMatchObject({
      memoryRecapTokens: null,
    });
  });

  it("opens new chats on the memory's opening by default, and keeps the owner's choice", () => {
    const { stores } = setup();
    expect(stores.settings.get().memoryOpening).toBe(true);
    expect(stores.settings.update({ memoryOpening: false })?.memoryOpening).toBe(false);
    // A patch without the setting leaves it.
    expect(stores.settings.update({ memoryKeepTurns: 6 })?.memoryOpening).toBe(false);
  });
});
