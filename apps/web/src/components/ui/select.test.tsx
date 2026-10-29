import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select, SelectGroup, SelectGroupLabel, SelectItem } from "./select.tsx";

/*
 * The list opens in a portal, which a static render leaves out, so the
 * options render under the root alone: what the open list holds. The label
 * names its group once mounted (Base UI sets `aria-labelledby` in an effect).
 */

describe("a select's groups", () => {
  it("renders a labelled group with its label and its items", () => {
    const html = renderToStaticMarkup(
      <Select defaultValue="mine">
        <SelectGroup>
          <SelectGroupLabel>Your workflows</SelectGroupLabel>
          <SelectItem value="mine">Mine</SelectItem>
          <SelectItem value="other" description="Two nodes">
            Other
          </SelectItem>
        </SelectGroup>
      </Select>,
    );
    const group = html.match(/<div role="group"[^>]*>(.*)<\/div><input/)?.[1] ?? "";
    expect(group).toMatch(
      /^<div id="[^"]+" aria-hidden="true" class="[^"]*\btext-reed\b[^"]*">Your workflows<\/div>/,
    );
    // Sentence case as written, not an all-caps eyebrow.
    expect(group).not.toMatch(/uppercase|tracking-/);
    expect(group.match(/role="option"/g)).toHaveLength(2);
    expect(group).toContain(">Mine<");
    expect(group).toContain(">Other<");
    expect(group).toContain(">Two nodes<");
  });

  it("leaves a select without groups as it was", () => {
    const html = renderToStaticMarkup(
      <Select defaultValue="a">
        <SelectItem value="a">A</SelectItem>
      </Select>,
    );
    expect(html).not.toContain('role="group"');
    expect(html).toContain(
      '<div data-selected="" role="option" aria-selected="true" tabindex="-1" class="flex h-9 cursor-default select-none items-center gap-2 rounded-sm pr-2 pl-3 text-ink text-ui outline-none data-highlighted:bg-surface-hover touch:h-11"><div class="min-w-0 flex-1 truncate">A</div>',
    );
  });
});
