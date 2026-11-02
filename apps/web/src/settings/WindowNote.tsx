import { useQuery } from "@tanstack/react-query";
import { modelsQuery, useContextWindow } from "../api.ts";
import { useSettings } from "./settings.ts";
import { WindowLink } from "./window-link.tsx";

/**
 * Under a Settings model picker: once the model list has answered, a model
 * with no known context window says so, linking to Context with that model's
 * window field focused. Gone once a window is set. `model` null shows nothing.
 */
export function WindowNote({ model }: { model: string | null }) {
  const settings = useSettings();
  const listed = useQuery(modelsQuery).data !== undefined;
  const window = useContextWindow(model, settings);
  if (model === null || !listed || window !== null) return null;
  return (
    <p className="arrive text-pretty text-note text-reed">
      <WindowLink model={model} label={`Set a context window for ${model}`}>
        Set a context window
      </WindowLink>{" "}
      before using this model.
    </p>
  );
}
