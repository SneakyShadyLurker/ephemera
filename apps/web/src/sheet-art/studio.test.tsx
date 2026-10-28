import { CREATOR_ART, DEFAULT_SETTINGS } from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { modelsQuery } from "../api.ts";
import type { DecodedBatch } from "../creator/art.ts";
import { ArtSessionProvider } from "../creator/art-session.tsx";
import {
  ART_EMPTY,
  type ArtRun,
  type ArtSliceState,
  createArtSlice,
} from "../creator/art-slice.ts";
import { settingsQuery } from "../settings/settings.ts";
import { StudioPrimary } from "./ArtStudio.tsx";
import type { UseRun } from "./store.ts";

// A batch is decoded at once here: the bitmaps arrive in effects, which a static render runs none of.
vi.mock("../creator/art.ts", async (original) => {
  const actual = await original<typeof import("../creator/art.ts")>();
  const bitmap: ImageBitmap = { width: 2, height: 3, close: () => {} };
  return {
    ...actual,
    useDecodedBatch: (_store: unknown, images: unknown[]): DecodedBatch =>
      images.length === 0
        ? { status: "none" }
        : {
            status: "ready",
            bitmaps: images.map(() => bitmap),
            pixels: images.map(() => new Uint8ClampedArray(4)),
          },
  };
});
// The tab's own session (its page listeners) stays out; the footer reads the store it is given.
vi.mock("./session.ts", () => ({}));
vi.mock("../creator/session.ts", () => ({}));
vi.mock("@/app/theme.tsx", () => ({ useScheme: () => "light" }));
vi.mock("@/app/reduced-motion.ts", () => ({ useReducedMotion: () => false }));

/** An art session holding `art` and `count` candidates. */
function session(art: ArtRun | null, count = 0) {
  return createStore<ArtSliceState>()((set, get) => ({
    epoch: 0,
    ...ART_EMPTY,
    art,
    images: Array.from({ length: count }, () => new Uint8Array(new ArrayBuffer(8))),
    ...createArtSlice(set, get, {
      streamArt: async () => {
        throw new Error("Nothing is painted here");
      },
      artStatus: async () => ({ state: "ready" }),
      subject: () => null,
      locked: () => false,
      register: () => () => {},
    }),
  }));
}

/** The studio's footer action over `store`; `held`: a rework or a save holds the portrait. */
function primary(
  store: ReturnType<typeof session>,
  {
    useRun = null,
    held = false,
    noModel = false,
  }: { useRun?: UseRun | null; held?: boolean; noModel?: boolean } = {},
) {
  const client = new QueryClient();
  client.setQueryData(settingsQuery.queryKey, {
    ...DEFAULT_SETTINGS,
    comfyuiBaseUrl: "http://127.0.0.1:8188",
  });
  client.setQueryData(modelsQuery.queryKey, []);
  const out = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ArtSessionProvider
        host={{
          store,
          kind: "subject",
          defaults: { model: "model-a", reasoning: "provider-default" },
          locked: held,
          leaving: false,
          copy: { off: "Off.", stopped: "Art stopped.", unavailable: "Portraits unavailable." },
          focusAfter: () => null,
        }}
      >
        <StudioPrimary useRun={useRun} noModel={noModel} onUse={() => {}} />
      </ArtSessionProvider>
    </QueryClientProvider>,
  );
  // The one button, without the provider's status line.
  const button = out.match(/<button[^>]*>.*?<\/button>/)?.[0] ?? "";
  return { button, disabled: button.includes('aria-disabled="true"') };
}

const RUNNING: ArtRun = {
  status: "running",
  phase: "status",
  value: 0,
  max: 1,
  started: 0,
  heard: 0,
};

describe("the studio's primary action", () => {
  it("is New art until a batch is on show", () => {
    const { button, disabled } = primary(session(null));
    expect(button).toContain("New art");
    expect(button).toContain("bg-dusk");
    expect(disabled).toBe(false);
  });

  it("waits without a model to write the image prompt", () => {
    const { button, disabled } = primary(session(null), { noModel: true });
    expect(button).toContain("New art");
    expect(disabled).toBe(true);
  });

  it("hands over to Use as portrait once a batch is on show", () => {
    const { button, disabled } = primary(session({ status: "complete" }, CREATOR_ART.count));
    expect(button).toContain("Use as portrait");
    expect(button).not.toContain("New art");
    expect(disabled).toBe(false);
  });

  it("keeps Use as portrait, disabled, while the next batch paints", () => {
    const { button, disabled } = primary(session(RUNNING, CREATOR_ART.count));
    expect(button).toContain("Use as portrait");
    expect(disabled).toBe(true);
  });

  it("says Saving portrait while the upload runs, and Retry save after it failed", () => {
    const store = session({ status: "complete" }, CREATOR_ART.count);
    const saving = primary(store, { useRun: { status: "saving" }, held: true });
    expect(saving.button).toContain("Saving portrait…");
    expect(saving.disabled).toBe(true);
    const failed = primary(store, {
      useRun: { status: "failed", reason: "That image could not be read." },
    });
    expect(failed.button).toContain("Retry save");
    expect(failed.disabled).toBe(false);
  });

  it("waits while the sheet holds the portrait (a rework)", () => {
    expect(
      primary(session({ status: "complete" }, CREATOR_ART.count), { held: true }).disabled,
    ).toBe(true);
    expect(primary(session(null), { held: true }).disabled).toBe(true);
  });
});
