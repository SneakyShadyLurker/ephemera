import { parseCardAnswer } from "@ephemera/core";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { CardHeading } from "./CardLayout.tsx";
import { ShowcaseText, TagChips } from "./CardText.tsx";
import { stepOption } from "./choice.ts";
import { cardRows } from "./sections.ts";

/**
 * Renders to HTML with the lazy Markdown renderer in place: a first render
 * waits for it to load, then the markup is taken in one piece.
 */
async function html(node: React.ReactNode): Promise<string> {
  await prerender(node);
  return renderToStaticMarkup(node);
}

const HOSTILE = [
  "![portrait](https://evil.example/pixel.png)",
  "[a door](https://evil.example/door)",
  '<img src="https://evil.example/x.png" onerror="alert(1)">',
  '<a href="https://evil.example">raw link</a>',
  "<script>alert(1)</script>",
].join("\n\n");

const inner = (text: string) =>
  [
    `<backgroundstory>${text}</backgroundstory>`,
    `<appearance>${text}</appearance>`,
    `<personality>${text}</personality>`,
    `<vocabulary>${text}</vocabulary>`,
  ].join("");

const ANSWER = [
  "<name>Ada Reed</name>",
  `<description><ada_reed>${inner(HOSTILE)}</ada_reed><bo_lind>${inner(HOSTILE)}</bo_lind></description>`,
  `<firstMessage>${HOSTILE}</firstMessage>`,
  `<creatorNotes>${HOSTILE}</creatorNotes>`,
].join("\n");

describe("the showcase", () => {
  it("renders hostile card text inert: no image, link, script or handler", async () => {
    const answer = parseCardAnswer(ANSWER);
    const out = await html(
      <>
        <CardHeading name={answer.name.text} tagline={answer.creatorNotes.text} />
        <TagChips kind="subject" />
        <ShowcaseText
          kind="subject"
          answer={answer}
          tokens={[{ block: "ada_reed", tokens: 6_000, cap: 5_000 }]}
          phone={false}
        />
      </>,
    );
    expect(out).toContain("Opening");
    // The one tag is the kind's, whatever the model wrote.
    expect(out).toContain(">Subject</li>");
    expect(out).toContain("evil.example/door");
    expect(out).not.toMatch(/<(img|a|script|iframe)\b/i);
    expect(out).not.toMatch(/<[^>]*\s(href|src)=/i);
    expect(out).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    // Over its cap, the count says so, and the card can still be kept.
    expect(out).toContain("6,000 of 5,000 tokens");
    expect(out).toContain("it can still be kept");
  });

  it("shows a Scenario's Roleplay, Setting, People and Tone in order, while writing and in the showcase", async () => {
    const answer = parseCardAnswer(
      [
        "<name>Valley</name>",
        "<description><Roleplay>A placeholder premise.</Roleplay>",
        "<Setting>A placeholder town.</Setting><People>Placeholder millers.</People>",
        "<Tone>Quiet placeholder mood.</Tone></description>",
        "<firstMessage>Placeholder opening.</firstMessage>",
      ].join("\n"),
    );
    const out = await html(
      <ShowcaseText kind="scenario" answer={answer} tokens={[]} phone={true} />,
    );
    // On phones the tag follows the opening: the Scenario kind's.
    expect(out).toContain(">Scenario</li>");
    const blocks = [
      "A placeholder premise.",
      "A placeholder town.",
      "Placeholder millers.",
      "Quiet placeholder mood.",
    ];
    const order = blocks.map((text) => out.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(cardRows("scenario", answer).map((row) => [row.label, row.text])).toEqual([
      ["Roleplay", "A placeholder premise."],
      ["Setting", "A placeholder town."],
      ["People", "Placeholder millers."],
      ["Tone", "Quiet placeholder mood."],
      ["Opening", "Placeholder opening."],
    ]);
  });

  it("moves the choice among the four portraits with arrow keys, Home and End", () => {
    expect(stepOption("ArrowRight", 0, 4)).toBe(1);
    expect(stepOption("ArrowDown", 3, 4)).toBe(0);
    expect(stepOption("ArrowLeft", 0, 4)).toBe(3);
    expect(stepOption("ArrowUp", 2, 4)).toBe(1);
    expect(stepOption("Home", 2, 4)).toBe(0);
    expect(stepOption("End", 1, 4)).toBe(3);
    expect(stepOption("Enter", 1, 4)).toBeUndefined();
  });
});
