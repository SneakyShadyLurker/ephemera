import { CREATOR_ART, DEFAULT_SETTINGS } from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { modelsQuery } from "../api.ts";
import { settingsQuery } from "../settings/settings.ts";
import { ArtStack } from "./ArtStack.tsx";
import type { DecodedBatch } from "./art.ts";
import { ArtSessionProvider } from "./art-session.tsx";
import { ART_EMPTY, type ArtRun, type ArtSliceState, createArtSlice } from "./art-slice.ts";

/** The decode the test sets: the batch's bitmaps arrive in effects, which a static render runs none of. */
const decode = vi.hoisted(() => ({ status: "decoding" as "decoding" | "ready" }));

vi.mock("./art.ts", async (original) => {
  const actual = await original<typeof import("./art.ts")>();
  const bitmap: ImageBitmap = { width: 2, height: 3, close: () => {} };
  return {
    ...actual,
    useDecodedBatch: (_store: unknown, images: unknown[]): DecodedBatch =>
      images.length === 0
        ? { status: "none" }
        : decode.status === "decoding"
          ? { status: "decoding" }
          : {
              status: "ready",
              bitmaps: images.map(() => bitmap),
              pixels: images.map(() => new Uint8ClampedArray(4)),
            },
  };
});
// The creator's own session (the direction field's look comes from its Describe screen) stays out.
vi.mock("./session.ts", () => ({}));
vi.mock("@/app/theme.tsx", () => ({ useScheme: () => "light" }));
vi.mock("@/app/reduced-motion.ts", () => ({ useReducedMotion: () => false }));

/** An art session holding `art` and `count` portraits, as a host's store would. */
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

/** The showcase's art for Ada Reed on the desktop, through the provider. */
function render(store: ReturnType<typeof session>) {
  const client = new QueryClient();
  client.setQueryData(settingsQuery.queryKey, {
    ...DEFAULT_SETTINGS,
    comfyuiBaseUrl: "http://127.0.0.1:8188",
  });
  client.setQueryData(modelsQuery.queryKey, []);
  const ref = { current: null };
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ArtSessionProvider
        host={{
          store,
          kind: "subject",
          defaults: { model: "model-a", reasoning: "provider-default" },
          locked: false,
          leaving: false,
          copy: { off: "Off.", stopped: "Stopped.", unavailable: "Portraits unavailable." },
          focusAfter: () => null,
        }}
      >
        <ArtStack name="Ada Reed" phone={false} newArt={ref} again={ref} />
      </ArtSessionProvider>
    </QueryClientProvider>,
  );
}

const RUNNING: ArtRun = {
  status: "running",
  phase: "status",
  value: 0,
  max: 1,
  started: 0,
  heard: 0,
};

describe("the showcase's art regions", () => {
  it("while the first batch develops: the leaf with its stage and Stop, no choices", () => {
    const out = render(session(RUNNING));
    // The name on the leaf, word by word.
    expect(out).toContain(">Reed</span>");
    expect(out).toContain("Checking ComfyUI");
    expect(out).toContain(">Stop</button>");
    expect(out).not.toContain('role="radiogroup"');
    expect(out).not.toContain('aria-label="Next art"');
    expect(out).not.toContain("Portraits ready.");
  });

  it("without a batch after a failure: the reason, Try the art again and the choices", () => {
    const out = render(session({ status: "failed", code: "not_found" }));
    expect(out).toContain("Portraits unavailable.");
    expect(out).toContain("This character was deleted.");
    expect(out).toContain("Try the art again");
    expect(out).toContain('aria-label="Next art"');
    expect(out).toContain('aria-label="Direction for the next art"');
    expect(out).not.toContain(">Stop</button>");
    expect(out).not.toContain('role="radiogroup"');
  });

  it("with a batch on show: the four as Portraits, New art and the choices", () => {
    decode.status = "ready";
    const out = render(session({ status: "complete" }, CREATOR_ART.count));
    expect(out).toContain('role="radiogroup" aria-label="Portraits"');
    expect(out.match(/role="radio"/g)).toHaveLength(CREATOR_ART.count);
    expect(out).toContain('aria-label="Portrait of Ada Reed, option 2 of 4"');
    expect(out).toContain("New art");
    expect(out).toContain('aria-label="Next art"');
    expect(out).toContain("develop-in");
    expect(out).not.toContain(">Stop</button>");
    expect(out).toContain("Portraits ready.");
  });

  it("says Portraits ready once the batch is decoded, not when its stream completes", () => {
    decode.status = "decoding";
    const out = render(session({ status: "complete" }, CREATOR_ART.count));
    expect(out).not.toContain("Portraits ready.");
    expect(out).not.toContain('role="radiogroup"');
  });
});
