import { defaultSamplerPreset } from "../packages/core/src/preset/sampler.ts";
import { uniqueName } from "./support/cards.ts";
import { chooseModel, lastReply, send, upstreamRecords } from "./support/chat.ts";
import { choose, closeSession, createPresetViaApi, openSession } from "./support/entities.ts";
import { canary } from "./support/env.ts";
import { expect, test } from "./support/test.ts";

test("a sampler preset's set values reach the model, and choosing it switches the model", async ({
  page,
}) => {
  await page.goto("/presets");
  await page.getByRole("button", { name: "New sampler preset" }).click();
  await expect(page).toHaveURL(/\/presets\/sampler\/[0-9a-f-]{36}$/);
  const presetName = uniqueName("Balanced");
  await page.getByRole("textbox", { name: "Name" }).fill(presetName);

  await choose(page, "Model", "mock-fast");
  await page.getByRole("button", { name: "Set Temperature" }).click();
  const temperature = page.getByRole("textbox", { name: "Temperature" });
  await expect(temperature).toHaveValue("1.00");
  await temperature.fill("0.7");
  await temperature.blur();
  await page.getByRole("button", { name: "Set Reply length" }).click();
  await expect(page.getByRole("textbox", { name: "Reply length" })).toHaveValue("1,024");
  await page.getByRole("button", { name: "Set Seed" }).click();
  const seed = page.getByRole("textbox", { name: "Seed" });
  await seed.fill("42");
  await seed.blur();
  await choose(page, "Reasoning", "Low");
  // Top-p stays at the model default, so it is never sent.
  await expect(page.getByRole("button", { name: "Set Top-p" })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.goto("/");
  await chooseModel(page, "mock-slow");
  await openSession(page);
  await choose(page, "Sampler preset", presetName);
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText("mock-fast");
  await closeSession(page);

  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(text);
  expect(record?.sampling).toEqual({
    temperature: 0.7,
    max_tokens: 1024,
    seed: 42,
    reasoning_effort: "low",
  });
});

test("a reply without a sampler preset override sends no sampling values", async ({ page }) => {
  const presetName = uniqueName("Defaults");
  await createPresetViaApi(page.request, "sampler", {
    name: presetName,
    values: defaultSamplerPreset().values,
  });
  await page.goto("/");
  await chooseModel(page, "mock-fast");
  await openSession(page);
  await choose(page, "Sampler preset", presetName);
  await closeSession(page);
  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(text);
  expect(record?.sampling).toEqual({});
});

test("a session model override takes precedence over the selected sampler model", async ({
  page,
}) => {
  const presetName = uniqueName("Named model");
  await createPresetViaApi(page.request, "sampler", {
    name: presetName,
    values: { ...defaultSamplerPreset().values, model: "mock-slow", temperature: 0.4 },
  });
  await page.goto("/");
  await chooseModel(page, "mock-fast");
  await openSession(page);
  await choose(page, "Sampler preset", presetName);
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveText("mock-slow");
  // The owner picks another model for this session: it wins over the preset's.
  await choose(page, "Model", "mock-fast");
  await expect(
    page.getByText(`${presetName} names mock-slow; this chat now uses mock-fast.`),
  ).toBeVisible();
  await closeSession(page);

  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(text);
  expect(record?.model).toBe("mock-fast");
  expect(record?.sampling).toEqual({ temperature: 0.4 });
});

test("unknown reasoning support offers every level and explains why", async ({ page }) => {
  await page.goto("/");
  await chooseModel(page, "mock-unreported");
  await page.goto("/presets");
  await page.getByRole("button", { name: "New sampler preset" }).click();
  await expect(page).toHaveURL(/\/presets\/sampler\/[0-9a-f-]{36}$/);
  const presetName = uniqueName("Unreported");
  await page.getByRole("textbox", { name: "Name" }).fill(presetName);
  await expect(
    page.getByText(
      "How long a reasoning model thinks first. CLIProxyAPI doesn't say which levels mock-unreported supports, so every level shows.",
    ),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Reasoning", exact: true }).click();
  await expect(page.getByRole("option")).toHaveText([
    "Model default",
    "Off",
    "Minimal",
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Maximum",
  ]);
  await page.getByRole("option", { name: "Maximum", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.goto("/");
  await openSession(page);
  await choose(page, "Sampler preset", presetName);
  await closeSession(page);
  const text = canary("in");
  await send(page, text);
  await expect(lastReply(page)).toHaveAttribute("data-status", "complete");
  const [record] = await upstreamRecords(text);
  expect(record?.model).toBe("mock-unreported");
  expect(record?.sampling).toEqual({ reasoning_effort: "max" });
});
