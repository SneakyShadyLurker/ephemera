import type { PromptProcessingSettings } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { modelsQuery } from "../api.ts";
import { useSetting, useUpdateSettings } from "./settings.ts";

type Mode = PromptProcessingSettings[string];

const HELP = "text-pretty text-note text-reed";

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
 * Prompt post-processing per model:
 * none unless set here, for models whose chat template needs it, such as
 * one leading system message.
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

  return (
    <div className="grid gap-3">
      <p className={HELP}>
        Off for every model unless set here. Some models' chat templates refuse a prompt with system
        messages between the turns, or need turns to alternate: Qwen 3.8 Max, for one, takes a
        single system message at the start. GPT models drop the speaker names of example dialogue;
        any mode here, Merge consecutive roles the lightest, writes each name into its line.
      </p>
      {set.length > 0 && (
        <ul className="grid border-rush border-t">
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
      <div className="grid gap-1.5">
        <span id={addLabel} className="font-medium text-ink text-ui">
          Add a model
        </span>
        <ModelSelect
          labelId={addLabel}
          options={offered}
          value={null}
          onChange={(id) => {
            // A typed model already set keeps its mode.
            if (!Object.hasOwn(promptProcessing, id)) save(id, "semiStrict");
          }}
          className="max-w-sm tablet:w-full"
        />
      </div>
    </div>
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
    <li className="grid gap-1.5 border-rush border-b py-3 arrive">
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
          aria-label={`Remove post-processing for ${id}`}
          className="h-8 px-2 text-note touch:h-11"
          onClick={() => onChange(null)}
        >
          Remove
        </Button>
      </div>
      <p className={HELP}>{MODES[mode].help}</p>
    </li>
  );
}
