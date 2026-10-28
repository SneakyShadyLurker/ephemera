import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardChunk, pngWithText } from "../../apps/server/test/image-fixtures.ts";
import { blankCard } from "../../packages/core/src/card/index.ts";
import v2Full from "../../packages/core/test-fixtures/imports/v2-full.json" with { type: "json" };
import v2Minimal from "../../packages/core/test-fixtures/imports/v2-minimal.json" with {
  type: "json",
};
import v3Full from "../../packages/core/test-fixtures/imports/v3-full.json" with { type: "json" };
import { checkCards, leaks, passed } from "./check.ts";

/*
 * The real-card check on the synthetic corpus: every stage counts, a file
 * that is no card is refused by its code, one that cannot be read is counted
 * by stage, either fails the run, and nothing a card or its file name says
 * reaches the report, stdout or stderr.
 */

const MARK = ["zq", "cardmark", "9k"].join("");
const marked = (card: { spec: string; data: Record<string, unknown> }, description: string) => ({
  ...card,
  data: { ...card.data, name: `${MARK} ${String(card.data.name)}`, description },
});
/** Root reads a file whatever its mode, so the unreadable case needs another user. */
const root = process.getuid?.() === 0;

let base = "";
let mixed = "";
let clean = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ephemera-cards-"));
  mixed = join(base, "mixed");
  clean = join(base, "clean");
  for (const folder of [mixed, clean]) {
    await mkdir(folder);
    await writeFile(
      join(folder, `${MARK}-full.json`),
      JSON.stringify(marked(v2Full, `${MARK} text`)),
    );
    // Opens with a macro: the description block must still be found.
    await writeFile(
      join(folder, `${MARK}-minimal.json`),
      JSON.stringify(marked(v2Minimal, `{{char}} ${MARK}\nKind.`)),
    );
    await writeFile(
      join(folder, `${MARK}-v3.png`),
      pngWithText({ ccv3: cardChunk(marked(v3Full, `${MARK} text`)) }),
    );
  }
  await symlink(join(clean, `${MARK}-full.json`), join(clean, `${MARK}-linked.json`));
  // A lorebook entry in the chat and a sticky one keyed by the first message only:
  // the second exchange keeps it by the timed state the first returned.
  const timed = marked(v2Full, `${MARK} text`);
  await writeFile(
    join(clean, `${MARK}-timed.json`),
    JSON.stringify({
      ...timed,
      data: {
        ...timed.data,
        character_book: {
          extensions: {},
          entries: [
            {
              keys: [],
              content: "The harbour wall is at depth.",
              extensions: { position: 4, depth: 1, role: 0 },
              enabled: true,
              insertion_order: 10,
              constant: true,
            },
            {
              keys: ["hello"],
              content: "The greeting lingers.",
              extensions: { sticky: 3 },
              enabled: true,
              insertion_order: 20,
            },
          ],
        },
      },
    }),
  );
  // Macros only, expanding to nothing: assembly leaves the description block out.
  await writeFile(
    join(clean, `${MARK}-comment.json`),
    JSON.stringify(marked(v2Full, "{{// a note}}{{noop}}")),
  );
  await writeFile(join(mixed, `${MARK}-broken.json`), "{ not json");
  if (!root) {
    await writeFile(join(mixed, `${MARK}-locked.png`), "unreadable");
    await chmod(join(mixed, `${MARK}-locked.png`), 0o000);
  }
  await writeFile(join(mixed, "notes.txt"), MARK);
});

afterAll(async () => {
  if (base === "") return;
  await chmod(join(mixed, `${MARK}-locked.png`), 0o600).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

describe("the real-card check", () => {
  it("passes a folder whose cards, a symlinked and a macro-only one included, all import, round-trip and assemble", async () => {
    const report = await checkCards(clean);
    expect(report.files).toBe(6);
    expect(report.roundTrip).toEqual({ json: 6, png: 6 });
    expect(report.assembled).toBe(6);
    expect(report.assemblyRefused).toEqual({});
    expect(report.importChanges.changed + report.importChanges.skipped).toBeGreaterThan(0);
    expect(report.lorebookEntriesKept).toBe(6);
    // The preview matched the reply for an entry in the chat and a sticky one too.
    expect(report.lorebookInChat).toBe(1);
    expect(report.lorebookTimed).toBe(1);
    expect(passed(report)).toBe(true);
  });

  it("counts the refused and the unreadable file, and fails the run for them", async () => {
    const report = await checkCards(mixed);
    expect(report.files).toBe(root ? 4 : 5);
    expect(report.imported).toEqual({ png: 1, json: 2, v2: 2, v3: 1, native: 0 });
    expect(report.refused).toEqual({ not_json: 1 });
    expect(report.failed).toEqual(root ? {} : { read: 1 });
    expect(report.assembled).toBe(3);
    expect(report.logged).toBe(0);
    expect(passed(report)).toBe(false);
  });

  it("checks native files and their independent PNG and JSON readback without exposing text", async () => {
    const folder = join(base, "native");
    await mkdir(folder);
    await writeFile(
      join(folder, "native.json"),
      JSON.stringify({
        format: "ephemera.character",
        version: 1,
        data: {
          ...blankCard(`${MARK} native`),
          description: `${MARK} description`,
          lorebook: {
            entries: [
              {
                keys: [],
                content: "Native lore",
                enabled: true,
                insertionOrder: 100,
                useRegex: false,
                constant: true,
              },
            ],
          },
        },
      }),
    );
    const report = await checkCards(folder);
    expect(report.imported).toEqual({ png: 0, json: 1, v2: 0, v3: 0, native: 1 });
    expect(report.roundTrip).toEqual({ json: 1, png: 1 });
    expect(report.lorebookEntriesKept).toBe(1);
    expect(passed(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(MARK);
  });

  it("fails a card whose prompt is refused before it reaches the model", async () => {
    // A window too small for the fixed blocks: Ephemera refuses and sends nothing.
    const report = await checkCards(clean, {
      upstream: { catalog: [{ slug: "fake-model", context_window: 64 }] },
    });
    expect(report.assembled).toBe(0);
    expect(Object.values(report.assemblyRefused).reduce((a, b) => a + b, 0)).toBe(6);
    expect(passed(report)).toBe(false);
  });

  it("prints counts only and exits by the outcome", async () => {
    const run = async (folder: string) => {
      const child = Bun.spawn(["bun", "scripts/cards/check.ts", folder], {
        cwd: new URL("../../", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { output: out + err, code };
    };
    const good = await run(clean);
    const bad = await run(mixed);
    expect(good.code).toBe(0);
    expect(bad.code).toBe(1);
    for (const { output } of [good, bad]) {
      expect(output).not.toContain(MARK);
      for (const card of [v2Full, v2Minimal, v3Full]) {
        expect(output).not.toContain(String(card.data.name));
      }
    }
  }, 60_000);

  it("finds card text in a log line even where JSON escapes it", () => {
    const card = { ...blankCard("Quinn"), description: 'The first line\nsays "hello"' };
    expect(leaks([JSON.stringify({ event: "request", note: card.description })], card)).toBe(true);
    expect(leaks([JSON.stringify({ event: "request", character: "Quinn" })], card)).toBe(true);
    expect(leaks([JSON.stringify({ event: "request", route: "/api/chat" })], card)).toBe(false);
  });
});
