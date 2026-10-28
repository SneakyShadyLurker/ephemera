import {
  DEFAULT_REPLY_RESERVE,
  offeredEfforts,
  PRESET_LIMITS,
  REASONING_EFFORTS,
  SAMPLER_RANGES,
  type SamplerPreset,
  type SamplerValues,
  samplerPresetSchema,
} from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/cn";
import { isNotFound, useModelInfo, useModelOptions } from "../api.ts";
import { useSetting } from "../settings/settings.ts";
import { useAutosave } from "../sheet/autosave.ts";
import { ConflictNotice, useReload } from "../sheet/ConflictNotice.tsx";
import { SHEET_GRID } from "../sheet/fields.ts";
import {
  NameField,
  SheetBody,
  SheetHeader,
  SheetLoading,
  SheetMissing,
  SheetNotice,
  useLeaveGuard,
  useSheetState,
} from "../sheet/SheetFrame.tsx";
import { PRESETS_BACK, PresetActions } from "./PresetFrame.tsx";
import { presetArrivals, presetQuery, REASONING_LABELS, saveSamplerPreset } from "./queries.ts";

const LABEL = "mb-2 block font-semibold text-ink text-ui tablet:mb-0 tablet:pt-2 tablet:text-right";
const HELP = "text-pretty text-note text-reed";
const CHAT_MODEL = "chat-model";

