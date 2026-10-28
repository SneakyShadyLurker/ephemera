/**
 * Every `@tanstack/react-router` import in the web bundle resolves here
 * (vite.config.ts), the router package unchanged but for one export. Its
 * `lazyRouteComponent`, which the router plugin wraps every split screen in,
 * answers a chunk it cannot load by writing to session storage and reloading
 * the tab: signed out, the reload goes to the sign-in portal and the chat is
 * lost (PRINCIPLES.md 1 and 2). This one throws a `ChunkLoadError` to the
 * screen's error component instead, which says what a reload would cost.
 */
import type { lazyRouteComponent as lazyRouteComponentWithReload } from "@tanstack/react-router";
import { type ComponentType, createElement, use } from "react";
import { ChunkLoadError } from "./chunk-error.ts";

export * from "@tanstack/react-router";

type Importer = () => Promise<Record<string, unknown>>;

function lazyWithoutReload(importer: Importer, exportName = "default") {
  let component: ComponentType | undefined;
  let failed = false;
  let loading: Promise<void> | undefined;
  const load = (): Promise<void> => {
    if (component !== undefined) return Promise.resolve();
    loading ??= importer()
      .then(
        (module) => {
          component = module[exportName] as ComponentType;
        },
        () => {
          failed = true;
        },
      )
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  function Lazy(props: object) {
    if (failed) throw new ChunkLoadError();
    if (component === undefined) use(load());
    return component === undefined ? null : createElement(component, props);
  }
  Lazy.preload = load;
  return Lazy;
}

export const lazyRouteComponent =
  lazyWithoutReload as unknown as typeof lazyRouteComponentWithReload;
