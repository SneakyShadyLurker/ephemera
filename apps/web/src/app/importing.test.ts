import { describe, expect, it } from "vitest";
import { type ImportIds, importFile } from "./importing.ts";

const REASONS = { invalid: "it isn't a file Ephemera can read" };
const read = (body: unknown) => body as { id: string };

/** Imports `file`, answering with `answer`; the ids the route was given. */
async function send(file: File, answer: () => Promise<Response>, kind = "characters") {
  let seen: ImportIds | undefined;
  const outcome = await importFile(
    kind,
    file,
    (_init, ids) => {
      seen = ids;
      return answer();
    },
    REASONS,
    read,
  );
  if (seen === undefined) throw new Error("the import was not sent");
  return { outcome, ids: seen };
}

const stored = async () => Response.json({ id: "stored" }, { status: 201 });

describe("an import whose answer never came", () => {
  it.each([
    ["the request failed", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["the answer was not Ephemera's", async () => new Response("<html>", { status: 200 })],
    ["the server failed", async () => new Response(null, { status: 502 })],
  ])("sends the same file again under the same ids when %s", async (_label, lost) => {
    const file = new File(["{}"], "mara.json", { lastModified: 1 });
    const first = await send(file, lost);
    expect(first.outcome.ok).toBe(false);
    // The same file, picked again: a new File object with the same name, size and date.
    const again = await send(new File(["{}"], "mara.json", { lastModified: 1 }), stored);
    expect(again.outcome.ok).toBe(true);
    expect(again.ids).toEqual(first.ids);
    // Once answered, the file imports as a new record.
    expect((await send(file, stored)).ids).not.toEqual(first.ids);
  });

  it("gives a file with other bytes its own ids, whatever its name, size and date", async () => {
    const lost = () => Promise.reject(new TypeError("Failed to fetch"));
    const first = await send(new File(['{"a":1}'], "ilse.json", { lastModified: 1 }), lost);
    const other = await send(new File(['{"a":2}'], "ilse.json", { lastModified: 1 }), stored);
    expect(other.ids).not.toEqual(first.ids);
    expect(other.ids.id).not.toBe(other.ids.pairId);
  });

  it("gives the same file its own ids in another kind of import", async () => {
    const lost = () => Promise.reject(new TypeError("Failed to fetch"));
    const file = new File(['{"entries":{}}'], "harbour.json", { lastModified: 1 });
    const first = await send(file, lost, "characters");
    expect((await send(file, stored, "lorebooks")).ids).not.toEqual(first.ids);
    // The first import is still unanswered: sent again, it keeps its ids.
    expect((await send(file, stored, "characters")).ids).toEqual(first.ids);
  });
});

describe("an answered import", () => {
  it("imports the same file again as a new record after a refusal", async () => {
    const file = new File(["{}"], "refused.json", { lastModified: 1 });
    const refused = await send(file, async () =>
      Response.json({ error: "invalid", field: "name" }, { status: 422 }),
    );
    expect(refused.outcome).toMatchObject({
      ok: false,
      reason: "it isn't a file Ephemera can read (name)",
    });
    expect((await send(file, stored)).ids).not.toEqual(refused.ids);
  });
});

describe("a file past what any import accepts", () => {
  it("is sent as it is, without its bytes being read here", async () => {
    const file = new File(["{}"], "huge.json", { lastModified: 1 });
    Object.defineProperty(file, "size", { value: 1024 ** 3 });
    let read = false;
    file.arrayBuffer = () => {
      read = true;
      return Promise.resolve(new ArrayBuffer(0));
    };
    const refused = await send(file, async () => new Response(null, { status: 413 }));
    expect(refused.outcome).toMatchObject({ ok: false });
    expect(read).toBe(false);
  });
});