export function SamplerPresetScreen({ id }: { id: string }) {
  const query = useQuery({ ...presetQuery("sampler", id), refetchOnMount: "always" });
  const [round, reload] = useReload(() => query.refetch());
  const state = useSheetState(id, query);
  if (state === "error") {
    return (
      <SheetMissing
        back={PRESETS_BACK}
        noun="preset"
        notFound={isNotFound(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (state === "loading" || query.data === undefined) {
    return <SheetLoading />;
  }
  const { name, values, revision } = query.data;
  return (
    <SamplerPresetEditor
      key={`${id}:${round}`}
      id={id}
      preset={{ name, values }}
      revision={revision}
      onReload={reload}
    />
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section className={SHEET_GRID}>
      <h2 id={id} className={LABEL}>
        {title}
      </h2>
      <div className="grid gap-6">{children}</div>
    </section>
  );
}

function SamplerPresetEditor({
  id,
  preset,
  revision,
  onReload,
}: {
  id: string;
  preset: SamplerPreset;
  revision: number;
  /** Fetches the saved preset and reopens the sheet on it (a conflict's Reload). */
  onReload: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const chatModel = useSetting((settings) => settings.model);
  const [fields, setFields] = useState(preset);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectName] = useState(() => presetArrivals.take(id).selectName === true);
  const leaving = useRef(false);
  const modelLabel = useId();
  const reasoningLabel = useId();

  const autosave = useAutosave({
    id,
    revision,
    fields,
    schema: samplerPresetSchema,
    labels: { name: "Name", values: "A value" },
    wholeLabel: "The preset",
    save: saveSamplerPreset,
    onSaved: (saved, stored) =>
      queryClient.setQueryData(presetQuery("sampler", saved).queryKey, stored),
  });
  const leaveGuard = useLeaveGuard(
    autosave,
    (value) => {
      leaving.current = value;
    },
    false,
    "sampler preset",
  );

  const set = (change: Partial<SamplerValues>) => {
    setFields((current) => ({ ...current, values: { ...current.values, ...change } }));
    autosave.touch("values");
  };
  const { values } = fields;
  // A model the list no longer offers still shows, so the preset never looks changed.
  const modelOptions = useModelOptions(values.model);
  // Reasoning narrows to what the model replies use offers (the preset's, else the chat's).
  const replyModel = values.model ?? chatModel;
  const modelInfo = useModelInfo(replyModel);
  const offered = offeredEfforts(modelInfo);
  const efforts = REASONING_EFFORTS.filter(
    (effort) => offered.includes(effort) || effort === values.reasoning,
  );
  const reasoningHelp =
    replyModel === null || modelInfo === undefined
      ? "How long a reasoning model thinks first. Every level shows until a model is chosen."
      : !offered.includes(values.reasoning)
        ? `${replyModel} doesn't offer ${REASONING_LABELS[values.reasoning].toLowerCase()}, so no effort is sent. Choose one it offers.`
        : modelInfo.reasoning === null
          ? `How long a reasoning model thinks first. The provider doesn't say which levels ${replyModel} supports, so every level shows.`
          : modelInfo.reasoning.length === 0
            ? `${replyModel} offers no reasoning levels; replies use its default.`
            : `How long ${replyModel} thinks first. Showing the levels it offers.`;

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <SheetHeader
        back={PRESETS_BACK}
        title={fields.name.trim() || "Sampler preset"}
        status={autosave.status}
        creating={false}
        noun="sampler preset"
      >
        <PresetActions
          kind="sampler"
          id={id}
          name={fields.name}
          flush={autosave.flush}
          discard={autosave.discard}
          onError={setNotice}
        />
      </SheetHeader>
      <SheetBody
        label="Sampler preset"
        after={
          autosave.status.kind === "conflict" && (
            <ConflictNotice
              noun="sampler preset"
              onReload={onReload}
              onKeepMine={autosave.keepMine}
            />
          )
        }
        onBlur={() => {
          if (autosave.hasUnsaved()) void autosave.flush();
        }}
      >
        {notice && <SheetNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <section className={SHEET_GRID}>
          <div className="hidden tablet:block" />
          <div className="grid gap-3">
            <NameField
              value={fields.name}
              maxLength={PRESET_LIMITS.nameLength}
              autoSelect={selectName}
              onChange={(name) => {
                setFields((current) => ({ ...current, name }));
                autosave.touch("name");
              }}
            />
            <p className={cn(HELP, "max-w-help")}>
              Applied to every reply while this preset is in use. Anything left at the model default
              is not sent.
            </p>
          </div>
        </section>

        <Section title="Model" id={modelLabel}>
          <div className="grid gap-2">
            <ModelSelect
              labelId={modelLabel}
              options={modelOptions}
              lead={{ value: CHAT_MODEL, label: "The chat's model" }}
              value={values.model ?? CHAT_MODEL}
              onChange={(model) => set({ model: model === CHAT_MODEL ? null : model })}
              className="max-w-sm tablet:w-full"
            />
            <p className={HELP}>
              {values.model === null
                ? "Replies use the model chosen in Session."
                : "Choosing this preset in Session switches the chat to this model."}
            </p>
          </div>
        </Section>

        <Section title="Length">
          <ValueRow
            label="Reply length"
            help={`The longest reply the model may write; this much of the model's context window is kept free for it. At the model default, ${DEFAULT_REPLY_RESERVE.toLocaleString("en")} tokens are kept free.`}
            range={SAMPLER_RANGES.maxOutputTokens}
            value={values.maxOutputTokens}
            onChange={(maxOutputTokens) => set({ maxOutputTokens })}
            unit="tokens"
            decimals={0}
          />
        </Section>

        <Section title="Sampling">
          <ValueRow
            label="Temperature"
            help="Higher is looser and more surprising; lower is steadier."
            range={SAMPLER_RANGES.temperature}
            value={values.temperature}
            onChange={(temperature) => set({ temperature })}
            slider
          />
          <ValueRow
            label="Top-p"
            help="Draws only from the most likely words whose chances add up to this share."
            range={SAMPLER_RANGES.topP}
            value={values.topP}
            onChange={(topP) => set({ topP })}
            slider
          />
          <ValueRow
            label="Frequency penalty"
            help="Discourages repeating the same words often."
            range={SAMPLER_RANGES.frequencyPenalty}
            value={values.frequencyPenalty}
            onChange={(frequencyPenalty) => set({ frequencyPenalty })}
            slider
            centered
          />
          <ValueRow
            label="Presence penalty"
            help="Encourages new topics over ones already mentioned."
            range={SAMPLER_RANGES.presencePenalty}
            value={values.presencePenalty}
            onChange={(presencePenalty) => set({ presencePenalty })}
            slider
            centered
          />
          <ValueRow
            label="Seed"
            help="A fixed seed repeats a reply on models that support it."
            range={SAMPLER_RANGES.seed}
            value={values.seed}
            onChange={(seed) => set({ seed })}
            decimals={0}
            grouping={false}
            unset="Random each reply"
            start={() => Math.floor(Math.random() * 1_000_000)}
          />
        </Section>

        <Section title="Reasoning" id={reasoningLabel}>
          <div className="grid gap-2">
            <Select
              value={values.reasoning}
              items={REASONING_LABELS}
              onValueChange={(value) => {
                const reasoning = REASONING_EFFORTS.find((effort) => effort === value);
                if (reasoning) set({ reasoning });
              }}
            >
              <SelectTrigger
                aria-labelledby={reasoningLabel}
                placeholder="Model default"
                className="max-w-sm"
              />
              <SelectContent label="Reasoning effort">
                {efforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {REASONING_LABELS[effort]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              key={reasoningHelp}
              className={`${HELP} transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0`}
            >
              {reasoningHelp}
            </p>
          </div>
        </Section>
      </SheetBody>
      {leaveGuard}
    </main>
  );
}

/**
 * One sampler value: "Model default" with Set, or its number (and slider)
 * with Reset. Set starts from the range's documented starting value and moves
 * focus into the number with its text selected; Reset moves focus to Set.
 */
function ValueRow({
  label,
  help,
  range,
  value,
  onChange,
  slider = false,
  centered = false,
  unit,
  decimals = 2,
  grouping = true,
  unset = "Model default",
  start,
}: {
  label: string;
  help: string;
  range: { min: number; max: number; step: number; start: number };
  value: number | null;
  onChange: (value: number | null) => void;
  slider?: boolean;
  centered?: boolean;
  unit?: string;
  decimals?: number;
  grouping?: boolean;
  unset?: string;
  start?: () => number;
}) {
  const labelId = useId();
  const row = useRef<HTMLFieldSetElement>(null);
  const focus = (selector: string, select = false) =>
    requestAnimationFrame(() => {
      const target = row.current?.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
      target?.focus();
      if (select && target instanceof HTMLInputElement) target.select();
    });
  return (
    <fieldset ref={row} aria-labelledby={labelId} className="m-0 grid min-w-0 gap-1 border-0 p-0">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 touch:min-h-11">
        <span id={labelId} className="flex-1 font-medium text-ink text-ui max-tablet:basis-full">
          {label}
        </span>
        {value === null ? (
          <span className="flex items-center gap-2">
            <span className="text-note text-reed">{unset}</span>
            <Button
              variant="outline"
              aria-label={`Set ${label}`}
              className="h-8 px-2.5 text-note touch:h-11"
              onClick={() => {
                onChange(start ? start() : range.start);
                focus(
                  "input[inputmode], input[type='text'], [data-slot='number-field'] input",
                  true,
                );
              }}
            >
              Set
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2 arrive">
            <NumberField
              value={value}
              min={range.min}
              max={range.max}
              step={range.step}
              largeStep={range.step * 10}
              label={label}
              className="w-32 touch:w-44"
              format={{
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals,
                useGrouping: grouping,
              }}
              onValueChange={(next) => {
                if (next !== null) onChange(next);
              }}
            />
            {unit && <span className="text-note text-reed">{unit}</span>}
            <Button
              aria-label={`Reset ${label} to ${unset.toLowerCase()}`}
              className="h-8 px-2 text-note touch:h-11"
              onClick={() => {
                onChange(null);
                focus(`button[aria-label="Set ${label}"]`);
              }}
            >
              Reset
            </Button>
          </span>
        )}
      </div>
      {value !== null && slider && (
        <Slider
          value={value}
          min={range.min}
          max={range.max}
          step={range.step}
          centered={centered}
          thumbLabel={label}
          onValueChange={(next) => onChange(Array.isArray(next) ? (next[0] ?? value) : next)}
        />
      )}
      <p className={HELP}>{help}</p>
    </fieldset>
  );
}
