import {
  type CastSheet,
  type CastSheetEntry,
  type CastSheetResponse,
  DEFAULT_SETTINGS,
  emptyCastAnchor,
  type StoredCharacter,
} from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateCachedCharacter } from "../characters/queries.ts";
import { CAST_KEPT, CastSection, CastSheetView, readCastSheet } from "./CastSection.tsx";
import { CAST_SHEET_KEY, ensureCastSheet } from "./queries.ts";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("./queries.ts", async (original) => ({
  ...(await original<typeof import("./queries.ts")>()),
  ensureCastSheet: vi.fn(),
}));

const CHARACTER = "5a1e2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const person = (
  n: number,
  name: string,
  age: string,
  gender: "female" | "male" | "other" = "female",
): CastSheetEntry => ({
  id: uuid(n),
  role: "principal",
  anchor: { ...emptyCastAnchor(name, gender), age },
  aka: [],
});

const sheetOf = (entries: CastSheetEntry[], fingerprint = "a"): CastSheet => ({
  characterId: CHARACTER,
  fingerprint: fingerprint.repeat(64),
  entries,
  revision: 0,
  updatedAt: 0,
});

const MIRA_AND_JONAH = sheetOf([
  person(1, "Mira Vale", "24, looks younger"),
  person(2, "Jonah", "31", "male"),
]);

/** Renders the section with the sheet loaded, or its load failed. */
function render(response: CastSheetResponse | "failed", client = new QueryClient()) {
  if (response === "failed") {
    client
      .getQueryCache()
      .build(client, { queryKey: CAST_SHEET_KEY(CHARACTER) })
      .setState({ status: "error", error: new Error("unavailable"), fetchStatus: "idle" });
  } else client.setQueryData(CAST_SHEET_KEY(CHARACTER), response);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CastSection id={CHARACTER} name="Mira" />
    </QueryClientProvider>,
  );
}

const view = (props: Partial<Parameters<typeof CastSheetView>[0]> = {}) =>
  renderToStaticMarkup(
    <CastSheetView
      response={{ sheet: MIRA_AND_JONAH, current: false }}
      working={false}
      failure={null}
      onRead={() => {}}
      {...props}
    />,
  );

beforeEach(() => vi.mocked(ensureCastSheet).mockReset());

