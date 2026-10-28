import { createCn } from "cn/config";

/** The theme's `--text-*` sizes (styles.css); a unit test keeps the two in step. */
export const TEXT_SIZES = [
  "meta",
  "note",
  "ui",
  "lead",
  "turn",
  "line",
  "story-phone",
  "story",
  "heading",
  "title-phone",
  "title",
];

/**
 * Class merging that knows Ephemera's type scale. Without it, `text-ui`
 * reads as a text color and a later `text-reed` silently drops it.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: TEXT_SIZES }] } },
});
