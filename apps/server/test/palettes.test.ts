import {
  type CustomPaletteInput,
  PALETTE_ROLES,
  type PaletteChoice,
  paletteSchemeSchema,
} from "@ephemera/core";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { ownerHeaders, requestJson, TEST_USER, testApp } from "./helpers.ts";

const scheme = (hex: string) =>
  paletteSchemeSchema.parse(Object.fromEntries(PALETTE_ROLES.map((role) => [role, hex])));

const palette = (base: PaletteChoice = "nord", name = "Dusk"): CustomPaletteInput => ({
  name,
  base,
  light: scheme("#e5e9f0"),
  dark: scheme("#2e3440"),
  origin: { light: scheme("#e5e9f0"), dark: scheme("#2e3440") },
  handSet: { light: [], dark: ["ink"] },
});

const shell: MiddlewareHandler = async (c) =>
  c.html('<!doctype html><html lang="en"><head><title>shell</title></head><body></body></html>');

function setup() {
  const { app, instances } = testApp({ appShell: shell });
  const { stores } = instances.instance(TEST_USER);
  return { app, stores };
}

describe("custom palette store", () => {
  it("creates, lists, replaces and deletes a slot", () => {
    const { stores } = setup();
    expect(stores.palettes.list()).toEqual([]);
    stores.palettes.create(3, palette("gruvbox", "Moss"));
    const saved = stores.palettes.create(1, palette());
    expect(saved).toMatchObject({ slot: 1, name: "Dusk", base: "nord" });
    const at = saved?.updatedAt ?? 0;
    expect(stores.palettes.list().map(({ slot, name }) => [slot, name])).toEqual([
      [1, "Dusk"],
      [3, "Moss"],
    ]);

    // Creating never replaces, and replacing never creates.
    expect(stores.palettes.create(1, palette("catppuccin", "Dawn"))).toBeUndefined();
    expect(stores.palettes.replace(2, palette(), at)).toBe("missing");
    // Replacing and deleting name the save they act on; a later one refuses both.
    const dawn = stores.palettes.replace(1, palette("catppuccin", "Dawn"), at);
    expect(dawn).toMatchObject({ name: "Dawn" });
    const next = typeof dawn === "object" ? dawn.updatedAt : 0;
    expect(next).toBeGreaterThan(at);
    expect(stores.palettes.replace(1, palette(), at)).toBe("changed");
    expect(stores.palettes.delete(1, at)).toBe("changed");
    expect(stores.palettes.list().map(({ slot, name }) => [slot, name])).toEqual([
      [1, "Dawn"],
      [3, "Moss"],
    ]);
    expect(stores.palettes.delete(1, next)).toBe("deleted");
    expect(stores.palettes.delete(1, next)).toBe("missing");
    expect(stores.palettes.list().map(({ slot }) => slot)).toEqual([3]);
  });

  it("refuses to choose an empty slot, as a missing reference", () => {
    const { stores } = setup();
    expect(stores.settings.update({ palette: "custom-2" })).toBeUndefined();
    expect(stores.settings.get().palette).toBe("lamplight");
    stores.palettes.create(2, palette());
    expect(stores.settings.update({ palette: "custom-2" })?.palette).toBe("custom-2");
  });

  it.each([
    ["its built-in base", "nord", "nord"],
    ["Lamplight when its base is custom", "custom-1", "lamplight"],
  ] as const)(
    "returns the settings to %s when the chosen palette is deleted",
    (_case, base, after) => {
      const { stores } = setup();
      const first = stores.palettes.create(1, palette());
      const second = stores.palettes.create(2, palette(base));
      stores.settings.update({ palette: "custom-2" });
      stores.palettes.delete(1, first?.updatedAt ?? 0);
      expect(stores.settings.get().palette).toBe("custom-2");
      stores.palettes.delete(2, second?.updatedAt ?? 0);
      expect(stores.settings.get().palette).toBe(after);
    },
  );
});

describe("custom palettes API", () => {
  it("lists, saves, replaces and deletes palettes", async () => {
    const { app } = setup();
    const list = async () =>
      (
        (await (await app.request("/api/palettes", { headers: ownerHeaders() })).json()) as {
          palettes: { slot: number; name: string }[];
        }
      ).palettes;
    expect(await list()).toEqual([]);

    expect(
      (await app.request("/api/palettes/2", requestJson("PUT", { ...palette(), updatedAt: 1 })))
        .status,
    ).toBe(404);
    const created = await app.request("/api/palettes/2", requestJson("POST", palette()));
    expect(created.status).toBe(200);
    const { palette: first } = (await created.json()) as {
      palette: { slot: number; name: string; base: string; updatedAt: number };
    };
    expect(first).toMatchObject({ slot: 2, name: "Dusk", base: "nord" });
    // A tab behind another cannot create over a palette it has not seen.
    const taken = await app.request(
      "/api/palettes/2",
      requestJson("POST", palette("nord", "Dawn")),
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "slot_taken" });
    const replaced = await app.request(
      "/api/palettes/2",
      requestJson("PUT", { ...palette("nord", "Dawn"), updatedAt: first.updatedAt }),
    );
    expect(replaced.status).toBe(200);
    const { palette: second } = (await replaced.json()) as { palette: { updatedAt: number } };
    expect((await list()).map(({ slot, name }) => [slot, name])).toEqual([[2, "Dawn"]]);
    // A tab still holding the first save is refused, for a change and for a delete.
    const stale = await app.request(
      "/api/palettes/2",
      requestJson("PUT", { ...palette(), updatedAt: first.updatedAt }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "changed" });
    expect(
      (await app.request(`/api/palettes/2?updatedAt=${first.updatedAt}`, requestJson("DELETE")))
        .status,
    ).toBe(409);

    await app.request("/api/settings", requestJson("PATCH", { palette: "custom-2" }));
    const removed = await app.request(
      `/api/palettes/2?updatedAt=${second.updatedAt}`,
      requestJson("DELETE"),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ settings: { palette: "nord" } });
    expect(await list()).toEqual([]);
    const missing = await app.request(
      `/api/palettes/2?updatedAt=${second.updatedAt}`,
      requestJson("DELETE"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
  });

  it("refuses a bad slot or palette without detail", async () => {
    const { app } = setup();
    for (const [slot, body] of [
      ["0", palette()],
      ["4", palette()],
      ["01", palette()],
      ["1", { ...palette(), light: { ...palette().light, ink: "#FFFFFF" } }],
      ["1", { ...palette(), name: "" }],
      ["1", { ...palette(), messages: [{ role: "user", content: "canary" }] }],
    ] as const) {
      const response = await app.request(`/api/palettes/${slot}`, requestJson("POST", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const refused = await app.request(
      "/api/settings",
      requestJson("PATCH", { palette: "custom-1" }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "unknown_reference" });
  });

  it("serves the stylesheet uncached, and links it on the shell only with a palette", async () => {
    const { app, stores } = setup();
    const css = async () => {
      const response = await app.request("/api/palettes.css", { headers: ownerHeaders() });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
      return response.text();
    };
    const html = async () => (await app.request("/personas", { headers: ownerHeaders() })).text();
    expect(await css()).toBe("");
    expect(await html()).not.toContain("palettes.css");

    const { updatedAt } = stores.palettes.create(3, palette()) ?? { updatedAt: 0 };
    expect(await css()).toContain(
      '[data-palette="custom-3"] {\n  --canvas-base: light-dark(#e5e9f0, #2e3440);',
    );
    expect(await html()).toContain(
      `<link rel="stylesheet" href="/api/palettes.css?v=${updatedAt}"></head>`,
    );
  });
});
