import { castModelOf, castReasoningOf, MEMORY_LIMITS, memoryModelOf } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId } from "react";
import { PalettePicker } from "@/app/PalettePicker.tsx";
import { PAGE_FRAME, SCROLL_GUTTERS, ScreenHeader } from "@/app/Screen.tsx";
import { ThemeSwitch } from "@/app/ThemeSwitch.tsx";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectTrigger } from "@/components/ui/select";
import { SwitchField } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/text";
import { useModelOptions } from "../api.ts";
import { ReasoningSelect, useEffortChoice } from "../creator/ReasoningSelect.tsx";
import { PersonaOptions } from "../personas/PersonaSelect.tsx";
import { personasQuery } from "../personas/queries.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { SHEET_GRID } from "../sheet/fields.ts";
import { useNotReached } from "../signin/hooks.ts";
import { ContextSize } from "./ContextSize.tsx";
import { useNumberDraft } from "./number-draft.ts";
import { Portraits } from "./Portraits.tsx";
import { PostProcessing } from "./PostProcessing.tsx";
import {
  castPatch,
  MEMORY_MODEL,
  memoryPatch,
  REPLY_MODEL,
  retryFailedSettings,
  useFailedSettingsSave,
  useRefusedSettingsSave,
  useSettings,
  useUpdateSettings,
} from "./settings.ts";
import { WindowNote } from "./WindowNote.tsx";

/** A model picker on this page: as wide as the other fields, up to their cap. */
const FIELD_WIDTH = "max-w-sm tablet:w-full";

const LABEL = "mb-2 block font-semibold text-ink text-ui tablet:mb-0 tablet:pt-2 tablet:text-right";
const HELP = "text-pretty text-note text-reed";
const NO_DEFAULT = "none";
/** The image prompt model choice that leaves each surface on its own default; never a model id. */
const CHAT_MODEL = "";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={SHEET_GRID}>
      <h2 className={LABEL}>{label}</h2>
      <div className="grid gap-6">{children}</div>
    </section>
  );
}

/**
 * Settings kept on the server: theme, how chats start, and what Ephemera keeps.
 * `windowFor` is a model a link asked to set a context window for (Context).
 */
