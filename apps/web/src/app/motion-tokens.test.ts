import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { motionMs, motionPx, staggerStep } from "./motion-tokens.ts";

/*
 * styles.css owns every motion duration, delay and stagger. A raw time in a
 * stylesheet outside a token's definition, or in a component's motion (a
 * Tailwind duration or delay, a style's transition or animation timing, a
 * Motion transition), means a second owner.
 */

const SOURCE = join(import.meta.dirname, "..");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** A time other than zero, as CSS writes it. */
const TIME = /(?<![\w.-])(?:\d+\.?\d*|\.\d+)m?s\b/g;
const ZERO = /^0*\.?0*m?s$/;

/** Motion timing a component writes as a literal: Tailwind, inline styles, Motion transitions. */
const COMPONENT_TIMING = [
  /\b(?:duration|delay)-(?:[1-9]\d*\b|\[[^\]]*\d(?:m?s)\b[^\]]*\])/g,
  /\banimate-\[[^\]]*\d(?:m?s)\b/g,
  /\b(?:transition|animation)(?:Delay|Duration)\s*:\s*[`"']?-?\$?\{?\s*[^,}\n]*\d+\s*\*?\s*\d*\s*\}?m?s/g,
  /\b(?:duration|delay)\s*:\s*(?:0?\.\d*[1-9]|[1-9]\d*(?:\.\d+)?)\b/g,
];

function cssFindings(path: string, text: string): string[] {
  const found: string[] = [];
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  lines.split("\n").forEach((line, index) => {
    // A token's own definition is where a time belongs.
    if (/^\s*--[\w-]+\s*:/.test(line)) return;
    for (const match of line.match(TIME) ?? []) {
      if (!ZERO.test(match)) found.push(`${path}:${index + 1}: ${match}`);
    }
  });
  return found;
}

function componentFindings(path: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    for (const pattern of COMPONENT_TIMING) {
      for (const match of line.match(pattern) ?? []) found.push(`${path}:${index + 1}: ${match}`);
    }
  });
  return found;
}

describe("motion values", () => {
  it("come from the styles.css tokens, never a raw time in a stylesheet or component", () => {
    const findings = files(SOURCE).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const name = relative(SOURCE, path);
      return path.endsWith(".css") ? cssFindings(name, text) : componentFindings(name, text);
    });
    expect(findings).toEqual([]);
  });

  it("catches the literals it is for", () => {
    expect(cssFindings("a.css", "  transition: opacity 200ms ease;\n  --duration-x: 1s;")).toEqual([
      "a.css:1: 200ms",
    ]);
    expect(componentFindings("a.tsx", 'className="delay-120 duration-(--duration-quick)"')).toEqual(
      ["a.tsx:1: delay-120"],
    );
    expect(
      componentFindings("a.tsx", ["style={{ transitionDelay: `$", "{index * 30}ms` }}"].join("")),
    ).toHaveLength(1);
    expect(componentFindings("a.tsx", "transition={{ duration: 0.32 }}")).toEqual([
      "a.tsx:1: duration: 0.32",
    ]);
    expect(componentFindings("a.tsx", "transition: { layout: { duration: 0 } }")).toEqual([]);
  });

  it("read as nothing to wait on outside a document", () => {
    expect(motionMs("--duration-quick")).toBe(0);
    expect(motionPx("--rise")).toBe(0);
    expect(staggerStep(2)).toEqual({ "--step": 2 });
  });
});
