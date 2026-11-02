import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * styles.css owns the corners, layers and type sizes: a component takes the
 * theme's `rounded-*` steps, the `--z-*` layers and the `text-*` scale, and
 * an icon takes one of the set's drawn sizes. An arbitrary value beside them
 * is a second owner.
 */

const SOURCE = join(import.meta.dirname, "..");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const COMPONENT_DRIFT = [
  // A corner off the scale; `inherit` follows the layer underneath.
  /\brounded(?:-[a-z]{1,2})?-\[(?!inherit\])[^\]]*\]/g,
  // A layer by number instead of by name.
  /(?<![\w-])z-(?:\d+|\[[^\]]*\])/g,
  // A fixed type size beside the scale (relative `em` sizes and fluid clamps follow their context).
  /\btext-\[\d*\.?\d+(?:px|rem)\]/g,
  // An icon drawn at one size and scaled to another.
  /<\w+Icon\b[^>]*\bclassName="[^"]*(?<![\w-])size-[\d.]+/g,
];

/** A stylesheet's layer by number, outside a token's own definition. */
const CSS_LAYER = /\bz-index\s*:\s*-?\d/g;

function componentFindings(path: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    for (const pattern of COMPONENT_DRIFT) {
      for (const match of line.match(pattern) ?? []) found.push(`${path}:${index + 1}: ${match}`);
    }
  });
  return found;
}

function cssFindings(path: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (/^\s*--[\w-]+\s*:/.test(line)) return;
    for (const match of line.match(CSS_LAYER) ?? []) found.push(`${path}:${index + 1}: ${match}`);
  });
  return found;
}

describe("visual values", () => {
  it("come from the theme's corners, layers, type scale and icon sizes", () => {
    const findings = files(SOURCE).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const name = relative(SOURCE, path);
      return path.endsWith(".css") ? cssFindings(name, text) : componentFindings(name, text);
    });
    expect(findings).toEqual([]);
  });

  it("catches the literals it is for", () => {
    expect(
      componentFindings(
        "a.tsx",
        'className="rounded-[5px] rounded-t-[3px] z-50 text-[11px] text-[1.125rem] rounded-[inherit] z-(--z-overlay) text-[0.92em]"',
      ),
    ).toEqual([
      "a.tsx:1: rounded-[5px]",
      "a.tsx:1: rounded-t-[3px]",
      "a.tsx:1: z-50",
      "a.tsx:1: text-[11px]",
      "a.tsx:1: text-[1.125rem]",
    ]);
    expect(componentFindings("a.tsx", '<CheckIcon size={16} className="size-3.5" />')).toHaveLength(
      1,
    );
    expect(componentFindings("a.tsx", '<CheckIcon size={14} className="text-reed" />')).toEqual([]);
    expect(
      cssFindings("a.css", "  z-index: 1;\n  --z-raised: 10;\n  z-index: var(--z-raised);"),
    ).toEqual(["a.css:1: z-index: 1"]);
  });
});
