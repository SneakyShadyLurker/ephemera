import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { signIn } from "../signin/signin.ts";
import { isFailure, saveStatusText } from "./autosave.ts";
import { type AutosaveOptions, createAutosave } from "./autosave-controller.ts";
import { type CreateResult, type SaveResult, saving } from "./saving.ts";

const schema = z.strictObject({ name: z.string().min(1), description: z.string() });
type Fields = z.infer<typeof schema>;
type Saved = Fields & { revision: number };
/** The revision an existing entity's editor loaded. */
const LOADED = 3;
const owners: { unmount: () => void }[] = [];

function setup(id: string | null = "existing") {
  vi.useFakeTimers();
  const create = vi
    .fn<NonNullable<AutosaveOptions<Fields, Saved>["create"]>>()
    .mockResolvedValue({ ok: true });
  const save = vi
    .fn<AutosaveOptions<Fields, Saved>["save"]>()
    .mockImplementation(async (_id, patch, revision) => ({
      ok: true,
      saved: { ...options.fields, ...patch, revision: revision + 1 },
    }));
  const options: AutosaveOptions<Fields, Saved> = {
    id,
    revision: id === null ? 0 : LOADED,
    fields: { name: "First", description: "Original" },
    schema,
    labels: { name: "Name", description: "Description" },
    wholeLabel: "The entity",
    create,
    save,
    onCreated: vi.fn(),
    onSaved: vi.fn(),
  };
  const report = vi.fn();
  const owner = createAutosave(options, report);
  owner.mount();
  owners.push(owner);
  return { owner, options, create, save, report };
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.unmount();
  vi.useRealTimers();
  signIn.reset();
});

