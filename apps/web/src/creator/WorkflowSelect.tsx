import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { applySettings, queueSettingsSave, useSetting } from "../settings/settings.ts";
import { artWorkflowsQuery } from "./queries.ts";

/**
 * Takes the workflow into this tab at once, which asks for its status, and
 * saves it the way every setting is saved; art follows the tab's choice.
 */
function saveWorkflow(comfyuiWorkflow: string): void {
  applySettings({ comfyuiWorkflow });
  void queueSettingsSave({ comfyuiWorkflow }).catch(() => undefined);
}

/**
 * The built-in workflow portraits are painted with, kept for the next card:
 * beside the model before a card, and under New art for the next batch.
 */
export function WorkflowSelect({
  labelId,
  disabled = false,
  className,
}: {
  labelId: string;
  /** Held by the host beyond a single workflow (a run painting). */
  disabled?: boolean;
  className?: string;
}) {
  const comfyuiWorkflow = useSetting((settings) => settings.comfyuiWorkflow);
  const workflows = useQuery(artWorkflowsQuery);
  const options = workflows.data ?? [];
  const name = options.find((option) => option.id === comfyuiWorkflow)?.name;
  return (
    <Select
      value={comfyuiWorkflow}
      disabled={disabled || options.length < 2}
      onValueChange={(value) => {
        const chosen = options.find((option) => option.id === value);
        if (chosen !== undefined && chosen.id !== comfyuiWorkflow) saveWorkflow(chosen.id);
      }}
    >
      <SelectTrigger
        aria-labelledby={labelId}
        placeholder="Choose a workflow"
        className={cn("w-full max-w-72 tablet:w-64", className)}
      >
        <span
          key={name}
          className={cn(
            "min-w-0 flex-1 truncate transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
            name === undefined && "text-reed",
          )}
        >
          {name ?? (workflows.isError ? "Workflows not listed" : "Listing workflows…")}
        </span>
      </SelectTrigger>
      <SelectContent label="Workflows" className="min-w-64">
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