export function SettingsScreen({
  windowFor,
  onWindowShown,
}: {
  windowFor: string | null;
  onWindowShown: () => void;
}) {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const failed = useFailedSettingsSave();
  const refused = useRefusedSettingsSave();
  const notReachedText = useNotReached();
  const personas = useQuery(personasQuery);
  const personaLabel = useId();
  const modelLabel = useId();
  const imagePromptLabel = useId();
  const list = personas.data ?? [];
  const defaultPersona = list.find((persona) => persona.id === settings.defaultPersonaId);
  const modelOptions = useModelOptions(settings.model);
  const imagePromptOptions = useModelOptions(settings.imagePromptModel);

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <ScreenHeader title="Settings" frame={PAGE_FRAME} gutters={SCROLL_GUTTERS} />
      <div
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        <div className={cn(PAGE_FRAME, "grid gap-10 pt-6 pb-16 tablet:pt-8")}>
          {failed && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ember text-note arrive tablet:pl-[8.5rem]"
            >
              <p>Not saved: {notReachedText}. This tab keeps your choice.</p>
              <Button
                variant="outline"
                className="h-8 px-2.5 text-ink text-note touch:h-11"
                onClick={() => void retryFailedSettings()}
              >
                Try again
              </Button>
            </div>
          )}

          {refused && !failed && (
            <p role="alert" className="text-ember text-note arrive tablet:pl-[8.5rem]">
              Not saved: a character, persona, preset or portrait workflow chosen no longer exists.
              This tab keeps the choice until you pick another.
            </p>
          )}

          <Row label="Appearance">
            <div className="grid gap-2">
              <ThemeSwitch labelled />
              <p className={HELP}>Saved on this server, so a reload or another device keeps it.</p>
            </div>
            <div className="grid gap-2">
              <PalettePicker />
              <p className={HELP}>
                Every palette has a light and a dark scheme; the theme above picks between them.
              </p>
            </div>
          </Row>

          <Row label="Starting a chat">
            <div className="grid gap-2">
              <span id={personaLabel} className="font-medium text-ink text-ui">
                Default persona
              </span>
              <Select
                value={defaultPersona?.id ?? NO_DEFAULT}
                onValueChange={(value) =>
                  updateSettings({
                    defaultPersonaId:
                      typeof value === "string" && value !== NO_DEFAULT ? value : null,
                  })
                }
              >
                <SelectTrigger
                  aria-labelledby={personaLabel}
                  placeholder="No default persona"
                  className="h-14 max-w-sm pl-2 touch:h-14"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    {defaultPersona && (
                      <PortraitLeaf
                        owner="personas"
                        id={defaultPersona.id}
                        name={defaultPersona.name}
                        version={defaultPersona.portrait}
                        className="w-7"
                      />
                    )}
                    <span className="truncate">{defaultPersona?.name ?? "No default persona"}</span>
                  </span>
                </SelectTrigger>
                <SelectContent label="Personas">
                  <PersonaOptions
                    none={NO_DEFAULT}
                    noneLabel="No default persona"
                    personas={list}
                  />
                </SelectContent>
              </Select>
              <p className={HELP}>
                New chats start as the default persona, unless the character goes with another.
                Without a default, a new chat keeps the persona you had.
              </p>
            </div>
            <div className="grid gap-2">
              <span id={modelLabel} className="font-medium text-ink text-ui">
                Model
              </span>
              <ModelSelect
                labelId={modelLabel}
                options={modelOptions}
                value={settings.model}
                onChange={(model) => updateSettings({ model })}
                className={FIELD_WIDTH}
              />
              <WindowNote model={settings.model} />
              <p className={HELP}>
                The model replies use and a reload comes back to. Session and sampler presets that
                name a model change it too.
              </p>
            </div>
            <div className="grid gap-2">
              <span id={imagePromptLabel} className="font-medium text-ink text-ui">
                Image prompt model
              </span>
              <ModelSelect
                labelId={imagePromptLabel}
                options={imagePromptOptions}
                lead={{ value: CHAT_MODEL, label: "The chat model" }}
                value={settings.imagePromptModel ?? CHAT_MODEL}
                onChange={(model) =>
                  updateSettings({ imagePromptModel: model === CHAT_MODEL ? null : model })
                }
                className={FIELD_WIDTH}
              />
              <WindowNote model={settings.imagePromptModel} />
              <p className={HELP}>
                Writes the prompts for portraits and scene pictures; New art and the studio can
                still pick another.
              </p>
            </div>
          </Row>

          <Row label="Character prompts">
            <div className="grid gap-4">
              <SwitchField
                checked={settings.preferCharacterPrompt}
                onCheckedChange={(preferCharacterPrompt) =>
                  updateSettings({ preferCharacterPrompt })
                }
                label="Prefer the character's system prompt"
                description="A character's own system prompt replaces the preset's main prompt. Off, the preset's is used even then."
              />
              <SwitchField
                checked={settings.preferCharacterInstructions}
                onCheckedChange={(preferCharacterInstructions) =>
                  updateSettings({ preferCharacterInstructions })
                }
                label="Prefer the character's post-history instructions"
                description="A character's own post-history instructions replace the preset's. Off, the preset's are used even then."
              />
            </div>
          </Row>

          <Row label="Context">
            <ContextSize windowFor={windowFor} onWindowShown={onWindowShown} />
          </Row>

          <Row label="Post-processing">
            <PostProcessing />
          </Row>

          <Row label="Reasoning">
            <div className="grid gap-4">
              <SwitchField
                checked={settings.reasoningOpen}
                onCheckedChange={(reasoningOpen) => updateSettings({ reasoningOpen })}
                label="Show reasoning open"
                description="A reply's reasoning starts open instead of folded away."
              />
              <SwitchField
                checked={settings.showHiddenReasoning}
                onCheckedChange={(showHiddenReasoning) => updateSettings({ showHiddenReasoning })}
                label="Time hidden reasoning"
                description="When a model reasons but keeps its reasoning to itself, say how long it thought."
              />
            </div>
          </Row>

          <Row label="Memory">
            <MemorySettings />
          </Row>

          <Row label="Cast">
            <CastSettings />
          </Row>

          <Row label="Portraits">
            <Portraits />
          </Row>

          <Row label="What is kept">
            <div className="grid gap-5 tablet:grid-cols-2">
              <div className="grid content-start gap-2">
                <h3 className="font-medium text-ink text-ui">On this server</h3>
                <p className={HELP}>
                  Characters and their portraits, personas, presets, and these settings, including
                  the character and persona you chose last. Each character's memories too: its
                  notebook, the next chat's opening and the scene memories written from its chats,
                  until you forget them. Each character's cast sheet, read from its card alone.
                </p>
              </div>
              <div className="grid content-start gap-2">
                <h3 className="font-medium text-ink text-ui">Nowhere</h3>
                <p className={HELP}>
                  Messages, drafts, replies and their reasoning, and the chat's cast with your
                  corrections. A reload, closing the tab or Clear ends the chat for good.
                </p>
              </div>
            </div>
          </Row>
        </div>
      </div>
    </main>
  );
}