describe("sheet autosave", () => {
  it("after a lost answer, sends that save again alone before newer edits, so no false conflict", async () => {
    const { owner, options, save, report } = setup();
    let server: Saved = { ...options.fields, revision: LOADED };
    let lose = true;
    // The server's rules: a stale save that changes nothing is answered as saved.
    save.mockImplementation(async (_id, patch, revision) => {
      if (revision !== server.revision) {
        const unchanged = Object.entries(patch).every(
          ([key, value]) => server[key as keyof Fields] === value,
        );
        return unchanged
          ? { ok: true, saved: server }
          : { ok: false, reason: "conflict", revision: server.revision };
      }
      server = { ...server, ...patch, revision: server.revision + 1 };
      if (lose) {
        lose = false;
        return { ok: false, reason: "unreachable" };
      }
      return { ok: true, saved: server };
    });
    options.fields = { ...options.fields, name: "Second" };
    owner.touch("name");
    expect(await owner.flush()).toBe(false);
    options.fields = { ...options.fields, description: "Newer" };
    owner.touch("description");
    expect(await owner.flush()).toBe(true);
    expect(server).toEqual({ name: "Second", description: "Newer", revision: LOADED + 2 });
    expect(report).not.toHaveBeenCalledWith({ kind: "conflict" });
  });

  it("after a lost answer and a refused resend, saves the corrected fields", async () => {
    const { owner, options, save, report } = setup();
    save
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: false, reason: "too_large" });
    options.fields = { ...options.fields, description: "Far too long" };
    owner.touch("description");
    expect(await owner.flush()).toBe(false);
    // Corrected before the retry, which still resends the patch whose answer was lost.
    options.fields = { ...options.fields, description: "Shorter" };
    owner.touch("description");
    expect(await owner.flush()).toBe(false);
    expect(save.mock.calls[1]?.[1]).toEqual({ description: "Far too long" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2]?.[1]).toEqual({ description: "Shorter" });
    expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
  });

  it("after a refused resend, saves a field put back to its saved value", async () => {
    const { owner, options, save, report } = setup();
    save
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: false, reason: "too_large", answered: true });
    options.fields = { ...options.fields, description: "Far too long" };
    owner.touch("description");
    expect(await owner.flush()).toBe(false);
    options.fields = { ...options.fields, description: "Original" };
    owner.touch("description");
    expect(await owner.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
    expect(owner.hasUnsaved()).toBe(false);
  });

  it("keeps resending a save whose answer was lost through a sign-out, alone", async () => {
    const { owner, options, save } = setup();
    save
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: false, reason: "signed_out" });
    options.fields = { ...options.fields, name: "Second" };
    owner.touch("name");
    expect(await owner.flush()).toBe(false);
    options.fields = { ...options.fields, description: "Newer" };
    owner.touch("description");
    expect(await owner.flush()).toBe(false);
    expect(await owner.flush()).toBe(true);
    expect(save.mock.calls.map((call) => call[1])).toEqual([
      { name: "Second" },
      { name: "Second" },
      { name: "Second" },
      { description: "Newer" },
    ]);
  });

  it("gives up resending alone once the server answers the resend with an error", async () => {
    const { owner, options, save } = setup();
    save
      .mockResolvedValueOnce({ ok: false, reason: "unreachable" })
      .mockResolvedValueOnce({ ok: false, reason: "unreachable", answered: true });
    options.fields = { ...options.fields, name: "Second" };
    owner.touch("name");
    expect(await owner.flush()).toBe(false);
    options.fields = { ...options.fields, description: "Newer" };
    owner.touch("description");
    expect(await owner.flush()).toBe(false);
    expect(await owner.flush()).toBe(true);
    expect(save.mock.calls[2]?.[1]).toEqual({ name: "Second", description: "Newer" });
  });

  it("saves an edit committed while a save the server refused was running", async () => {
    const { owner, options, save } = setup();
    let answer: (result: SaveResult<Saved>) => void = () => {};
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    owner.update({ ...options, fields: { ...options.fields, description: "Far too long" } });
    const first = owner.flush();
    await vi.advanceTimersByTimeAsync(0);
    owner.update({ ...options, fields: { ...options.fields, description: "Shorter" } });
    answer({ ok: false, reason: "too_large" });
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[1]).toEqual({ description: "Shorter" });
  });

  it.each(["invalid", "too_large"] as const)(
    "creates corrected fields after a definitive %s refusal",
    async (reason) => {
      const { owner, options, create, save, report } = setup(null);
      create.mockImplementation(async (_id, fields) =>
        fields.description === "Original" ? { ok: false, reason } : { ok: true },
      );
      owner.touch("name", "description");
      expect(await owner.flush()).toBe(false);
      expect(owner.hasUnsaved()).toBe(true);
      expect(options.onCreated).not.toHaveBeenCalled();
      options.fields = { ...options.fields, description: "Corrected" };
      owner.touch("description");
      expect(await owner.flush()).toBe(true);
      expect(create.mock.calls[1]).toEqual([create.mock.calls[0]?.[0], options.fields]);
      expect(save).not.toHaveBeenCalled();
      expect(options.onCreated).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
      expect(owner.hasUnsaved()).toBe(false);
    },
  );

  it("retries the original create after a lost response, patches later edits before navigation", async () => {
    const { owner, options, create, save, report } = setup(null);
    create.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    owner.touch("name");
    expect(await owner.flush()).toBe(false);
    options.fields = { name: "Edited", description: "Latest" };
    owner.touch("name", "description");
    expect(await owner.flush()).toBe(true);
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(create.mock.calls[0]?.[1]).toEqual({ name: "First", description: "Original" });
    expect(save).toHaveBeenCalledWith(create.mock.calls[0]?.[0], options.fields, 0);
    expect(options.onCreated).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
    expect(owner.hasUnsaved()).toBe(false);
  });

  it("keeps onCreated pending if reconciliation fails, then retries PATCH rather than POST", async () => {
    const { owner, options, create, save } = setup(null);
    create.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    owner.touch("name");
    await owner.flush();
    options.fields = { ...options.fields, description: "After the lost response" };
    owner.touch("description");
    save.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    expect(await owner.flush()).toBe(false);
    expect(options.onCreated).not.toHaveBeenCalled();
    expect(owner.hasUnsaved()).toBe(true);
    expect(await owner.flush()).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(options.onCreated).toHaveBeenCalledTimes(1);
  });

  it("drains edits made while the first create is in flight", async () => {
    const { owner, options, create, save } = setup(null);
    const request = Promise.withResolvers<CreateResult>();
    create.mockReturnValueOnce(request.promise);
    owner.touch("name");
    const flushing = owner.flush();
    await Promise.resolve();
    options.fields = { ...options.fields, description: "Typed during create" };
    owner.touch("description");
    request.resolve({ ok: true });
    expect(await flushing).toBe(true);
    expect(save).toHaveBeenCalledWith(
      expect.any(String),
      { description: "Typed during create" },
      0,
    );
    expect(options.onCreated).toHaveBeenCalledTimes(1);
  });

  it("resumes saves and retry timers after the StrictMode setup/cleanup/setup sequence", async () => {
    const { owner, save, report } = setup();
    owner.unmount();
    owner.mount();
    save.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    expect(report).toHaveBeenLastCalledWith({ kind: "unreachable" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
  });

  it.each(["unmount", "discard"] as const)(
    "makes queued and in-flight saves inert after %s",
    async (action) => {
      const { owner, options, save, report } = setup();
      const request = Promise.withResolvers<SaveResult<Saved>>();
      save.mockReturnValueOnce(request.promise);
      owner.touch("description");
      const first = owner.flush();
      await Promise.resolve();
      const queued = owner.flush();
      owner[action]();
      const reports = report.mock.calls.length;
      request.resolve({ ok: false, reason: "unreachable" });
      expect(await first).toBe(action === "discard");
      expect(await queued).toBe(action === "discard");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(reports);
      expect(options.onSaved).not.toHaveBeenCalled();
      if (action === "discard") expect(owner.hasUnsaved()).toBe(false);
    },
  );

  it("does not report a successful late save after deletion", async () => {
    const { owner, options, save } = setup();
    const request = Promise.withResolvers<SaveResult<Saved>>();
    save.mockReturnValueOnce(request.promise);
    owner.touch("description");
    const flushing = owner.flush();
    await Promise.resolve();
    owner.discard();
    request.resolve({ ok: true, saved: { ...options.fields, revision: LOADED + 1 } });
    expect(await flushing).toBe(true);
    expect(options.onSaved).not.toHaveBeenCalled();
    expect(await owner.flush()).toBe(true);
  });

  describe("deleted during its first create", () => {
    /** A new entity whose create is held, an edit made while it runs, and the deletion begun. */
    async function deleting() {
      const context = setup(null);
      const { owner, options, create } = context;
      const server = new Set<string>();
      const request = Promise.withResolvers<CreateResult>();
      create.mockImplementationOnce(async (id) => {
        const result = await request.promise;
        if (result.ok) server.add(id);
        return result;
      });
      owner.touch("name");
      const flushing = owner.flush();
      await Promise.resolve();
      owner.pause();
      options.fields = { ...options.fields, description: "Typed while deleting" };
      owner.touch("description");
      const settling = owner.settle();
      request.resolve({ ok: true });
      const id = await settling;
      expect(await flushing).toBe(false);
      return { ...context, server, id };
    }

    it("names the id its create used, so deleting it leaves nothing on the server", async () => {
      const { owner, options, create, save, server, id } = await deleting();
      expect(id).toBe(create.mock.calls[0]?.[0]);
      if (id !== null) server.delete(id);
      owner.discard();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.size).toBe(0);
      expect(create).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      expect(options.onCreated).not.toHaveBeenCalled();
      expect(owner.hasUnsaved()).toBe(false);
    });

    it("keeps the edits while the deletion runs, and saves them when it fails", async () => {
      const { owner, options, save, report, id } = await deleting();
      // Paused, nothing is sent, and the edit is still unsaved for the leave guard.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(save).not.toHaveBeenCalled();
      expect(owner.hasUnsaved()).toBe(true);

      owner.resume();
      await vi.advanceTimersByTimeAsync(600);
      expect(save).toHaveBeenCalledWith(id, { description: "Typed while deleting" }, 0);
      expect(options.onCreated).toHaveBeenCalledWith(id);
      expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
      expect(owner.hasUnsaved()).toBe(false);
    });
  });
});

