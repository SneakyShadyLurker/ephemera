import type { PromptProcessingSettings } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { modelsQuery } from "../api.ts";
import { HINT as HELP, ROW_SELECT, SettingRow } from "./SettingRow.tsx";
import { useSetting, useUpdateSettings } from "./settings.ts";

type Mode = PromptProcessingSettings[string];

/** Provider role options, least to most restrictive. */
const MODES: Record<Mode, { label: string; help: string }> = {
  merge: {
    label: "Merge consecutive roles",
    help: "Messages of one role in a row become one.",
  },
  semiStrict: {
    label: "One system message",
    help: "Merged, and every system message after the first is sent as yours.",
  },
  strict: {
    label: "Strict alternation",
    help: "As one system message, and a message of yours always comes before the first reply.",
  },
  single: {
    label: "Single user message",
    help: "The whole prompt as one message of yours, each chat turn under its speaker's name.",
  },
};

/**
 * The Post-processing group's rows: prompt post-processing per model, none
 * unless set here, for models whose chat template needs it, such as one
 * leading system message.
 */
export function PostProcessing() {
  const models = useQuery(modelsQuery);
  const promptProcessing = useSetting((settings) => settings.promptProcessing);
  const updateSettings = useUpdateSettings();
  const addLabel = useId();
  const set = Object.keys(promptProcessing).sort();
  const offered = (models.data ?? [])
    .map((model) => model.id)
    .filter((id) => !(id in promptProcessing));

  const save = (id: string, mode: Mode | null) => {
    const others = Object.fromEntries(
      Object.entries(promptProcessing).filter(([key]) => key !== id),
    );
    updateSettings({ promptProcessing: mode === null ? others : { ...others, [id]: mode } });
  };

  // Rows of the Post-processing group: the list, then adding a model as its last row.
  return (
    <>
      {set.length > 0 && (
        <ul className="grid divide-y divide-rush">
          {set.map((id) => (
            <ModeRow
              key={id}
              id={id}
              mode={promptProcessing[id] ?? "merge"}
              onChange={(mode) => save(id, mode)}
            />
          ))}
        </ul>
      )}
      <SettingRow label="Add a model" labelId={addLabel}>
        <ModelSelect
          labelId={addLabel}
          options={offered}
          value={null}
          onChange={(id) => {
            // A typed model already set keeps its mode.
            if (!Object.hasOwn(promptProcessing, id)) save(id, "semiStrict");
          }}
          className={ROW_SELECT}
        />
      </SettingRow>
    </>
  );
}

function ModeRow({
  id,
  mode,
  onChange,
}: {
  id: string;
  mode: Mode;
  onChange: (mode: Mode | null) => void;
}) {
  const labelId = useId();
  return (
    <li className="grid gap-1.5 py-3.5 arrive">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 touch:min-h-11">
        <span
          id={labelId}
          className="min-w-0 flex-1 truncate font-medium text-ink text-ui max-tablet:basis-full"
        >
          {id}
        </span>
        <Select
          value={mode}
          items={Object.fromEntries(Object.entries(MODES).map(([key, { label }]) => [key, label]))}
          onValueChange={(value) => {
            if (typeof value === "string" && value in MODES) onChange(value as Mode);
          }}
        >
          <SelectTrigger
            aria-label={`Post-processing for ${id}`}
            placeholder="Choose"
            className="w-56"
          />
          <SelectContent label={`Post-processing for ${id}`}>
            {Object.entries(MODES).map(([key, { label }]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="text"
          aria-label={`Remove post-processing for ${id}`}
          onClick={() => onChange(null)}
        >
          Remove
        </Button>
      </div>
      <p className={HELP}>{MODES[mode].help}</p>
    </li>
  );
}
