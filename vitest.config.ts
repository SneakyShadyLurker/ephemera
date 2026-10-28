import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A focused test would leave the rest of the suite unrun and still pass.
    allowOnly: false,
    // Transformed modules persist across runs; dependency reinstalls invalidate them.
    fsModuleCache: true,
    projects: [
      { test: { name: "core", root: "packages/core" } },
      { test: { name: "server", root: "apps/server" } },
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: "web",
          root: "apps/web",
          include: ["src/**/*.test.{ts,tsx}"],
          // The theme's source text, which a test reads to keep cn's type scale in step.
          css: { include: [/styles\.css\?raw$/] },
        },
      },
      { test: { name: "scripts", root: "scripts" } },
      {
        test: {
          name: "infra",
          root: "infra",
        },
      },
    ],
  },
});
