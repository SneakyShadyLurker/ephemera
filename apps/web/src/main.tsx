import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { preloadChunks } from "./app/preload.ts";
import { queryClient } from "./app/query.ts";
import { ScreenError } from "./app/Screen.tsx";
import { installPageLifecycle } from "./chat/session.ts";
import { routeTree } from "./routeTree.gen.ts";
import "./styles.css";

// Zod runs jitless: vite.config.ts routes every zod import through src/zod-jitless.ts.

// Scroll restoration stays off: it would persist positions in browser storage.
// Navigations run as same-document view transitions typed "route" (styles.css), except
// while the page is hidden: Chrome skips a transition there and its promises reject.
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultViewTransition: {
    types: () => (document.visibilityState === "hidden" ? false : ["route"]),
  },
  defaultErrorComponent: ({ error, reset }) => <ScreenError error={error} reset={reset} />,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

installPageLifecycle();

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

/**
 * React prints render errors, message and component stack, to the console, and
 * a message can quote card text or a lorebook key (PRINCIPLES.md 1); the error
 * screens and boundaries are the report instead.
 */
const unreported = () => {};

createRoot(root, {
  onCaughtError: unreported,
  onUncaughtError: unreported,
  onRecoverableError: unreported,
}).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

preloadChunks(router);
