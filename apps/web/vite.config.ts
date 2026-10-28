import { fileURLToPath } from "node:url";
import { PROXY_KEY_HEADER } from "@ephemera/server/boundary";
import { BUILD_REVISION } from "@ephemera/server/build";
import { DEFAULT_PORT } from "@ephemera/server/config";
import { BOUND_USER_HEADER, USER_HEADER } from "@ephemera/server/identity";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DEV_PORT = 5173;

/**
 * The router package with a lazy route component that never reloads the tab
 * (src/app/router-package.ts). Every import of the package resolves there,
 * except that module's own.
 */
const routerPackage = fileURLToPath(new URL("./src/app/router-package.ts", import.meta.url));
const routerWithoutReload: Plugin = {
  name: "ephemera:router-without-reload",
  enforce: "pre",
  resolveId(source, importer) {
    if (source !== "@tanstack/react-router" || importer === routerPackage) return null;
    return routerPackage;
  },
};

/**
 * The build the bundle is, the one the server names on every response
 * (`@ephemera/server/build`): the image passes the deployed commit as
 * `EPHEMERA_BUILD_REVISION`; elsewhere it is empty, and a server naming none
 * never asks the tab to reload. Read like the dev server's, from the
 * environment or the root `.env`, so both sides of `bun run dev` agree.
 */
function buildRevision(mode: string): string {
  const revision = loadEnv(mode, repoRoot, "EPHEMERA_").EPHEMERA_BUILD_REVISION ?? "";
  if (revision !== "" && !BUILD_REVISION.test(revision)) {
    throw new Error("EPHEMERA_BUILD_REVISION is not a build revision");
  }
  return revision;
}

export default defineConfig(({ command, mode }) => ({
  // The client gets no environment variables; secrets stay in the root .env.
  // The build revision is the one value defined into it.
  envDir: false,
  define: { "import.meta.env.EPHEMERA_BUILD": JSON.stringify(buildRevision(mode)) },
  // Router plugin before React, so it can split routes before JSX is compiled.
  plugins: [
    routerWithoutReload,
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    // A component the compiler would skip fails `vite build`; the dev server only
    // logs the diagnostic, so one skipped component never fails a module load.
    react({
      compiler: {
        logDiagnostics: true,
        panicThreshold: command === "build" ? "all_errors" : "none",
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: [
      // micromark's entity decoder picks a browser build that assigns innerHTML,
      // which Trusted Types forbid; the default build decodes from a table.
      {
        find: /^decode-named-character-reference$/,
        replacement: fileURLToPath(import.meta.resolve("decode-named-character-reference")),
      },
      // Zod must be jitless before any schema exists (CSP and Trusted Types forbid
      // new Function); the wrapper sets it and re-exports Zod unchanged.
      {
        find: /^zod$/,
        replacement: fileURLToPath(new URL("./src/zod-jitless.ts", import.meta.url)),
      },
    ],
  },
  // The app, and the page the sign-in window returns to (served at /auth/renewed).
  input: {
    main: fileURLToPath(new URL("./index.html", import.meta.url)),
    renewed: fileURLToPath(new URL("./auth/renewed.html", import.meta.url)),
  },
  // Every asset stays a same-origin file: the CSP allows no data: URLs.
  build: { assetsInlineLimit: 0 },
  server: command === "serve" ? devServer(loadEnv(mode, repoRoot, "EPHEMERA_")) : {},
}));

/**
 * In production SWAG injects the proxy key and `Remote-User`; in development
 * the Vite proxy does, from the ignored root `.env`, as one development user
 * (`EPHEMERA_DEV_USER`, `dev` by default), and binds requests to that user.
 */
function devServer(env: Record<string, string>) {
  const {
    EPHEMERA_PROXY_KEY,
    EPHEMERA_DEV_USER = "dev",
    EPHEMERA_PORT = String(DEFAULT_PORT),
  } = env;
  if (!EPHEMERA_PROXY_KEY) {
    throw new Error("Set EPHEMERA_PROXY_KEY in the root .env");
  }
  return {
    port: DEV_PORT,
    strictPort: true,
    // The proxy adds user credentials, so no other local origin may read its responses.
    cors: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${EPHEMERA_PORT}`,
        // The dev shell names no user, so its tab is unbound: the proxy binds every request.
        headers: {
          [PROXY_KEY_HEADER]: EPHEMERA_PROXY_KEY,
          [USER_HEADER]: EPHEMERA_DEV_USER,
          [BOUND_USER_HEADER]: EPHEMERA_DEV_USER,
        },
      },
    },
  };
}
