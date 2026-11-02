import { markInspectorUnavailable, overlayIntent, setInspectorOpen } from "@/app/ui.ts";

/** The inspector's code: one import, shared by its lazy component and by opening it. */
export const loadInspector = () => import("./Inspector.tsx");

/**
 * Opens the inspector once its code is here, unless the owner has moved on
 * meanwhile (another overlay, another screen). Code that cannot load marks it
 * unavailable, and a load that never settles opens nothing, so no invisible
 * inspector is left open to hold the chat's shortcuts.
 */
export function openInspector(load: () => Promise<unknown> = loadInspector): Promise<void> {
  const intent = overlayIntent.next();
  return load().then(
    () => {
      if (overlayIntent.current() === intent) setInspectorOpen(true);
    },
    () => markInspectorUnavailable(),
  );
}
