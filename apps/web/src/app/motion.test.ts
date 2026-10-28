import { domMax } from "motion/react";
import { expect, it } from "vitest";
import { motionFeatures } from "./motion.tsx";

it("hands a scope mounted after the first load its features at once", async () => {
  const first = motionFeatures();
  expect(typeof first).toBe("function");
  if (typeof first === "function") await first();
  // A loader again would leave the new scope without a renderer for a tick.
  expect(motionFeatures()).toBe(domMax);
});