describe("edits that commit late", () => {
  it("saves an edit whose value commits after a save of the older value began", async () => {
    const { owner, options, save } = setup();
    // The edit is queued (a transition), so the fields a flush sees are still the old ones.
    owner.touch("description");
    const request = Promise.withResolvers<SaveResult<Saved>>();
    save.mockReturnValueOnce(request.promise);
    const flushing = owner.flush();
    await Promise.resolve();
    // The edit commits while that save is in flight.
    owner.update({ ...options, fields: { ...options.fields, description: "Committed late" } });
    request.resolve({ ok: true, saved: { ...options.fields, revision: LOADED + 1 } });
    expect(await flushing).toBe(true);
    expect(save).toHaveBeenLastCalledWith(
      "existing",
      { description: "Committed late" },
      LOADED + 1,
    );
    expect(owner.hasUnsaved()).toBe(false);
  });

  it("saves an edit that commits after the save ran, without another touch", async () => {
    const { owner, options, save } = setup();
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    owner.update({ ...options, fields: { ...options.fields, description: "Later" } });
    expect(owner.hasUnsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "Later" }, LOADED + 1);
    expect(owner.hasUnsaved()).toBe(false);
  });

  it("saves within the longest wait while edits keep arriving", async () => {
    const { owner, options, save } = setup();
    for (let at = 0; at < 5_000; at += 200) {
      options.fields = { ...options.fields, description: `Typing ${at}` };
      owner.update({ ...options });
      owner.touch("description");
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("retry backoff", () => {
  it("backs off 2, 5, 10 and 30 seconds while Ephemera cannot be reached", async () => {
    const { owner, save } = setup();
    save.mockResolvedValue({ ok: false, reason: "unreachable" });
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    const calls = () => save.mock.calls.length;
    expect(calls()).toBe(1);
    for (const [wait, total] of [
      [2_000, 2],
      [5_000, 3],
      [10_000, 4],
      [30_000, 5],
      [30_000, 6],
    ] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(calls()).toBe(total - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls()).toBe(total);
    }
  });
});

describe("commits without an edit", () => {
  it("do not cut a retry's backoff short", async () => {
    const { owner, options, save } = setup();
    save.mockResolvedValue({ ok: false, reason: "unreachable" });
    const committed = { ...options, fields: { ...options.fields, description: "Unsaved" } };
    owner.update(committed);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    // The status change re-renders the sheet; the same values commit again.
    owner.update({ ...committed });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  describe("signed out", () => {
    const signedOut = { ok: false, reason: "signed_out" } as const;

    it("says so, holds the edits and sends nothing until the session is back", async () => {
      const { owner, options, save, report } = setup();
      save.mockResolvedValueOnce(signedOut);
      signIn.signedOut();
      options.fields = { ...options.fields, description: "Edited" };
      owner.touch("description");
      expect(await owner.flush()).toBe(false);
      expect(report).toHaveBeenLastCalledWith({ kind: "signed-out" });
      expect(signIn.store.getState().edits).toBe(1);
      // No backoff while signed out: an hour passes without a request.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(save).toHaveBeenCalledTimes(1);
      // Edits made meanwhile wait too, and are said to wait.
      options.fields = { ...options.fields, description: "Edited again" };
      owner.update({ ...options });
      owner.touch("description");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenLastCalledWith({ kind: "signed-out" });
      expect(owner.hasUnsaved()).toBe(true);
    });

    it("saves everything once on renewal and says what resumed", async () => {
      const { owner, options, save, report } = setup();
      save.mockResolvedValueOnce(signedOut);
      signIn.signedOut();
      options.fields = { ...options.fields, description: "Edited" };
      owner.touch("description");
      await owner.flush();
      await signIn.renewed();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith("existing", { description: "Edited" }, LOADED);
      expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
      expect(signIn.store.getState()).toMatchObject({
        phase: "renewed",
        resumed: "edits",
        edits: 0,
      });
      expect(owner.hasUnsaved()).toBe(false);
    });

    it("a sheet that leaves stops holding its edits and is not resumed", async () => {
      const { owner, options, save } = setup();
      save.mockResolvedValueOnce(signedOut);
      signIn.signedOut();
      options.fields = { ...options.fields, description: "Edited" };
      owner.touch("description");
      await owner.flush();
      owner.unmount();
      expect(signIn.store.getState().edits).toBe(0);
      await signIn.renewed();
      expect(save).toHaveBeenCalledTimes(1);
    });
  });
});

describe("another tab's save", () => {
  const conflict = (revision: number) => ({ ok: false, reason: "conflict", revision }) as const;

  it("sends the revision the editor loaded, then each one the server answers", async () => {
    const { owner, options, save } = setup();
    options.fields = { ...options.fields, description: "One" };
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "One" }, LOADED);
    expect(options.onSaved).toHaveBeenLastCalledWith(
      "existing",
      expect.objectContaining({ revision: LOADED + 1 }),
    );
    owner.update({ ...options, fields: { ...options.fields, description: "Two" } });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "Two" }, LOADED + 1);
  });

  it("says so, retries nothing and holds edits made meanwhile", async () => {
    const { owner, options, save, report } = setup();
    save.mockResolvedValueOnce(conflict(7));
    options.fields = { ...options.fields, description: "Mine" };
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    expect(report).toHaveBeenLastCalledWith({ kind: "conflict" });
    expect(owner.hasUnsaved()).toBe(true);
    // No backoff: an hour passes without a request.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(save).toHaveBeenCalledTimes(1);
    // Edits made meanwhile wait too, and the status stays.
    options.fields = { ...options.fields, name: "Renamed" };
    owner.update({ ...options });
    owner.touch("name");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await owner.flush()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({ kind: "conflict" });
    expect(owner.hasUnsaved()).toBe(true);
    expect(options.onSaved).not.toHaveBeenCalled();
  });

  it("keeps mine: saves every unsaved field over the revision the other tab left", async () => {
    const { owner, options, save, report } = setup();
    save.mockResolvedValueOnce(conflict(7));
    options.fields = { ...options.fields, description: "Mine" };
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    options.fields = { ...options.fields, name: "Renamed" };
    owner.update({ ...options });
    expect(await owner.keepMine()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "Mine", name: "Renamed" }, 7);
    expect(report).toHaveBeenLastCalledWith({ kind: "saved" });
    expect(owner.hasUnsaved()).toBe(false);
    // Saving resumes as before, from the revision that save left.
    owner.update({ ...options, fields: { ...options.fields, description: "Later" } });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "Later" }, 8);
  });

  it("keeps mine: saves this tab's whole version, so no field shows what the server lacks", async () => {
    const { owner, options, save } = setup();
    save.mockResolvedValueOnce(conflict(7));
    options.fields = { ...options.fields, description: "Mine" };
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    // The other tab may have renamed it; this tab still shows "First", and keeps it.
    expect(await owner.keepMine()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("existing", { name: "First", description: "Mine" }, 7);
  });

  it("reports a second conflict when another tab saves first again", async () => {
    const { owner, options, save, report } = setup();
    save.mockResolvedValueOnce(conflict(7)).mockResolvedValueOnce(conflict(9));
    options.fields = { ...options.fields, description: "Mine" };
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    expect(await owner.keepMine()).toBe(false);
    expect(save).toHaveBeenLastCalledWith("existing", { name: "First", description: "Mine" }, 7);
    expect(report).toHaveBeenLastCalledWith({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await owner.keepMine()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("existing", { name: "First", description: "Mine" }, 9);
    expect(owner.hasUnsaved()).toBe(false);
  });

  it("reads the server's 409 as a conflict with the current revision", async () => {
    const answer = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const read = async () => ({ revision: 1 });
    expect(await saving(answer(409, { error: "conflict", revision: 4 }), read)).toEqual({
      ok: false,
      reason: "conflict",
      revision: 4,
    });
    expect(await saving(answer(409, { error: "last_preset" }), read)).toEqual({
      ok: false,
      reason: "unreachable",
      answered: true,
    });
  });

  it("is a failure, said in words", () => {
    expect(saveStatusText({ kind: "conflict" }, false, "character")).toBe(
      "Not saved: changed in another tab",
    );
    expect(isFailure({ kind: "conflict" }, false)).toBe(true);
  });
});

describe("an object-valued field (the sheet's lorebook)", () => {
  const bookSchema = z.strictObject({
    name: z.string().min(1),
    description: z.string(),
    book: z.strictObject({ entries: z.array(z.string()) }).nullable(),
  });
  type BookFields = z.infer<typeof bookSchema>;
  type BookSaved = BookFields & { revision: number };

  function setupBook() {
    vi.useFakeTimers();
    const save = vi
      .fn<AutosaveOptions<BookFields, BookSaved>["save"]>()
      .mockImplementation(async (_id, patch, revision) => ({
        ok: true,
        saved: { ...options.fields, ...patch, revision: revision + 1 },
      }));
    const options: AutosaveOptions<BookFields, BookSaved> = {
      id: "existing",
      revision: LOADED,
      fields: { name: "First", description: "Original", book: { entries: ["The harbour"] } },
      schema: bookSchema,
      labels: { name: "Name", description: "Description", book: "Lorebook" },
      wholeLabel: "The entity",
      shared: ["book"],
      save,
      onSaved: vi.fn(),
    };
    const owner = createAutosave(options, vi.fn());
    owner.mount();
    owners.push(owner);
    return { owner, options, save };
  }

  it("is sent only when it changed", async () => {
    const { owner, options, save } = setupBook();
    options.fields = { ...options.fields, description: "Newer" };
    owner.touch("description");
    expect(await owner.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "Newer" }, LOADED);

    options.fields = { ...options.fields, book: { entries: ["The harbour", "The lighthouse"] } };
    owner.touch("book");
    expect(await owner.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith(
      "existing",
      { book: { entries: ["The harbour", "The lighthouse"] } },
      LOADED + 1,
    );

    options.fields = { ...options.fields, name: "Second" };
    owner.touch("name");
    expect(await owner.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("existing", { name: "Second" }, LOADED + 2);
    expect(owner.hasUnsaved()).toBe(false);
  });

  const conflict = (revision: number) => ({ ok: false, reason: "conflict", revision }) as const;

  it("keeps mine without the book this sheet never changed, so another screen's book stays", async () => {
    const { owner, options, save } = setupBook();
    save.mockResolvedValueOnce(conflict(7));
    options.fields = { ...options.fields, description: "Mine" };
    owner.touch("description");
    await vi.advanceTimersByTimeAsync(600);
    expect(owner.isUnsaved("book")).toBe(false);
    expect(await owner.keepMine()).toBe(true);
    // Every other field is this tab's version, as Keep mine always sends it.
    expect(save).toHaveBeenLastCalledWith("existing", { name: "First", description: "Mine" }, 7);
  });

  it("keeps mine with the book when this sheet changed it", async () => {
    const { owner, options, save } = setupBook();
    save.mockResolvedValueOnce(conflict(7));
    const book = { entries: ["The harbour", "The mill"] };
    options.fields = { ...options.fields, book };
    owner.touch("book");
    await vi.advanceTimersByTimeAsync(600);
    expect(owner.isUnsaved("book")).toBe(true);
    expect(await owner.keepMine()).toBe(true);
    expect(save).toHaveBeenLastCalledWith(
      "existing",
      { name: "First", description: "Original", book },
      7,
    );
  });

  it("adopts a newer saved book as saved: nothing sends it back", async () => {
    const { owner, options, save } = setupBook();
    const newer = { entries: ["The harbour", "Another tab's entry"] };
    // A copy older than this sheet's last save is not taken.
    expect(owner.adopt({ book: { entries: [] } }, LOADED - 1)).toBe(false);
    expect(owner.adopt({ book: newer }, LOADED + 1)).toBe(true);
    // The editor writes the same value into its fields on its next commit.
    const fields = { ...options.fields, book: newer };
    owner.update({ ...options, fields });
    expect(owner.isUnsaved("book")).toBe(false);
    expect(owner.hasUnsaved()).toBe(false);
    owner.update({ ...options, fields: { ...fields, description: "Newer" } });
    expect(await owner.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("existing", { description: "Newer" }, LOADED);
  });
});
