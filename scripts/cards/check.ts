/**
 * The real-card check (ARCHITECTURE.md § Native files): every card file
 * in a local folder goes through the server's own import route, is exported
 * as JSON and as PNG and read back, and assembles one reply against a fake
 * upstream. Everything stays in this process's memory: an in-memory
 * database, no network, nothing written. The report holds counts, fixed
 * codes and schema field names only, never a file name, a card field or an
 * error message, so the folder may hold private cards.
 *
 *   bun run cards:check <folder>
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pngCardJson } from "../../apps/server/src/cards.ts";
import { isPng } from "../../apps/server/src/png.ts";
import { type FakeUpstreamOptions, fakeUpstream } from "../../apps/server/test/fake-upstream.ts";
import {
  CLOCK,
  fileForm,
  formRequest,
  ownerHeaders,
  PICK_SEED,
  postJson,
  promptPart,
  streamParts,
  testApp,
} from "../../apps/server/test/helpers.ts";
import type { CharacterCard, StoredCharacter } from "../../packages/core/src/card/index.ts";
import {
  type InspectedPrompt,
  inspectedPromptSchema,
  type LorebookState,
} from "../../packages/core/src/index.ts";

const MODEL = "fake-model";
const EXTENSIONS = new Set([".png", ".json"]);

export interface CardCheckReport {
  /** Card files found (.png and .json, symlinks followed). */
  files: number;
  /** Files read as cards, by container (from the bytes) and spec. */
  imported: { png: number; json: number; v2: number; v3: number; native: number };
  /** Files the import refused, by the route's error code. */
  refused: Record<string, number>;
  /** What the imported cards use. */
  features: {
    lorebook: number;
    lorebookEntries: number;
    alternateGreetings: number;
    exampleDialogue: number;
    systemPrompt: number;
    postHistoryInstructions: number;
  };
  /** Counts of import report changes, never their potentially private wording. */
  importChanges: { kept: number; changed: number; skipped: number };
  /** Fields whose stored value differs from the file's, by field name (normalized on import). */
  normalized: Record<string, number>;
  /** Cards whose lorebook kept every entry. */
  lorebookEntriesKept: number;
  /** Cards whose JSON and PNG exports read back to the stored card. */
  roundTrip: { json: number; png: number };
  /**
   * Cards whose reply reached the fake upstream as the inspector's preview
   * of the same request shows it, with a description block whenever the
   * card's description has text outside its macros.
   */
  assembled: number;
  /** Cards whose reply did not, by status or reason. */
  assemblyRefused: Record<string, number>;
  /** Cards whose first reply sent a lorebook entry inside the chat (at a depth). */
  lorebookInChat: number;
  /** Cards whose second reply kept a lorebook entry by the timed state the first returned. */
  lorebookTimed: number;
  /** Cards whose name or text appeared in a server log line (must stay 0). */
  logged: number;
  /** Files the check itself could not finish, by stage; never by message, which may name the file. */
  failed: Record<string, number>;
}

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** The card JSON the import read, as the file carries it; undefined when it is no card. */
function rawCard(bytes: Uint8Array): { spec?: unknown; data?: unknown } | undefined {
  try {
    if (isPng(bytes)) {
      const read = pngCardJson(bytes);
      return read.ok ? JSON.parse(read.json) : undefined;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

const upload = (bytes: Uint8Array, name: string) => formRequest("POST", fileForm(bytes, name));

/** Every string a JSON log line holds, decoded, however deep. */
function logStrings(line: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(line));
  } catch {
    found.push(line);
  }
  return found;
}

/**
 * Whether any of these log lines carries the card's text: its name as a
 * whole value, or the opening of a longer field anywhere in a value.
 */
export function leaks(lines: string[], card: CharacterCard): boolean {
  const openings = [
    card.name,
    card.description,
    card.firstMessage,
    card.personality,
    card.scenario,
    card.exampleDialogue,
  ]
    .map((text) => text.trim().slice(0, 40))
    .filter((text) => text.length >= 6);
  return lines.some((line) =>
    logStrings(line).some(
      (value) => value === card.name || openings.some((text) => value.includes(text)),
    ),
  );
}

/** The card files in a folder, symlinks to files included, in a stable order. */
async function cardFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) continue;
    const file =
      entry.isFile() ||
      (entry.isSymbolicLink() &&
        (await stat(join(dir, entry.name)).then(
          (target) => target.isFile(),
          // A broken link is still a card file, one that cannot be read.
          () => true,
        )));
    if (file) names.push(entry.name);
  }
  return names.sort();
}

