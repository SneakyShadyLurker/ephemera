import { describe, expect, it } from "vitest";
import styles from "../styles.css?raw";
import { cn, TEXT_SIZES } from "./cn.ts";

describe("cn", () => {
  it("keeps a type-scale size beside a text color", () => {
    expect(cn("text-ui", "text-reed")).toBe("text-ui text-reed");
  });

  it("lets a later type-scale size replace an earlier one", () => {
    expect(cn("text-ui text-ink", "text-meta")).toBe("text-ink text-meta");
  });

  it("knows every size of the theme's type scale", () => {
    const theme = styles.slice(styles.indexOf("@theme inline {"));
    // A size's name, without its `--line-height` companions.
    const sizes = [...theme.matchAll(/^\s*--text-([a-z]+(?:-[a-z]+)?):/gm)].map(
      (match) => match[1],
    );
    expect(sizes).toEqual(TEXT_SIZES);
  });

  it("keeps the owner's line size beside a text color", () => {
    expect(cn("text-line", "text-ink")).toBe("text-line text-ink");
  });
});
