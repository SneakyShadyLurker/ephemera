import { DEFAULT_SETTINGS, type SettingsPatch, settingsPatchSchema } from "@ephemera/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../app/query.ts";
import { signIn } from "../signin/signin.ts";
import {
  failedSettingsPatch,
  refusedAddress,
  refusedSettingsSave,
  SETTINGS_MUTATION_KEY,
} from "./save-history.ts";
import {
  applySettings,
  castPatch,
  currentSettings,
  MEMORY_MODEL,
  memoryPatch,
  queueSettingsSave,
  REPLY_MODEL,
  retryFailedSettings,
  settingsQuery,
} from "./settings.ts";

/** A response as the browser reports the sign-in redirect under `redirect: "manual"`. */
function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperties(response, {
    type: { value: "opaqueredirect" },
    status: { value: 0 },
    ok: { value: false },
  });
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.getMutationCache().clear();
  signIn.reset();
});

describe("settings saves after a renewal", () => {
  it("a choice made while the resend runs is saved after it, so the server keeps the newest", async () => {
    vi.stubGlobal("fetch", async () => opaqueRedirect());
    await queueSettingsSave({ theme: "dark" }).catch(() => undefined);
    await queueSettingsSave({ characterId: "11111111-1111-4111-8111-111111111111" }).catch(
      () => undefined,
    );
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ settings: {} });
    });
    const resend = retryFailedSettings();
    // The owner picks another character while the first part of the resend is on its way.
    const newer = queueSettingsSave({ characterId: "22222222-2222-4222-8222-222222222222" });
    await Promise.all([resend, newer]);
    expect(sent).toEqual([
      { theme: "dark" },
      { characterId: "11111111-1111-4111-8111-111111111111" },
      { characterId: "22222222-2222-4222-8222-222222222222" },
    ]);
  });
});

/** The settings saves as the history reads them. */
const settingsSaves = () =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey: SETTINGS_MUTATION_KEY })
    .map((mutation) => ({
      status: mutation.state.status,
      patch: mutation.state.variables as SettingsPatch | undefined,
      error: mutation.state.error?.message,
    }));

describe("a ComfyUI address whose origin the server does not allow", () => {
  it("is sent alone on a resend, so its refusal keeps the other fields and reaches the field", async () => {
    vi.stubGlobal("fetch", async () => opaqueRedirect());
    const address = "https://elsewhere.test:8188";
    await queueSettingsSave({ theme: "dark", model: "m" }).catch(() => undefined);
    await queueSettingsSave({ comfyuiBaseUrl: address }).catch(() => undefined);
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const patch = JSON.parse(String(init?.body));
      sent.push(patch);
      return "comfyuiBaseUrl" in patch
        ? Response.json({ error: "comfyui_origin_not_allowed" }, { status: 422 })
        : Response.json({ settings: {} });
    });

    await retryFailedSettings();
    expect(sent).toEqual([{ theme: "dark", model: "m" }, { comfyuiBaseUrl: address }]);
    const saves = settingsSaves();
    // The theme and model are saved; the address is final and the field explains it.
    expect(failedSettingsPatch(saves)).toBeUndefined();
    expect(refusedSettingsSave(saves)).toBe(false);
    expect(refusedAddress(saves)).toBe(address);
  });

  it("is refused for good, sent once, and left to the address field to explain", async () => {
    let sent = 0;
    vi.stubGlobal("fetch", async () => {
      sent += 1;
      return Response.json({ error: "comfyui_origin_not_allowed" }, { status: 422 });
    });
    await expect(
      queueSettingsSave({ comfyuiBaseUrl: "https://elsewhere.test:8188" }),
    ).rejects.toThrow("comfyui_origin_not_allowed");
    expect(sent).toBe(1);
    const saves = settingsSaves();
    // Nothing to send again, and no "a choice was deleted" notice: the tab never took the address.
    expect(failedSettingsPatch(saves)).toBeUndefined();
    expect(refusedSettingsSave(saves)).toBe(false);
  });
});

describe("a change made before the settings loaded", () => {
  it("does not hide the server's settings: they load, and the change is laid over them", async () => {
    queryClient.removeQueries({ queryKey: settingsQuery.queryKey });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    await queryClient.prefetchQuery(settingsQuery);
    expect(queryClient.getQueryState(settingsQuery.queryKey)?.status).toBe("error");

    const served = {
      ...DEFAULT_SETTINGS,
      theme: "light" as const,
      characterId: "11111111-1111-4111-8111-111111111111",
    };
    vi.stubGlobal("fetch", async () => Response.json({ settings: served }));
    applySettings({ theme: "dark" });
    expect(currentSettings().theme).toBe("dark");
    await vi.waitFor(() => expect(currentSettings()).toEqual({ ...served, theme: "dark" }));
    queryClient.removeQueries({ queryKey: settingsQuery.queryKey });
  });
});

describe("the Memory section", () => {
  it("saves its five choices, the reply's model and the model default as none, sizes within bounds", () => {
    const chosen = memoryPatch({
      model: "model-b",
      reasoning: "high",
      spanTokens: 8_000,
      keepTurns: 6,
      recapTokens: 4_000,
    });
    expect(chosen).toEqual({
      memoryModel: "model-b",
      memoryReasoning: "high",
      memorySpanTokens: 8_000,
      memoryKeepTurns: 6,
      memoryRecapTokens: 4_000,
    });
    const defaults = memoryPatch({
      model: REPLY_MODEL,
      reasoning: "provider-default",
      spanTokens: 999_999,
      keepTurns: 0,
      recapTokens: 1_234.6,
    });
    expect(defaults).toEqual({
      memoryModel: null,
      memoryReasoning: null,
      memorySpanTokens: 32_000,
      memoryKeepTurns: 1,
      memoryRecapTokens: 1_235,
    });
    // Cleared, the recap budget is the window's again.
    const automatic = memoryPatch({ recapTokens: null });
    expect(automatic).toEqual({ memoryRecapTokens: null });
    for (const patch of [chosen, defaults, automatic]) {
      expect(settingsPatchSchema.safeParse(patch).success).toBe(true);
    }
  });
  it("saves the opening switch as whether new chats open on the memory's opening", () => {
    expect(DEFAULT_SETTINGS.memoryOpening).toBe(true);
    for (const opening of [false, true]) {
      const patch = memoryPatch({ opening });
      expect(patch).toEqual({ memoryOpening: opening });
      expect(settingsPatchSchema.safeParse(patch).success).toBe(true);
    }
  });
});

describe("the Cast section", () => {
  it("saves only its two choices, memory's model as none and an effort as chosen", () => {
    const chosen = castPatch({ model: "model-b", reasoning: "low" });
    expect(chosen).toEqual({ castModel: "model-b", castReasoning: "low" });
    const defaults = castPatch({ model: MEMORY_MODEL, reasoning: "provider-default" });
    expect(defaults).toEqual({ castModel: null, castReasoning: "provider-default" });
    expect(castPatch({ reasoning: "high" })).toEqual({ castReasoning: "high" });
    // Memory's effort and the model's own are separate choices.
    const following = castPatch({ reasoning: null });
    expect(following).toEqual({ castReasoning: null });
    for (const patch of [chosen, defaults, following]) {
      expect(settingsPatchSchema.safeParse(patch).success).toBe(true);
    }
  });
});
