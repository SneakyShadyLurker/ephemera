import type { BrainstormOption } from "@ephemera/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { focusAfterRound, IdeaList, ideaRows, KindControl, nextShown } from "./Brainstorm.tsx";

// The creator's own session stays out: these parts take what they show as props.
vi.mock("./session.ts", () => ({}));

/** Idea `n` of a list told apart by `tag`. */
const idea = (n: number, tag = "a"): BrainstormOption => ({
  pitch: `Idea ${n} of list ${tag}`,
  brief: `A placeholder brief ${n} of list ${tag}.`,
});
const list = (tag: string, count = 10) => Array.from({ length: count }, (_, n) => idea(n + 1, tag));

/** A replacement list keeping rows 3 and 7 of list a. */
const tuned = () => list("b").map((option, i) => (i === 2 || i === 6 ? idea(i + 1, "a") : option));

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

describe("the ideas list", () => {
  it("holds ten places from the start of a first round, ghosts until lines arrive", () => {
    const rows = ideaRows({ before: [], fresh: list("a", 2), shown: 1, running: true });
    expect(rows.map((row) => row.state)).toEqual(["new", ...Array(9).fill("ghost")]);
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows[1]?.key).toBe("ghost-1");
  });

  it("dims the previous list on a replacement round and settles or replaces each row as it lands", () => {
    const rows = ideaRows({
      before: list("a"),
      fresh: tuned().slice(0, 4),
      shown: 3,
      running: true,
    });
    expect(rows.map((row) => row.state)).toEqual(["new", "new", "kept", ...Array(7).fill("dim")]);
    // A replaced row fades the old text out as the new one arrives.
    expect(rows[0]).toMatchObject({ pitch: idea(1, "b").pitch, gone: idea(1, "a").pitch });
    expect(rows[2]).toMatchObject({ pitch: idea(3, "a").pitch, gone: null });
    expect(rows[5]).toMatchObject({ state: "dim", pitch: idea(6, "a").pitch });
  });

  it("keeps a kept row's key from the dimmed list through the result", () => {
    const dimmed = ideaRows({ before: list("a"), fresh: [], shown: 0, running: true });
    const writing = ideaRows({ before: list("a"), fresh: tuned(), shown: 10, running: true });
    const settled = ideaRows({ before: list("a"), fresh: tuned(), shown: 10, running: false });
    expect(writing[6]?.key).toBe(dimmed[6]?.key);
    expect(settled[6]?.key).toBe(dimmed[6]?.key);
    expect(settled[0]?.key).not.toBe(dimmed[0]?.key);
  });

  it("arrives an idea moved to another place as new there, never moving a row", () => {
    // The model wrote idea 3 of list a first: row 1 replaces its idea, row 3 waits for its own.
    const moved = [idea(3, "a"), ...list("b").slice(1)];
    const dimmed = ideaRows({ before: list("a"), fresh: [], shown: 0, running: true });
    const writing = ideaRows({ before: list("a"), fresh: moved, shown: 1, running: true });
    expect(writing[0]).toMatchObject({ state: "new", gone: idea(1, "a").pitch });
    expect(dimmed.map((row) => row.key)).not.toContain(writing[0]?.key);
    expect(writing[2]?.key).toBe(dimmed[2]?.key);
    expect(new Set(writing.map((row) => row.key)).size).toBe(10);
  });

  it("leaves the previous list listed through a failed round", () => {
    const rows = ideaRows({ before: list("a"), fresh: list("a"), shown: 10, running: false });
    expect(rows.map((row) => row.state)).toEqual(Array(10).fill("kept"));
    expect(rows.map((row) => row.pitch)).toEqual(list("a").map((option) => option.pitch));
  });

  it("reveals one new row per step and kept rows along with it", () => {
    expect(nextShown(0, list("b"), [])).toBe(1);
    // Row 3 is kept: it comes with row 2.
    expect(nextShown(1, tuned(), list("a"))).toBe(3);
    // A failed round's list is the previous one: all of it at once.
    expect(nextShown(0, list("a"), list("a"))).toBe(10);
  });

  it("shows rows as text while a round runs and as buttons once it settles", () => {
    const rows = ideaRows({ before: [], fresh: list("a"), shown: 10, running: false });
    const running = html(<IdeaList rows={rows} busy={true} picked={null} onPick={() => {}} />);
    expect(running).toContain('aria-label="Ideas"');
    expect(running).toContain('aria-busy="true"');
    expect(running).not.toContain("<button");
    const settled = html(<IdeaList rows={rows} busy={false} picked={null} onPick={() => {}} />);
    expect(settled).toContain('aria-busy="false"');
    expect(settled.match(/<button/g)).toHaveLength(10);
    expect(settled).toContain(`aria-label="3. ${idea(3).pitch}"`);
  });

  it("washes the rows a round rewrote, not the kept ones or a first list's", () => {
    const html_ = (before: BrainstormOption[], busy: boolean) =>
      html(
        <IdeaList
          rows={ideaRows({ before, fresh: tuned(), shown: 10, running: false })}
          busy={busy}
          picked={null}
          onPick={() => {}}
        />,
      );
    // Eight of ten rewritten, rows 3 and 7 kept; the wash holds through the settle into buttons.
    expect(html_(list("a"), true).match(/data-rework-wash/g)).toHaveLength(8);
    expect(html_(list("a"), false).match(/data-rework-wash/g)).toHaveLength(8);
    expect(html_([], true)).not.toContain("data-rework-wash");
  });

  it("marks the row being written with the light along its edge, and only while one is", () => {
    const rows = ideaRows({
      before: list("a"),
      fresh: tuned().slice(0, 3),
      shown: 3,
      running: true,
    });
    const writing = html(
      <IdeaList rows={rows} busy={true} edge={3} picked={null} onPick={() => {}} />,
    );
    expect(writing.match(/lamplight-edge/g)).toHaveLength(1);
    const lit = writing.split("<li").filter((row) => row.includes("lamplight-edge"));
    expect(lit).toHaveLength(1);
    expect(lit[0]).toContain(idea(4).pitch);
    const waiting = html(<IdeaList rows={rows} busy={true} picked={null} onPick={() => {}} />);
    expect(waiting).not.toContain("lamplight-edge");
  });

  it("marks the picked row as current", () => {
    const rows = ideaRows({ before: [], fresh: list("a"), shown: 10, running: false });
    const out = html(<IdeaList rows={rows} busy={false} picked={4} onPick={() => {}} />);
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toMatch(new RegExp(`aria-label="5\\. ${idea(5).pitch}" aria-current="true"`));
  });
});

