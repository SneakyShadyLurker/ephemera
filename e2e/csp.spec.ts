import { expect, test } from "./support/test.ts";

test("the browser enforces the policy: no inline style, remote image or HTML sink", async ({
  page,
  policyViolations,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  const sinkError = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "body { display: none }";
    document.head.append(style);
    const image = document.createElement("img");
    image.src = "https://images.example/pixel.png";
    document.body.append(image);
    try {
      document.createElement("div").innerHTML = "<b>untrusted</b>";
      return null;
    } catch (error) {
      return (error as Error).name;
    }
  });

  expect(sinkError).toBe("TypeError");
  await expect(page.locator("body")).toBeVisible();
  await expect
    .poll(() => [...policyViolations].sort())
    .toEqual([
      "img-src https://images.example/pixel.png",
      "require-trusted-types-for trusted-types-sink",
      "style-src-elem inline",
    ]);
  // Expected violations; the fixture checks the rest of the run stays clean.
  policyViolations.length = 0;
});