/**
 * Whether text keeps something once its macros are expanded: text outside
 * `{{...}}` always survives, while macros alone (a comment, `{{noop}}`) may
 * expand to nothing, and assembly then leaves the block out.
 */
const literal = (text: string) => text.replace(/\{\{[\s\S]*?\}\}/g, "").trim() !== "";

type Wire = { role: string; content: string; name?: string };
const wire = (messages: Wire[]) =>
  messages.map(({ role, content, name }) =>
    name === undefined ? { role, content } : { role, content, name },
  );

export async function checkCards(
  dir: string,
  options: { upstream?: FakeUpstreamOptions } = {},
): Promise<CardCheckReport> {
  const names = await cardFiles(dir);
  const report: CardCheckReport = {
    files: names.length,
    imported: { png: 0, json: 0, v2: 0, v3: 0, native: 0 },
    refused: {},
    features: {
      lorebook: 0,
      lorebookEntries: 0,
      alternateGreetings: 0,
      exampleDialogue: 0,
      systemPrompt: 0,
      postHistoryInstructions: 0,
    },
    importChanges: { kept: 0, changed: 0, skipped: 0 },
    normalized: {},
    lorebookEntriesKept: 0,
    roundTrip: { json: 0, png: 0 },
    assembled: 0,
    assemblyRefused: {},
    lorebookInChat: 0,
    lorebookTimed: 0,
    logged: 0,
    failed: {},
  };
  const upstream = fakeUpstream(options.upstream ?? { chunks: ["Synthetic."] });
  const { app, lines } = testApp({
    fetch: upstream.fetch,
    // {{random}} then chooses alike in the preview and the reply it is compared with.
    random: () => 0.5,
  });
  const stored = async (id: string) =>
    (
      (await (
        await app.request(`/api/characters/${id}`, { headers: ownerHeaders() })
      ).json()) as StoredCharacter
    ).card;
  const reimported = async (bytes: Uint8Array, name: string) => {
    const response = await app.request("/api/characters/import", upload(bytes, name));
    if (response.status !== 201) return undefined;
    return stored(((await response.json()) as { id: string }).id);
  };

  const checkOne = async (index: number, name: string, stage: { at: string }) => {
    const firstLine = lines.length;
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    const png = isPng(bytes);
    stage.at = "import";
    // The route sees a neutral name: the file's own name may say what the card is.
    const neutral = `card-${index}.${png ? "png" : "json"}`;
    const response = await app.request("/api/characters/import", upload(bytes, neutral));
    if (response.status !== 201) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      bump(report.refused, typeof body.error === "string" ? body.error : String(response.status));
      return;
    }
    const imported = (await response.json()) as {
      id: string;
      report: { kept: string[]; changed: string[]; skipped: string[] };
    };
    const card = await stored(imported.id);
    const raw = rawCard(bytes);
    report.imported[png ? "png" : "json"] += 1;
    report.imported[
      raw && "format" in raw ? "native" : raw?.spec === "chara_card_v3" ? "v3" : "v2"
    ] += 1;
    for (const group of ["kept", "changed", "skipped"] as const)
      report.importChanges[group] += imported.report[group].length;

    const entries = card.lorebook?.entries.length ?? 0;
    if (card.lorebook !== undefined) report.features.lorebook += 1;
    report.features.lorebookEntries += entries;
    if (card.alternateGreetings.length > 0) report.features.alternateGreetings += 1;
    if (card.exampleDialogue.trim() !== "") report.features.exampleDialogue += 1;
    if (card.systemPrompt.trim() !== "") report.features.systemPrompt += 1;
    if (card.postHistoryInstructions.trim() !== "") report.features.postHistoryInstructions += 1;

    // The file's own fields against the stored card: what import normalized.
    const data = (raw?.data ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (key === "extensions" || key === "character_book" || !Object.hasOwn(card, key)) continue;
      if (!isDeepStrictEqual(card[key as keyof CharacterCard], value)) bump(report.normalized, key);
    }
    const rawBook = raw && "format" in raw ? data.lorebook : data.character_book;
    const rawEntries = (rawBook as { entries?: unknown[] } | undefined)?.entries;
    if ((rawEntries?.length ?? 0) === entries) report.lorebookEntriesKept += 1;

    stage.at = "export";
    for (const format of ["json", "png"] as const) {
      const exported = await app.request(`/api/characters/${imported.id}/export.${format}`, {
        headers: ownerHeaders(),
      });
      const again = await reimported(
        new Uint8Array(await exported.arrayBuffer()),
        `again.${format}`,
      );
      if (again !== undefined && isDeepStrictEqual(again, card)) report.roundTrip[format] += 1;
    }

    stage.at = "chat";
    /**
     * One exchange as the web app makes it: the inspector's preview and the
     * reply, both carrying the timed state the chat store holds. Null when
     * they agree, with the reply's prompt; otherwise the reason.
     */
    const exchange = async (
      messages: { role: string; content: string }[],
      lorebookState: LorebookState | null,
    ): Promise<{ refused: string } | { refused: null; prompt: InspectedPrompt }> => {
      const request = {
        model: MODEL,
        characterId: imported.id,
        clock: CLOCK,
        pickSeed: PICK_SEED,
        messages,
        ...(lorebookState === null ? {} : { lorebookState }),
      };
      const preview = await app.request("/api/chat/preview", postJson(request));
      if (!preview.ok) return { refused: `preview-${preview.status}` };
      const shown = inspectedPromptSchema.parse(
        ((await preview.json()) as { prompt: unknown }).prompt,
      );
      const sent = upstream.records.length;
      const chat = await app.request("/api/chat", postJson(request));
      const parts = streamParts(await chat.text());
      if (chat.status !== 200 || upstream.records.length !== sent + 1) {
        return { refused: String(chat.status) };
      }
      const prompt = promptPart(parts);
      const body = upstream.records.at(-1)?.body as { messages?: Wire[] } | undefined;
      if (!isDeepStrictEqual(wire(body?.messages ?? []), wire(shown.messages))) {
        return { refused: "differs-from-preview" };
      }
      if (!isDeepStrictEqual(prompt.lorebookState, shown.lorebookState)) {
        return { refused: "state-differs-from-preview" };
      }
      return { refused: null, prompt };
    };

    const opening = [
      ...(card.firstMessage.trim() === ""
        ? []
        : [{ role: "assistant", content: card.firstMessage }]),
      { role: "user", content: "Hello." },
    ];
    const first = await exchange(opening, null);
    const described =
      first.refused === null &&
      first.prompt.messages.some(
        (message) =>
          message.source.kind === "block" &&
          message.source.id === "charDescription" &&
          message.content.trim() !== "",
      );
    // The second exchange carries the state the first left, as the chat store would.
    const second =
      first.refused === null
        ? await exchange(
            [
              ...opening,
              { role: "assistant", content: "Synthetic." },
              { role: "user", content: "Go on." },
            ],
            first.prompt.lorebookState,
          )
        : first;
    if (first.refused !== null) bump(report.assemblyRefused, first.refused);
    else if (second.refused !== null) bump(report.assemblyRefused, second.refused);
    else if (literal(card.description) && !described) {
      bump(report.assemblyRefused, "description-missing");
    } else {
      report.assembled += 1;
      const inChat = first.prompt.messages.some(
        ({ source }) => source.kind === "lorebook" && source.position === "depth",
      );
      if (inChat) report.lorebookInChat += 1;
      const held = second.prompt.lorebook?.entries.some(
        (entry) => entry.status === "sent" && entry.reason?.kind === "sticky",
      );
      if (held === true) report.lorebookTimed += 1;
    }

    // Only this card's own lines: its import, exports, preview and reply.
    if (leaks(lines.slice(firstLine), card)) report.logged += 1;
  };

  for (const [index, name] of names.entries()) {
    const stage = { at: "read" };
    try {
      await checkOne(index, name, stage);
    } catch {
      bump(report.failed, stage.at);
    }
  }
  return report;
}

/** Every file imported, round-tripped both ways and assembled, and no card text logged. */
export function passed(report: CardCheckReport): boolean {
  const imported = report.imported.png + report.imported.json;
  return (
    report.files > 0 &&
    imported === report.files &&
    report.roundTrip.json === imported &&
    report.roundTrip.png === imported &&
    report.assembled === imported &&
    report.logged === 0
  );
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error("usage: bun run cards:check <folder>");
    process.exit(2);
  }
  // A thrown error can carry a path; only a fixed line is printed.
  const report = await checkCards(dir).catch(() => undefined);
  if (report === undefined) {
    console.error("cards:check could not list the folder");
    process.exit(2);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(passed(report) ? 0 : 1);
}
