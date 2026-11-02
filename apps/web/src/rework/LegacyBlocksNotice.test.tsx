import { CARD_LIMITS } from "@ephemera/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LegacyBlocksNotice } from "./LegacyBlocksNotice.tsx";

// The tab's own session stays out: a static render never clicks.
vi.mock("./session.ts", () => ({}));

const FOLDED = "Ada keeps the archive.\n\n<scenario>\nA library at night.\n</scenario>";

/** The notice as the sheet renders it, a saved card free to rework unless `props` say otherwise. */
const render = (
  props: Partial<{
    description: string;
    id: string | null;
    locked: boolean;
    portraitChanging: boolean;
  }> = {},
) => {
  const markup = renderToStaticMarkup(
    <LegacyBlocksNotice
      description={FOLDED}
      id="5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b"
      locked={false}
      portraitChanging={false}
      onCompose={() => {}}
      {...props}
    />,
  );
  const text = (html: string) => html.replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'");
  const paragraph = /<p id="([^"]+)"[^>]*>(.*?)<\/p>/s.exec(markup);
  const button = /<button([^>]*)>(?:(?!<\/button>).)*Rework this card<\/button>/s.exec(markup);
  return {
    markup,
    paragraph: paragraph && { id: paragraph[1], text: text(paragraph[2] ?? "") },
    button: button && {
      disabled: /\sdisabled=""/.test(button[1] ?? ""),
      describedBy: /aria-describedby="([^"]+)"/.exec(button[1] ?? "")?.[1],
    },
  };
};

describe("LegacyBlocksNotice", () => {
  it("renders nothing for a description without a top-level folded block", () => {
    expect(render({ description: "Ada keeps the archive." }).markup).toBe("");
    expect(
      render({ description: "<ada>\n<personality>\nExact.\n</personality>\n</ada>" }).markup,
    ).toBe("");
  });

  it("names the blocks found and offers Rework, the paragraph describing the button", () => {
    const { paragraph, button } = render({
      description: `${FOLDED}\n\n<instructions>\nStay in the archive.\n</instructions>`,
    });
    expect(paragraph?.text).toBe(
      "Scenario and Instructions blocks were folded in from an older card format. Rework can rewrite them into the card's layout.",
    );
    expect(button?.disabled).toBe(false);
    expect(button?.describedBy).toBe(paragraph?.id);
  });

  it.each([
    ["while the card is not yet saved", { id: null }],
    ["while a rework works or is under review", { locked: true }],
    ["while the portrait changes", { portraitChanging: true }],
  ])("disables the button %s", (_, props) => {
    const { paragraph, button } = render(props);
    expect(button?.disabled).toBe(true);
    expect(paragraph?.text).not.toContain("Shorten the description");
  });

  it("disables the button and says why when the description is over the limit", () => {
    const { paragraph, button } = render({
      description: `${"x".repeat(CARD_LIMITS.textLength)}\n\n<scenario>\nNight.\n</scenario>`,
    });
    expect(button?.disabled).toBe(true);
    expect(paragraph?.text).toContain("Shorten the description below the limit to rework it.");
  });
});
