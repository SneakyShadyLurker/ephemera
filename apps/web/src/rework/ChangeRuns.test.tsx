import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangeDecision, ChangeRuns } from "./ChangeRuns.tsx";
import { type Segment, segmentField } from "./tracked.ts";

/** The word diff the review shows for a change replacing the whole of `find`. */
function wordDiff(find: string, replace: string) {
  const [segment] = segmentField(
    find,
    [
      {
        at: 0,
        field: { kind: "text", key: "description" },
        why: "",
        find: "",
        replace,
        start: 0,
        end: find.length,
        whole: false,
      },
    ],
    { collapseWords: 60 },
  );
  if (segment?.kind !== "change") throw new Error("expected a change");
  return segment.runs;
}

const change = (find: string, replace: string): Extract<Segment, { kind: "change" }> => ({
  kind: "change",
  id: "4",
  find,
  replace,
  runs: wordDiff(find, replace),
  mode: "inline",
  reasonAt: find.length,
});

/** A change and, where TrackedText stands it, its reason row. */
const render = (
  segment: Extract<Segment, { kind: "change" }>,
  decision: "accepted" | "rejected" = "accepted",
  why = "Her age now matches.",
) =>
  renderToStaticMarkup(
    <>
      <ChangeRuns
        change={segment}
        at={4}
        number={2}
        total={6}
        field="Description"
        whyId="why-4"
        decision={decision}
      />
      <ChangeDecision
        label="change 2 of 6"
        why={why}
        whyId="why-4"
        decision={decision}
        onAccept={() => {}}
        onReject={() => {}}
        reasonFor={4}
      />
    </>,
  );

describe("one change in a tracked view", () => {
  it("marks struck and inserted words, spoken as such, inside a labelled group", () => {
    const out = render(change("Mara is 24 and tall.", "Mara is 34 and tall."));
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Change 2 of 6 in Description"');
    expect(out).toContain('data-change-at="4"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toMatch(
      /<del class="tracked-del"><span class="sr-only">deleted: <\/span>24<\/del>/,
    );
    expect(out).toMatch(
      /<ins class="tracked-ins"><span class="sr-only">inserted: <\/span>34<\/ins>/,
    );
    expect(out).toContain('aria-label="Accept change 2 of 6"');
    expect(out).toContain('aria-label="Reject change 2 of 6"');
    // The reason, in its row apart from the change, describes the group.
    expect(out).toContain('aria-describedby="why-4"');
    expect(out).toContain('id="why-4"');
    expect(out).toContain('data-reason-for="4"');
    expect(out).toContain("Her age now matches.");
  });

  it("offers Restore once rejected", () => {
    const out = render(change("a", "b"), "rejected", "");
    expect(out).toContain('data-decision="rejected"');
    expect(out).toContain('aria-label="Restore change 2 of 6"');
    expect(out).not.toContain("Reject change");
  });

  it("writes a hostile replacement as escaped text: no element, no link", () => {
    const hostile =
      'Fine. <img src="http://127.0.0.1:9/beacon" onerror="alert(1)"> [map](http://127.0.0.1:9/link) **bold**';
    const out = render(change("Fine.", hostile));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("<strong");
    expect(out).toContain("&lt;img src=&quot;http://127.0.0.1:9/beacon&quot;");
    expect(out).toContain("[map](http://127.0.0.1:9/link)");
    expect(out).toContain("**bold**");
  });

  it("shows a large rewrite as one passage, the original behind a disclosure", () => {
    const out = render({ ...change("old words here", "new passage"), mode: "passage" });
    expect(out).toMatch(
      /<ins class="tracked-ins"><span class="sr-only">inserted: <\/span>new passage<\/ins>/,
    );
    expect(out).toContain("Show original (3 words)");
    expect(out).toMatch(
      /<del class="tracked-del"><span class="sr-only">deleted: <\/span>old words here<\/del>/,
    );
  });
});