/**
 * How characters remember: the model and effort memory calls use, and the
 * sizes that pace them. Memory is on for every character and is turned off
 * per character, on its sheet.
 */
function MemorySettings() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const modelLabel = useId();
  const effortLabel = useId();
  const { memoryModel, memoryReasoning } = settings;
  const save = (choice: Parameters<typeof memoryPatch>[0]) => updateSettings(memoryPatch(choice));
  const modelOptions = useModelOptions(memoryModel);
  // Efforts narrow to what the model memory calls go to offers.
  const { efforts, effort } = useEffortChoice(
    memoryModelOf(settings),
    memoryReasoning ?? "provider-default",
  );

  return (
    <div className="grid gap-6">
      <p className={HELP}>
        Memory is on for every character: each remembers its story across chats. Turn it off in a
        character's sheet.
      </p>
      <SwitchField
        checked={settings.memoryOpening}
        onCheckedChange={(opening) => save({ opening })}
        label="Open new chats where the story left off"
        description="A new chat with a character opens on the memory's opening, where the last chat ended; the card's own greeting is one swipe away. Off, the card's greeting opens it."
      />
      <div className="grid gap-2">
        <span id={modelLabel} className="font-medium text-ink text-ui">
          Memory model
        </span>
        <ModelSelect
          labelId={modelLabel}
          options={modelOptions}
          lead={{ value: REPLY_MODEL, label: "The reply's model" }}
          value={memoryModel ?? REPLY_MODEL}
          onChange={(model) => save({ model })}
          className={FIELD_WIDTH}
        />
        <WindowNote model={memoryModel} />
        <p className={HELP}>The model that writes memories. Unset, it is the one replying.</p>
      </div>
      <div className="grid gap-2">
        <span id={effortLabel} className="font-medium text-ink text-ui">
          Memory reasoning effort
        </span>
        <ReasoningSelect
          labelId={effortLabel}
          efforts={efforts}
          effort={effort}
          onChange={(reasoning) => save({ reasoning })}
        />
        <p className={HELP}>How long the model thinks before it writes a memory.</p>
      </div>
      <MemorySize
        label="Remember every"
        unit="tokens"
        value={settings.memorySpanTokens}
        range={MEMORY_LIMITS.spanTokens}
        step={500}
        onChange={(spanTokens) => save({ spanTokens })}
        help="A memory is written once this much of the story is unremembered."
      />
      <MemorySize
        label="Keep recent turns"
        unit="turns"
        value={settings.memoryKeepTurns}
        range={MEMORY_LIMITS.keepTurns}
        step={1}
        onChange={(keepTurns) => save({ keepTurns })}
        help="The newest turns stay out of a memory, so the scene in play is sent whole."
      />
      <MemorySize
        label="Recap budget"
        unit="tokens"
        value={settings.memoryRecapTokens}
        range={MEMORY_LIMITS.recapTokens}
        step={500}
        onChange={(recapTokens) => save({ recapTokens })}
        onClear={() => save({ recapTokens: null })}
        help="How much of this chat's memories every prompt carries. Past it, the oldest merge into a chapter. Left empty, it is Automatic: the room memory has in the model's context window. A number caps it."
      />
    </div>
  );
}