describe("the character sheet's Cast section", () => {
  it("offers Read now when no sheet was read yet", () => {
    const out = render({ sheet: null, current: false });
    expect(out).toContain("No cast sheet yet. One is read from the card when a chat starts.");
    expect(out).toContain("Read the cast now");
    expect(out).not.toContain("Regenerate the cast");
  });

  it("lists every subject by name and age when current, men included, says what the sheet is for, and keeps a quiet Regenerate", () => {
    const out = render({ sheet: MIRA_AND_JONAH, current: true });
    expect(out).toContain("Mira Vale");
    expect(out).toContain("(24)");
    expect(out).toContain("Jonah");
    expect(out).toContain("(31)");
    expect(out).toContain(CAST_KEPT);
    expect(out.split("<button").length - 1).toBe(1);
    expect(out).toContain(">Regenerate the cast</button>");
    expect(out).not.toContain("The card changed since this was read.");
  });

  it("asks again once the card is saved, and says when the card changed since with Regenerate", () => {
    const client = new QueryClient();
    client.setQueryData(CAST_SHEET_KEY(CHARACTER), { sheet: MIRA_AND_JONAH, current: true });
    client.setQueryData(["characters", CHARACTER], { revision: 1 } as unknown as StoredCharacter);
    updateCachedCharacter(client, CHARACTER, { revision: 2 });
    expect(client.getQueryState(CAST_SHEET_KEY(CHARACTER))?.isInvalidated).toBe(false);
    updateCachedCharacter(client, CHARACTER, {
      card: {} as StoredCharacter["card"],
      revision: 3,
    });
    expect(client.getQueryState(CAST_SHEET_KEY(CHARACTER))?.isInvalidated).toBe(true);

    const out = render({ sheet: MIRA_AND_JONAH, current: false });
    expect(out).toContain("Mira Vale");
    expect(out).toContain("The card changed since this was read.");
    expect(out).toContain("Regenerate the cast");
  });

  it("regenerates with the cast model and shows the new names", async () => {
    const client = new QueryClient();
    client.setQueryData(CAST_SHEET_KEY(CHARACTER), { sheet: MIRA_AND_JONAH, current: false });
    vi.mocked(ensureCastSheet).mockResolvedValue({
      ok: true,
      current: true,
      sheet: sheetOf([person(3, "Mira Vale", "24"), person(4, "Ada", "19")], "b"),
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      castModel: "cast-model",
      castReasoning: "low" as const,
    };
    expect(await readCastSheet(client, CHARACTER, settings, true)).toBeNull();
    expect(ensureCastSheet).toHaveBeenCalledWith(
      CHARACTER,
      { model: "cast-model", reasoning: "low", force: true },
      expect.any(AbortSignal),
    );
    const out = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CastSection id={CHARACTER} name="Mira" />
      </QueryClientProvider>,
    );
    expect(out).toContain("Ada");
    expect(out).not.toContain("Jonah");
    expect(out).not.toContain("The card changed since this was read.");
  });

  it("says Reading the card while the call runs, its button held", () => {
    const out = view({ working: true });
    expect(out).toContain("Reading the card");
    expect(out).not.toContain("The card changed since this was read.");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Regenerate the cast/);
  });

  it("says why a read failed, and keeps the way to try again", async () => {
    const busy = view({ failure: "upstream_busy" });
    expect(busy).toContain('role="alert"');
    expect(busy).toContain("The cast was not read: the cast model is busy. Try again in a moment.");
    expect(busy).toContain("Regenerate the cast");

    vi.mocked(ensureCastSheet).mockResolvedValue({ ok: false, reason: "prompt_too_long" });
    const client = new QueryClient();
    const settings = { ...DEFAULT_SETTINGS, model: "reply-model" };
    expect(await readCastSheet(client, CHARACTER, settings, false)).toBe("prompt_too_long");
    expect(client.getQueryData(CAST_SHEET_KEY(CHARACTER))).toBeUndefined();
    expect(
      view({ response: { sheet: null, current: false }, failure: "prompt_too_long" }),
    ).toContain(
      // Apostrophes escaped as markup.
      "The cast was not read: the card is too long for the cast model&#x27;s context window.",
    );
  });

  it("keeps the server's word on whether the sheet read is current", async () => {
    const client = new QueryClient();
    const stale = sheetOf([person(3, "Mira Vale", "24")], "c");
    vi.mocked(ensureCastSheet).mockResolvedValue({ ok: true, sheet: stale, current: false });
    const settings = { ...DEFAULT_SETTINGS, castModel: "cast-model" };
    expect(await readCastSheet(client, CHARACTER, settings, false)).toBeNull();
    expect(client.getQueryData(CAST_SHEET_KEY(CHARACTER))).toEqual({
      sheet: stale,
      current: false,
    });
  });

  it("asks nothing without a model, and says where to choose one", async () => {
    const settings = { ...DEFAULT_SETTINGS, model: null, memoryModel: null, castModel: null };
    expect(await readCastSheet(new QueryClient(), CHARACTER, settings, false)).toBe("no_model");
    expect(ensureCastSheet).not.toHaveBeenCalled();
    const none = view({ failure: "no_model" });
    expect(none).toContain("The cast was not read: no model is chosen to write it.");
    expect(none).toContain("Cast settings");
  });

  it("offers to load the sheet again when it could not be loaded", () => {
    // As the sheet holds it after the failed load, not asking again on its own.
    const out = render(
      "failed",
      new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } }),
    );
    expect(out).toContain("The cast could not be loaded.");
    expect(out).toContain("Load the cast again");
  });
});
