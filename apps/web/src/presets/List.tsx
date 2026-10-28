import { defaultPromptPreset, defaultSamplerPreset } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { HeaderAction } from "@/app/Browse.tsx";
import { importProgress, JSON_FILE_TYPES } from "@/app/importing";
import { KeptScroll } from "@/app/KeptScroll.tsx";
import { SCROLL_GUTTERS, ScreenHeader } from "@/app/Screen.tsx";
import { DropOverlay, useFileDrop } from "@/components/file-drop";
import { CheckIcon, ImportIcon, PlusIcon, PresetsIcon, SamplerIcon } from "@/components/icons";
import { ImportReportLine } from "@/components/import-report";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useSettings } from "../settings/settings.ts";
import { creations } from "../sheet/creation.ts";
import {
  createPreset,
  type NewPreset,
  type PresetKind,
  presetArrivals,
  presetImports,
  presetsQuery,
  promptSummary,
  refreshPresets,
  samplerSummary,
} from "./queries.ts";

/** The list's frame, which the header shares. */
const FRAME = "mx-auto w-full max-w-wide px-5 tablet:px-8";

export function PresetsScreen() {
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const reports = presetImports.use((state) => state.report);
  const importing = presetImports.use((state) => state.importing);
  // Both lists below, read from the same cache: the scroll comes back once they have rendered.
  const samplers = useQuery(presetsQuery("sampler"));
  const prompts = useQuery(presetsQuery("prompt"));
  const listed = [samplers, prompts].every((list) => list.data !== undefined && !list.isError);
  // New rows carry "Imported" until the next visit; kept in memory only.
  const [arrived, setArrived] = useState<string[]>([]);

  const importFiles = (files: File[]) =>
    void presetImports.add(files, async (outcome) => {
      setArrived((ids) => [
        ...ids,
        ...(outcome.format === "foreign" ? [outcome.promptId, outcome.samplerId] : [outcome.id]),
      ]);
      await Promise.all([
        refreshPresets(queryClient, "prompt"),
        refreshPresets(queryClient, "sampler"),
      ]);
    });
  const { dragging, dropTarget } = useFileDrop(importFiles);

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col [timeline-scope:--thread]"
      {...dropTarget}
    >
      <input
        ref={picker}
        type="file"
        accept={JSON_FILE_TYPES}
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          importFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
      <ScreenHeader title="Presets" frame={FRAME} gutters={SCROLL_GUTTERS}>
        <HeaderAction
          label="Import preset"
          icon={ImportIcon}
          onClick={() => picker.current?.click()}
        />
      </ScreenHeader>
      <div
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        <KeptScroll id="presets" ready={listed} />
        <div className={cn(FRAME, "grid gap-8 pt-5 pb-12")}>
          {importing !== null && (
            <p role="status" className="text-note text-reed">
              {importProgress(importing)}
            </p>
          )}
          {reports.map((report) => (
            <ImportReportLine
              key={report.key}
              outcome={report}
              summary={
                report.ok
                  ? `Imported ${report.name} as ${
                      report.format === "foreign"
                        ? "a prompt preset and a sampler preset"
                        : `a ${report.format} preset`
                    }.`
                  : ""
              }
              onDismiss={() => presetImports.dismiss(report)}
            />
          ))}
          <div className="grid gap-12 desktop:grid-cols-2 desktop:gap-16">
            <PresetList
              kind="sampler"
              title="Sampler presets"
              icon={<SamplerIcon />}
              chosenLabel="In use"
              arrived={arrived}
              note="How replies are drawn: model, length, sampling, seed and reasoning. The one in use applies to every reply."
            />
            <PresetList
              kind="prompt"
              title="Prompt presets"
              icon={<PresetsIcon />}
              chosenLabel="In use"
              arrived={arrived}
              note="What is sent, in which order. The one in use builds every prompt."
            />
          </div>
        </div>
      </div>
      {dragging && (
        <DropOverlay
          title="Drop presets to import"
          hint="Ephemera prompt or sampler presets, or SillyTavern Chat Completion presets, as JSON"
        />
      )}
    </main>
  );
}

