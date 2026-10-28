import type { SettingsPatch } from "@ephemera/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failedSettingsPatch,
  refusedSettingsSave,
  retainSettingsSaveHistory,
  SETTINGS_MUTATION_KEY,
  SETTINGS_SAVE_GC_TIME,
  settingsResendParts,
} from "./save-history.ts";

function setup() {
  const client = new QueryClient();
  const cache = client.getMutationCache();
  retainSettingsSaveHistory(cache);
  const save = (patch: SettingsPatch, succeeds = false, reason = "unreachable") => {
    const mutation = cache.build(client, {
      mutationKey: SETTINGS_MUTATION_KEY,
      gcTime: SETTINGS_SAVE_GC_TIME,
      scope: { id: "settings" },
      mutationFn: async (_patch: SettingsPatch) => {
        if (!succeeds) throw new Error(reason);
      },
    });
    return mutation.execute(patch).catch(() => undefined);
  };
  const failed = () =>
    failedSettingsPatch(
      cache.getAll().map((mutation) => ({
        status: mutation.state.status,
        patch: mutation.state.variables as SettingsPatch,
        error: mutation.state.error?.message,
      })),
    );
  return { client, cache, save, failed };
}

afterEach(() => vi.useRealTimers());

describe("tab-memory settings save history", () => {
  it("retains failures beyond five minutes without observers, and clears a successful retry", async () => {
    vi.useFakeTimers();
    const { cache, save, failed } = setup();
    await save({ model: "my-model" });
    await vi.advanceTimersByTimeAsync(301_000);
    expect(failed()).toEqual({ model: "my-model" });
    expect(cache.getAll()[0]?.options.gcTime).toBe(Number.POSITIVE_INFINITY);
    await save(failed() ?? {}, true);
    expect(failed()).toBeUndefined();
    expect(cache.getAll()).toHaveLength(0);
  });

  it("keeps unrelated failures and masks a partially superseded field", async () => {
    const { save, failed, cache } = setup();
    await save({ model: "failed-model", theme: "dark" });
    await save({ theme: "light" }, true);
    await save({ characterId: null }, true);
    expect(failed()).toEqual({ model: "failed-model" });
    expect(cache.getAll()).toHaveLength(2);
    await save({ model: "latest-model" }, true);
    expect(failed()).toBeUndefined();
    expect(cache.getAll()).toHaveLength(0);
  });

  it("a failed retry owns the latest fields and repeated outcomes keep history bounded", async () => {
    const { save, failed, cache } = setup();
    await save({ model: "old", theme: "dark" });
    await save({ theme: "light" }, true);
    for (let i = 0; i < 30; i++) await save({ model: `failed-${i}` });
    expect(failed()).toEqual({ model: "failed-29" });
    expect(cache.getAll()).toHaveLength(1);
  });

  it("keeps queued scoped updates until their final outcome", async () => {
    const { client, cache, save, failed } = setup();
    await save({ model: "old" });
    const first = Promise.withResolvers<void>();
    const mutation = (fn: () => Promise<void>) =>
      cache.build(client, {
        mutationKey: SETTINGS_MUTATION_KEY,
        gcTime: SETTINGS_SAVE_GC_TIME,
        scope: { id: "settings" },
        mutationFn: (_patch: SettingsPatch) => fn(),
      });
    const running = mutation(() => first.promise).execute({ theme: "dark" });
    const queuedFn = vi.fn(async () => {
      throw new Error("unreachable");
    });
    const queued = mutation(queuedFn)
      .execute({ model: "new" })
      .catch(() => undefined);
    await Promise.resolve();
    expect(queuedFn).not.toHaveBeenCalled();
    expect(failed()).toBeUndefined();
    first.resolve();
    await running;
    await queued;
    expect(failed()).toEqual({ model: "new" });
    expect(cache.getAll()).toHaveLength(1);
  });

  it("resends only what failed for a reason worth retrying; a refusal is final", async () => {
    const { save, failed } = setup();
    await save({ theme: "dark" }, false, "signed_out");
    await save({ characterId: "gone" }, false, "signed_out");
    expect(failed()).toEqual({ theme: "dark", characterId: "gone" });
    // The server refused the stale reference: it is not sent again, and it masks the older value.
    await save({ characterId: "gone" }, false, "unknown_reference");
    expect(failed()).toEqual({ theme: "dark" });
  });

  it("sends plain fields together and each reference and the address alone, so one refusal blocks nothing else", () => {
    expect(
      settingsResendParts({
        theme: "dark",
        model: "m",
        characterId: "c",
        personaId: null,
        defaultPersonaId: "d",
        promptPresetId: "p",
        samplerPresetId: "s",
        comfyuiBaseUrl: "https://elsewhere.test",
      }),
    ).toEqual([
      { theme: "dark", model: "m" },
      { characterId: "c" },
      { personaId: null },
      { defaultPersonaId: "d" },
      { promptPresetId: "p" },
      { samplerPresetId: "s" },
      { comfyuiBaseUrl: "https://elsewhere.test" },
    ]);
    expect(settingsResendParts({ theme: "light" })).toEqual([{ theme: "light" }]);
  });

  it("a refusal stays visible until a later save carries its fields", async () => {
    const { save, cache } = setup();
    const refused = () =>
      refusedSettingsSave(
        cache.getAll().map((mutation) => ({
          status: mutation.state.status,
          patch: mutation.state.variables as SettingsPatch,
          error: mutation.state.error?.message,
        })),
      );
    await save({ characterId: "gone" }, false, "unknown_reference");
    expect(refused()).toBe(true);
    await save({ characterId: null }, true);
    expect(refused()).toBe(false);
  });
});
