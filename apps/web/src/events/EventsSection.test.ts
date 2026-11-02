import { describe, expect, it } from "vitest";
import type { SaveStatus } from "../sheet/autosave.ts";
import { rowSaving } from "./EventRow.tsx";
import { leaveGuardOf, type Removed, settleRemoval } from "./EventsSection.tsx";
import { eventsSummary } from "./rule.ts";

/** A row's autosave that holds edits and cannot save them now. */
const holding = (status: SaveStatus) => ({
  status,
  hasUnsaved: () => true,
  flush: async () => false,
});

const removal = (key: string): Removed => ({
  key,
  at: 0,
  text: "A storm breaks",
  fields: {
    text: "A storm breaks",
    chance: 5,
    cooldown: 10,
    enabled: true,
    scope: { kind: "all" },
  },
  restoreId: `${key}-restore`,
  restoring: false,
  failure: null,
});

describe("the events' leave guard", () => {
  it("asks when an event's save failed, in the words of that failure", async () => {
    const failed = rowSaving(holding({ kind: "unreachable" }), {
      creating: false,
      blank: false,
      failure: "Not saved: can't reach Ephemera. Retrying",
    });
    const guard = leaveGuardOf([failed]);
    expect(guard.hasUnsaved()).toBe(true);
    // The guard blocks when its flush could not save.
    expect(await guard.flush()).toBe(false);
    expect(guard.status).toEqual({ kind: "unreachable" });
  });

  it("lets a new event with a blank instruction go without asking or warning on reload", () => {
    const blank = rowSaving(holding({ kind: "needs-name" }), {
      creating: true,
      blank: true,
      failure: null,
    });
    const guard = leaveGuardOf([blank]);
    expect(guard.hasUnsaved()).toBe(false);
    expect(guard.status).toEqual({ kind: "saved" });
    expect(blank.failing).toBe(false);
  });

  it("counts an existing event whose instruction was cleared as not saved, also when closed", () => {
    const cleared = rowSaving(holding({ kind: "needs-name" }), {
      creating: false,
      blank: true,
      failure: null,
    });
    expect(cleared.failing).toBe(true);
    expect(leaveGuardOf([cleared]).hasUnsaved()).toBe(true);
    const unsaved = [cleared].filter((row) => row.failing).length;
    expect(eventsSummary([{ enabled: true }], unsaved)).toBe("1 event, all on. 1 not saved");
  });
});

describe("an Undo's outcome", () => {
  it("applies to its own removal: progress, failure, then gone once restored", () => {
    const shown = removal("a");
    const restoring = settleRemoval("a", { restoring: true })(shown);
    expect(restoring).toMatchObject({ key: "a", restoring: true, restoreId: "a-restore" });
    const failed = settleRemoval("a", { restoring: false, failure: "Not restored." })(restoring);
    expect(failed).toMatchObject({ restoring: false, failure: "Not restored." });
    expect(settleRemoval("a", null)(failed)).toBeNull();
  });

  it("leaves another event's removal alone when it completes late", () => {
    const later = removal("b");
    expect(settleRemoval("a", null)(later)).toBe(later);
    expect(settleRemoval("a", { restoring: false, failure: "Not restored." })(later)).toBe(later);
    expect(settleRemoval("a", null)(null)).toBeNull();
  });
});