function PresetList({
  kind,
  title,
  icon,
  chosenLabel,
  arrived,
  note,
}: {
  kind: PresetKind;
  title: string;
  icon: ReactNode;
  chosenLabel: string;
  arrived: string[];
  note: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const presets = useQuery(presetsQuery(kind));
  const settings = useSettings();
  const chosen = kind === "prompt" ? settings.promptPresetId : settings.samplerPresetId;
  const [failed, setFailed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // This kind's New: one id and preset until the server acknowledges it.
  const [creates] = useState(() => creations<NewPreset>());
  const headingId = `presets-${kind}`;

  /**
   * After the server acknowledged a new preset: the list reloads and the
   * preset opens. Awaited inside the creation, so New stays held until the
   * route has changed; a failure here leaves the preset made and listed, and
   * never makes it again.
   */
  const openCreated = async (id: string) => {
    try {
      await refreshPresets(queryClient, kind);
      // A new preset opens with its name selected, ready to be named.
      presetArrivals.arriveAt({ id, selectName: true });
      await navigate({
        to: kind === "prompt" ? "/presets/prompt/$id" : "/presets/sampler/$id",
        params: { id },
      });
    } catch {
      // The preset is in the list; it opens from its row.
    }
  };

  const create = async () => {
    // Another New of this kind on its way answers undefined: it opens its preset.
    await creates.run(kind, async ({ take }) => {
      setCreating(true);
      const make = async () => {
        const { id, payload } = take(
          kind === "prompt"
            ? { kind: "prompt", preset: defaultPromptPreset("New prompt preset") }
            : { kind: "sampler", preset: defaultSamplerPreset("New sampler preset") },
        );
        const created =
          payload.kind === "prompt"
            ? await createPreset("prompt", id, payload.preset)
            : await createPreset("sampler", id, payload.preset);
        setFailed(created.ok ? null : created.reason);
        if (created.ok) await openCreated(id);
        return created;
      };
      return make().finally(() => setCreating(false));
    });
  };

  return (
    <section aria-labelledby={headingId} className="grid content-start gap-3">
      <div className="flex h-9 items-center gap-2">
        <span className="text-reed">{icon}</span>
        <h2 id={headingId} className="flex-1 font-semibold text-ink text-lead">
          {title}
        </h2>
        <Button
          aria-label={`New ${kind} preset`}
          disabled={creating}
          focusableWhenDisabled
          onClick={() => void create()}
        >
          <PlusIcon size={16} />
          New
        </Button>
      </div>
      <p className="max-w-help text-pretty text-note text-reed">{note}</p>
      {failed !== null && (
        <p role="alert" className="text-ember text-note">
          Not created: {failed}.
        </p>
      )}
      {presets.isError ? (
        <div role="alert" className="grid justify-items-start gap-2">
          <p className="text-ember text-note">These presets could not be loaded.</p>
          <Button variant="outline" onClick={() => void presets.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ul className="grid border-rush border-t">
          {(presets.data ?? []).map((preset) => (
            <li key={preset.id} className="border-rush border-b">
              <Link
                to={kind === "prompt" ? "/presets/prompt/$id" : "/presets/sampler/$id"}
                params={{ id: preset.id }}
                className="group flex min-h-16 items-center gap-4 px-1 py-2.5 hover:bg-surface-hover"
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold text-ink text-ui decoration-control-edge underline-offset-4 group-hover:underline">
                      {preset.name}
                    </span>
                    {arrived.includes(preset.id) && (
                      <span className="shrink-0 rounded-sm bg-surface-selected px-1.5 text-ink text-meta transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
                        Imported
                      </span>
                    )}
                  </span>
                  <span className="truncate text-meta text-reed">
                    {"blocks" in preset
                      ? promptSummary(preset.blocks)
                      : samplerSummary(preset.values)}
                  </span>
                </span>
                {preset.id === chosen && (
                  <span className="flex shrink-0 items-center gap-1 text-ink text-meta">
                    <CheckIcon size={16} />
                    <span className="max-tablet:sr-only">{chosenLabel}</span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
