import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { applySettings, fetchSavedSettings, useSettings } from "../settings/settings.ts";
import { SheetActions } from "../sheet/SheetActions.tsx";
import {
  deletePreset,
  duplicatePreset,
  type PresetKind,
  presetQuery,
  presetsQuery,
  refreshPresets,
} from "./queries.ts";

/*
 * What the prompt and sampler preset sheets share: the back target, the
 * missing-preset screen and the More actions. A preset in use hands over to
 * the most recently edited other one; the last of a kind cannot be deleted.
 */

export const PRESETS_BACK = { to: "/presets", label: "Presets" } as const;

export function PresetActions({
  kind,
  id,
  name,
  flush,
  discard,
  onError,
}: {
  kind: PresetKind;
  id: string;
  name: string;
  flush: () => Promise<boolean>;
  discard: () => void;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const presets = useQuery(presetsQuery(kind));
  const settings = useSettings();
  const noun = `${kind} preset`;
  const inUse = (kind === "prompt" ? settings.promptPresetId : settings.samplerPresetId) === id;
  // The server's list is most recently edited first: the first other one takes over.
  const successor = presets.data?.find((preset) => preset.id !== id);
  const last = presets.data !== undefined && successor === undefined;

  const duplicate = {
    copy: () => duplicatePreset(kind, id),
    open: async (copy: string) => {
      await refreshPresets(queryClient, kind);
      void navigate({
        to: kind === "prompt" ? "/presets/prompt/$id" : "/presets/sampler/$id",
        params: { id: copy },
      });
    },
  };

  const remove = async () => {
    const result = await deletePreset(kind, id);
    if (result === "failed") return false;
    if (result === "last") {
      onError(`Not deleted: keep at least one ${noun}.`);
      return true;
    }
    discard();
    // The server handed a preset in use to another one; this tab takes that one, and nothing else.
    if (inUse) {
      const column = kind === "prompt" ? "promptPresetId" : "samplerPresetId";
      const saved = await fetchSavedSettings().catch(() => undefined);
      applySettings({ [column]: saved?.[column] ?? successor?.id ?? null });
    }
    queryClient.removeQueries({ queryKey: presetQuery(kind, id).queryKey });
    await refreshPresets(queryClient, kind);
    void navigate({ to: "/presets" });
    return true;
  };

  return (
    <SheetActions
      name={name}
      label={`${kind === "prompt" ? "Prompt" : "Sampler"} preset actions`}
      flush={flush}
      onError={onError}
      duplicate={duplicate}
      exports={[{ label: "Export as JSON", file: { kind, id } }]}
      deleteTitle={`Delete ${name.trim() || `this ${noun}`}?`}
      deleteDescription={
        inUse && successor
          ? `Session switches to ${successor.name}, the ${noun} edited most recently.`
          : `The ${noun} is removed from Ephemera.`
      }
      onDelete={remove}
      {...(last ? { cannotDelete: `Keep at least one ${noun}: Session always uses one.` } : {})}
    />
  );
}