/**
 * The model and effort of the cast keeper, which keeps track of who is in
 * the scene. Unset, both follow memory's.
 */
function CastSettings() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const modelLabel = useId();
  const effortLabel = useId();
  const { castModel } = settings;
  const save = (choice: Parameters<typeof castPatch>[0]) => updateSettings(castPatch(choice));
  const modelOptions = useModelOptions(castModel);
  // Efforts narrow to what the model cast calls go to offers.
  const { efforts, effort } = useEffortChoice(
    castModelOf(settings),
    castReasoningOf(settings) ?? "provider-default",
  );

  return (
    <div className="grid gap-6">
      <p className={HELP}>
        After each reply, a keeper notes who is in the scene: how each person looks, what they wear
        and where they are, so the story keeps them straight. It is bookkeeping, and a smaller,
        faster model does it well.
      </p>
      <div className="grid gap-2">
        <span id={modelLabel} className="font-medium text-ink text-ui">
          Cast model
        </span>
        <ModelSelect
          labelId={modelLabel}
          options={modelOptions}
          lead={{ value: MEMORY_MODEL, label: "Memory's model" }}
          value={castModel ?? MEMORY_MODEL}
          onChange={(model) => save({ model })}
          className={FIELD_WIDTH}
        />
        <WindowNote model={castModel} />
        <p className={HELP}>
          The model that keeps the cast. Unset, it is the one writing memories.
        </p>
      </div>
      <div className="grid gap-2">
        <span id={effortLabel} className="font-medium text-ink text-ui">
          Cast reasoning effort
        </span>
        <ReasoningSelect
          labelId={effortLabel}
          efforts={efforts}
          effort={effort}
          onChange={(reasoning) => save({ reasoning })}
          follow={{
            label: "Memory's effort",
            chosen: settings.castReasoning === null,
            onChoose: () => save({ reasoning: null }),
          }}
        />
        <p className={HELP}>
          How long the model thinks before it updates the cast. Unset, it is memory's.
        </p>
      </div>
    </div>
  );
}

/**
 * One of memory's sizes, typed or stepped within its limits. With `onClear`
 * it may be left empty (`value` null), which shows as Automatic.
 */
function MemorySize({
  label,
  unit,
  value,
  range,
  step,
  onChange,
  onClear,
  help,
}: {
  label: string;
  unit: string;
  value: number | null;
  range: { min: number; max: number };
  step: number;
  onChange: (value: number) => void;
  onClear?: () => void;
  help: string;
}) {
  const helpId = useId();
  const draft = useNumberDraft(value, onChange, onClear);
  return (
    <div className="grid gap-2">
      <span className="font-medium text-ink text-ui">{label}</span>
      <span className="flex items-center gap-2">
        <NumberField
          {...draft}
          min={range.min}
          max={range.max}
          step={step}
          largeStep={step * 8}
          label={label}
          describedBy={helpId}
          className="w-40 touch:w-48"
          format={{ maximumFractionDigits: 0 }}
          {...(onClear === undefined ? {} : { placeholder: "Automatic" })}
        />
        <span className="text-note text-reed">{unit}</span>
      </span>
      <p id={helpId} className={HELP}>
        {help} From {formatCount(range.min)} to {formatCount(range.max)}.
      </p>
    </div>
  );
}
