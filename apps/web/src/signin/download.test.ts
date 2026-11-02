import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ settings: vi.fn(), file: vi.fn() }));
vi.mock("../api.ts", () => ({ api: { settings: { $get: calls.settings } }, apiFetch: calls.file }));

import { downloadWhenSignedIn } from "./download.ts";

function click() {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    currentTarget: { href: "/api/presets/prompt/id/export", download: "Preset.json" },
  } as unknown as MouseEvent<HTMLAnchorElement>;
}

const link = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
const append = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  calls.settings.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("document", { createElement: () => link, body: { append } });
});
afterEach(() => vi.unstubAllGlobals());

describe("native export downloads", () => {
  it("waits for a successful flush before checking the session and downloading", async () => {
    let settle: (saved: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    calls.file.mockResolvedValue(new Response("native file"));
    downloadWhenSignedIn(click(), () => ready);
    expect(calls.settings).not.toHaveBeenCalled();
    settle(true);
    await vi.waitFor(() => expect(link.click).toHaveBeenCalledOnce());
    expect(link.href).toBe("/api/presets/prompt/id/export");
    expect(link.download).toBe("Preset.json");
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it("does not export failed or conflicting edits", async () => {
    const ready = vi.fn().mockResolvedValue(false);
    downloadWhenSignedIn(click(), ready);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(calls.settings).not.toHaveBeenCalled();
    expect(calls.file).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("reports an oversized readable item inline and creates no download", async () => {
    calls.file.mockResolvedValue(new Response(null, { status: 413 }));
    const error = vi.fn();
    downloadWhenSignedIn(click(), async () => true, error);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Not exported: this saved item exceeds the file limits. Shorten its text, then try again.",
      ),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("keeps the tab in place when the native export fails", async () => {
    calls.file.mockRejectedValue(new TypeError("Network unavailable"));
    const error = vi.fn();
    downloadWhenSignedIn(click(), async () => true, error);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Not exported: the file could not be prepared. Try again.",
      ),
    );
    expect(append).not.toHaveBeenCalled();
  });
});