describe("the kind control", () => {
  it("is a select on a phone", () => {
    const out = html(
      <KindControl phone={true} kind="scenario" disabled={false} onChoose={() => {}} />,
    );
    expect(out).toContain('role="combobox"');
    expect(out).toContain("Kind of ideas");
    expect(out).toContain("Scenario");
    expect(out).not.toContain("aria-pressed");
  });

  it("is a toggle group from tablet up, the pressed kind checked", () => {
    const out = html(
      <KindControl phone={false} kind="group" disabled={false} onChoose={() => {}} />,
    );
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Kind of ideas"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*>.*?data-icon="Check".*?Multiple Subjects/);
    expect(out).toContain("Changing the kind brings ten new ideas.");
  });

  it("shows no kind pressed after an unclear request", () => {
    const out = html(
      <KindControl phone={false} kind={null} disabled={false} onChoose={() => {}} />,
    );
    expect(out).not.toContain('aria-pressed="true"');
  });
});

describe("focus after a round", () => {
  it.each([
    [{ active: "body", rows: 10, failed: false }, "first-row"],
    [{ active: "body", rows: 0, failed: true }, "alert"],
    // The cause first, above the list it left in place.
    [{ active: "body", rows: 8, failed: true }, "alert"],
    [{ active: "elsewhere", rows: 10, failed: false }, null],
    [{ active: "body", rows: 0, failed: false }, null],
  ] as const)("%o moves to %s", ({ active, rows, failed }, target) => {
    expect(focusAfterRound({ lost: active === "body", rows, failed })).toBe(target);
  });
});
