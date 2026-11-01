import {
  castModelOf,
  castReasoningOf,
  DEFAULT_CONTEXT_LIMIT,
  MEMORY_LIMITS,
  memoryModelOf,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { NoticeCard } from "@/app/NoticeCard.tsx";
import { PalettePicker } from "@/app/PalettePicker.tsx";
import { SCROLL_GUTTERS, ScreenHeader, SETTINGS_FRAME } from "@/app/Screen.tsx";
import { ThemeSwitch } from "@/app/ThemeSwitch.tsx";
import { BackIcon, NextIcon } from "@/components/icons";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Infotip } from "@/components/ui/infotip";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectTrigger } from "@/components/ui/select";
import { SwitchField } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { formatCount, sentence } from "@/lib/text";
import { useModelOptions } from "../api.ts";
import { ReasoningSelect, useEffortChoice } from "../creator/ReasoningSelect.tsx";
import { PersonaOptions } from "../personas/PersonaSelect.tsx";
import { personasQuery } from "../personas/queries.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { useNotReached } from "../signin/hooks.ts";
import { ContextSize } from "./ContextSize.tsx";
import { useNumberDraft } from "./number-draft.ts";
import { Pictures } from "./Pictures.tsx";
import { PostProcessing } from "./PostProcessing.tsx";
import { HINT, ROW_SELECT, SettingGroup, SettingRow, WithUnit } from "./SettingRow.tsx";
import { SECTION_TEXT, SECTIONS, type Section, sectionSchema, shownSection } from "./sections.ts";
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
import { SectionLink, useSectionNavigation } from "./window-link.tsx";

const NO_DEFAULT = "none";

/**
 * Settings kept on the server, in six categories (`sections.ts`): an index
 * beside one open category from tablet up; on phones a list of the
 * categories, each opening on a screen of its own with a back control.
 * Every category stays mounted while Settings is open, so an unfinished
 * palette or workflow import survives a switch. A failed or refused save is
 * reported above whichever category is open. `search.window` is a model a
 * link asked to set a context window for: Model setup opens on it.
 */
export function SettingsScreen({
  search,
  onWindowShown,
}: {
  search: { section?: Section | undefined; window?: string | undefined };
  onWindowShown: () => void;
}) {
  const phone = useFormFactor() === "phone";
  const shown = shownSection(search, phone);
  const { open: openSection, back } = useSectionNavigation();
  const fromList = useLocation({ select: (location) => location.state.settingsList === true });
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<Section, HTMLAnchorElement>());
  const left = useRef<Section | null>(shown);

  // Back on the phone's list, the category just left takes focus.
  useEffect(() => {
    const last = left.current;
    left.current = shown;
    if (shown === null && last !== null) rows.current.get(last)?.focus();
  }, [shown]);

  const open = (next: Section) => {
    openSection(next);
    scroller.current?.scrollTo({ top: 0 });
  };
  const category = shown === null ? null : SECTION_TEXT[shown];

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <ScreenHeader
        title={phone && category !== null ? category.label : "Settings"}
        storyTitle={false}
        lead={
          phone && category !== null ? (
            <Button size="icon" aria-label="Back to settings" onClick={() => back(fromList)}>
              <BackIcon />
            </Button>
          ) : undefined
        }
        frame={SETTINGS_FRAME}
        gutters={SCROLL_GUTTERS}
      />
      <div
        ref={scroller}
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        <div className={cn(SETTINGS_FRAME, "grid gap-6 pt-4 pb-16 tablet:gap-8 tablet:pt-8")}>
          <SaveAlerts />
          {phone && shown === null && (
            <nav aria-label="Settings categories">
              <ul className="grid divide-y divide-rush border-rush border-b">
                {SECTIONS.map((section) => (
                  <li key={section}>
                    <SectionLink
                      ref={(element) => {
                        if (element === null) rows.current.delete(section);
                        else rows.current.set(section, element);
                      }}
                      section={section}
                      className="press grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-3"
                    >
                      <span className="grid gap-0.5">
                        <span className="font-medium text-ink text-ui">
                          {SECTION_TEXT[section].label}
                        </span>
                        <span className="text-pretty text-note text-reed">
                          {SECTION_TEXT[section].purpose}
                        </span>
                      </span>
                      <NextIcon size={16} className="text-reed" />
                    </SectionLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <Tabs
            orientation="vertical"
            value={shown}
            onValueChange={(next, details) => {
              const section = sectionSchema.safeParse(next);
              if (details.reason === "none" && section.success) open(section.data);
            }}
            className="tablet:grid tablet:grid-cols-[9rem_minmax(0,1fr)] tablet:items-start tablet:gap-x-8 desktop:grid-cols-[var(--container-index)_minmax(0,var(--container-measure))] desktop:gap-x-(--gap-index)"
          >
            <TabsList
              aria-label="Settings categories"
              activateOnFocus={false}
              loopFocus
              className={cn("sticky top-6 self-start", phone && "hidden")}
            >
              {SECTIONS.map((section) => (
                <TabsTab key={section} value={section}>
                  {SECTION_TEXT[section].label}
                </TabsTab>
              ))}
            </TabsList>
            <Panel
              section="appearance"
              phone={phone}
              note="Saved on this server, so a reload or another device keeps your choices."
            >
              <AppearanceSettings />
            </Panel>
            <Panel section="chat" phone={phone}>
              <ChatSettings />
            </Panel>
            <Panel section="setup" phone={phone}>
              <SettingGroup
                title="Context"
                lead={`How much of each model's window a prompt may use, ${formatCount(DEFAULT_CONTEXT_LIMIT)} tokens unless set here.`}
                about={
                  <p>
                    How much of a model's context window a prompt may use; the oldest history is
                    trimmed to fit. A model whose provider reports no window needs one set here
                    before replies can be sent; use the figure the provider documents.
                  </p>
                }
              >
                <ContextSize windowFor={search.window ?? null} onWindowShown={onWindowShown} />
              </SettingGroup>
              <SettingGroup
                title="Post-processing"
                lead="Off for every model unless set here."
                about={
                  <p>
                    Some models refuse system messages between turns, or need turns to alternate
                    strictly. Pick the lightest mode the model accepts; the line under each model
                    says what its mode changes.
                  </p>
                }
              >
                <PostProcessing />
              </SettingGroup>
            </Panel>
            <Panel
              section="memory"
              phone={phone}
              lead="Memory is on for every character; turn it off on a character's sheet."
            >
              <MemorySettings />
              <CastSettings />
            </Panel>
            <Panel section="pictures" phone={phone}>
              <Pictures />
            </Panel>
            <Panel section="kept" phone={phone}>
              <KeptSettings />
            </Panel>
          </Tabs>
        </div>
      </div>
    </main>
  );
}

/**
 * A category's panel: its title (the header carries it on phones) and lead,
 * then its groups, then a `note` that stays secondary: guidance worth
 * knowing that no setting depends on.
 */
function Panel({
  section,
  phone,
  lead,
  note,
  children,
}: {
  section: Section;
  phone: boolean;
  lead?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <TabsPanel
      value={section}
      keepMounted
      className="grid min-w-0 gap-8 tablet:col-start-2 tablet:gap-10"
    >
      {/* On phones the header names the category; with no lead, the head leaves the flow. */}
      <div className={cn("grid gap-1", phone && lead === undefined && "sr-only")}>
        <h2 className={cn("font-semibold text-heading text-ink", phone && "sr-only")}>
          {SECTION_TEXT[section].label}
        </h2>
        {lead !== undefined && <p className={HINT}>{lead}</p>}
      </div>
      {children}
      {note !== undefined && <p className={cn(HINT, "-mt-4 tablet:-mt-6")}>{note}</p>}
    </TabsPanel>
  );
}

/** A failed save, with Try again, or a refused one: shown above every category. */
function SaveAlerts() {
  const failed = useFailedSettingsSave();
  const refused = useRefusedSettingsSave();
  const notReachedText = useNotReached();
  if (failed) {
    return (
      <NoticeCard
        placement="dock"
        role="alert"
        title="Not saved"
        body={`${sentence(notReachedText)}. This tab keeps your choice.`}
        actions={
          <Button variant="outline" onClick={() => void retryFailedSettings()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (refused) {
    return (
      <NoticeCard
        placement="dock"
        role="alert"
        title="Not saved"
        body="A character, persona, preset or workflow you chose no longer exists. This tab keeps the choice until you pick another."
      />
    );
  }
  return null;
}

function AppearanceSettings() {
  const paletteLabel = useId();
  return (
    <SettingGroup>
      <SettingRow
        label="Theme"
        control="choices"
        about={
          <p>
            Light, dark, or whichever your system is using right now. Match system follows the
            system as it changes through the day.
          </p>
        }
      >
        <ThemeSwitch labelled />
      </SettingRow>
      <SettingRow
        label="Palette"
        labelId={paletteLabel}
        hint="Each palette has a day and a night scheme; Theme picks between them."
        about={
          <p>
            Six palettes come built in. Your palettes holds up to three of your own: start one from
            any palette, change its colours, and Ephemera warns when text would be hard to read but
            never refuses a choice.
          </p>
        }
        control="panel"
      >
        <PalettePicker labelId={paletteLabel} />
      </SettingRow>
    </SettingGroup>
  );
}

/** Who a chat starts as and with which model, whose prompts win, and how reasoning shows. */
function ChatSettings() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const personas = useQuery(personasQuery);
  const personaLabel = useId();
  const modelLabel = useId();
  const list = personas.data ?? [];
  const defaultPersona = list.find((persona) => persona.id === settings.defaultPersonaId);
  const modelOptions = useModelOptions(settings.model);

  return (
    <>
      <SettingGroup title="Starting a chat">
        <SettingRow
          label="Default persona"
          labelId={personaLabel}
          about={
            <p>
              The persona a new chat opens as, unless the character is tied to another one. Without
              a default, a new chat keeps whichever persona you used last.
            </p>
          }
        >
          <Select
            value={defaultPersona?.id ?? NO_DEFAULT}
            onValueChange={(value) =>
              updateSettings({
                defaultPersonaId: typeof value === "string" && value !== NO_DEFAULT ? value : null,
              })
            }
          >
            <SelectTrigger
              aria-labelledby={personaLabel}
              placeholder="No default persona"
              className={cn(ROW_SELECT, "h-11 pl-1.5 touch:h-12")}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                {defaultPersona && (
                  <PortraitLeaf
                    owner="personas"
                    id={defaultPersona.id}
                    name={defaultPersona.name}
                    version={defaultPersona.portrait}
                    className="w-6"
                  />
                )}
                <span className="truncate">{defaultPersona?.name ?? "No default persona"}</span>
              </span>
            </SelectTrigger>
            <SelectContent label="Personas">
              <PersonaOptions none={NO_DEFAULT} noneLabel="No default persona" personas={list} />
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Reply model"
          labelId={modelLabel}
          about={
            <p>
              The model that writes replies, and the one a reload comes back to. The Session panel
              can switch it for the chat in front of you, and a session or sampler preset that names
              a model switches it too.
            </p>
          }
          below={<WindowNote model={settings.model} />}
        >
          <ModelSelect
            labelId={modelLabel}
            options={modelOptions}
            value={settings.model}
            onChange={(model) => updateSettings({ model })}
            className={ROW_SELECT}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Character prompts">
        <div className="py-3.5">
          <SwitchField
            trailing
            checked={settings.preferCharacterPrompt}
            onCheckedChange={(preferCharacterPrompt) => updateSettings({ preferCharacterPrompt })}
            label="Prefer the character's system prompt"
            description="Its own system prompt replaces the preset's main prompt."
            about={
              <Infotip label="Prefer the character's system prompt">
                <p>
                  Some character cards bring their own system prompt. On, it replaces the main
                  prompt of whichever prompt preset is active, for that character only. Off, the
                  preset's main prompt is used even when the card has its own. On by default.
                </p>
              </Infotip>
            }
          />
        </div>
        <div className="py-3.5">
          <SwitchField
            trailing
            checked={settings.preferCharacterInstructions}
            onCheckedChange={(preferCharacterInstructions) =>
              updateSettings({ preferCharacterInstructions })
            }
            label="Prefer the character's post-history instructions"
            description="Its own post-history instructions replace the preset's."
            about={
              <Infotip label="Prefer the character's post-history instructions">
                <p>
                  Post-history instructions sit after the chat history, where models pay the most
                  attention. On, a card's own replace the preset's for that character. Off, the
                  preset's are sent even when the card has its own. On by default.
                </p>
              </Infotip>
            }
          />
        </div>
      </SettingGroup>

      <SettingGroup title="Reasoning">
        <div className="py-3.5">
          <SwitchField
            trailing
            checked={settings.reasoningOpen}
            onCheckedChange={(reasoningOpen) => updateSettings({ reasoningOpen })}
            label="Show reasoning open"
            description="A reply's reasoning starts open instead of folded."
            about={
              <Infotip label="Show reasoning open">
                <p>
                  Models that reason show their thinking above the reply, folded by default. On,
                  each reply arrives with its reasoning open; you can still fold any reply's.
                </p>
              </Infotip>
            }
          />
        </div>
        <div className="py-3.5">
          <SwitchField
            trailing
            checked={settings.showHiddenReasoning}
            onCheckedChange={(showHiddenReasoning) => updateSettings({ showHiddenReasoning })}
            label="Time hidden reasoning"
            description="When a model keeps its reasoning to itself, say how long it thought."
            about={
              <Infotip label="Time hidden reasoning">
                <p>
                  Some models reason but send none of it. On, the reply shows how long the model
                  thought before answering, so a slow reply is explained. Off, nothing is shown.
                </p>
              </Infotip>
            }
          />
        </div>
      </SettingGroup>
    </>
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
    <SettingGroup>
      <div className="py-3.5">
        <SwitchField
          trailing
          checked={settings.memoryOpening}
          onCheckedChange={(opening) => save({ opening })}
          label="Open new chats where the story left off"
          description="A new chat opens on the memory's opening; the card's greeting is a swipe away."
          about={
            <Infotip label="Open new chats where the story left off">
              <p>
                With memory on, a character writes an opening for its next chat, picking up where
                the last one ended. On, a new chat starts there and the card's own greeting is one
                swipe away. Off, the card's greeting opens every chat; the memory's opening waits on
                the character's memory screen. On by default.
              </p>
            </Infotip>
          }
        />
      </div>
      <SettingRow
        label="Memory model"
        labelId={modelLabel}
        about={<p>The model that writes memories. Uses the reply model unless you pick another.</p>}
        below={<WindowNote model={memoryModel} />}
      >
        <ModelSelect
          labelId={modelLabel}
          options={modelOptions}
          lead={{ value: REPLY_MODEL, label: "The reply's model" }}
          value={memoryModel ?? REPLY_MODEL}
          onChange={(model) => save({ model })}
          className={ROW_SELECT}
        />
      </SettingRow>
      <SettingRow
        label="Memory reasoning effort"
        labelId={effortLabel}
        about={
          <p>
            How long the memory model thinks before it writes. Model default leaves that to the
            model; higher efforts take longer on every memory. Only efforts the chosen model offers
            are listed.
          </p>
        }
      >
        <ReasoningSelect
          labelId={effortLabel}
          efforts={efforts}
          effort={effort}
          onChange={(reasoning) => save({ reasoning })}
          className={ROW_SELECT}
        />
      </SettingRow>
      <MemorySize
        label="Remember every"
        unit="tokens"
        value={settings.memorySpanTokens}
        range={MEMORY_LIMITS.spanTokens}
        step={500}
        onChange={(spanTokens) => save({ spanTokens })}
        about="Writes a memory once this much new story has built up. Lower writes smaller memories more often; higher waits longer between them."
      />
      <MemorySize
        label="Keep recent turns"
        unit="turns"
        value={settings.memoryKeepTurns}
        range={MEMORY_LIMITS.keepTurns}
        step={1}
        onChange={(keepTurns) => save({ keepTurns })}
        about="The newest turns are never folded into a memory, so the scene in play reaches the model whole. Raise it when the model loses the thread of the last exchange; lower it to free room for memories."
      />
      <MemorySize
        label="Recap budget"
        unit="tokens"
        value={settings.memoryRecapTokens}
        range={MEMORY_LIMITS.recapTokens}
        step={500}
        onChange={(recapTokens) => save({ recapTokens })}
        onClear={() => save({ recapTokens: null })}
        about="How much of a chat's memories every prompt carries. Past the budget, the oldest memories merge into a chapter. Empty, Automatic uses the room memory has inside the model's context window; a number caps it."
      />
    </SettingGroup>
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
    <SettingGroup
      title="Cast"
      lead="After each reply a keeper notes who is in the scene: how each person looks, what they wear and where they are."
    >
      <SettingRow
        label="Cast model"
        labelId={modelLabel}
        about={
          <p>
            Keeps track of who is in the current scene and how they stand. Uses the memory model
            unless you pick another.
          </p>
        }
        below={<WindowNote model={castModel} />}
      >
        <ModelSelect
          labelId={modelLabel}
          options={modelOptions}
          lead={{ value: MEMORY_MODEL, label: "Memory's model" }}
          value={castModel ?? MEMORY_MODEL}
          onChange={(model) => save({ model })}
          className={ROW_SELECT}
        />
      </SettingRow>
      <SettingRow
        label="Cast reasoning effort"
        labelId={effortLabel}
        about={
          <p>
            How long the cast model thinks before it updates the cast. Memory's effort unless set
            here.
          </p>
        }
      >
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
          className={ROW_SELECT}
        />
      </SettingRow>
    </SettingGroup>
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
  about,
}: {
  label: string;
  unit: string;
  value: number | null;
  range: { min: number; max: number };
  step: number;
  onChange: (value: number) => void;
  onClear?: () => void;
  about: string;
}) {
  const hintId = useId();
  const draft = useNumberDraft(value, onChange, onClear);
  const limits = `From ${formatCount(range.min)} to ${formatCount(range.max)}.`;
  return (
    <SettingRow
      label={label}
      hint={onClear === undefined ? limits : `Empty is Automatic. ${limits}`}
      hintId={hintId}
      about={<p>{about}</p>}
    >
      <WithUnit unit={unit}>
        <NumberField
          {...draft}
          min={range.min}
          max={range.max}
          step={step}
          largeStep={step * 8}
          label={label}
          describedBy={hintId}
          className="w-40 touch:w-48"
          format={{ maximumFractionDigits: 0 }}
          {...(onClear === undefined ? {} : { placeholder: "Automatic" })}
        />
      </WithUnit>
    </SettingRow>
  );
}

/** What is kept, as two lists: each line's lead words in Ink. */
const KEPT: { title: string; lines: [lead: string, rest: string][] }[] = [
  {
    title: "On this server",
    lines: [
      ["Characters", ", with their portraits."],
      ["Personas and presets", "."],
      ["These settings", ", and the character and persona you chose last."],
      [
        "Each character's memories",
        ": its notebook, the next chat's opening and the scene memories written from its chats, until you forget them.",
      ],
      ["Each character's cast sheet", ", read from its card alone."],
    ],
  },
  {
    title: "Not saved",
    lines: [
      ["Messages", ", drafts, replies and their reasoning."],
      ["The chat's cast", ", with your corrections."],
      ["Scene pictures", ", and the prompts written for them."],
    ],
  },
];

function KeptSettings() {
  return (
    <div className="grid gap-6">
      <div className="grid gap-8 tablet:grid-cols-2">
        {KEPT.map(({ title, lines }) => (
          <section key={title} className="grid content-start gap-3">
            <h3 className="font-semibold text-ink text-lead">{title}</h3>
            <ul className="grid gap-2 text-pretty text-note text-reed">
              {lines.map(([lead, rest]) => (
                <li key={lead}>
                  <span className="text-ink">{lead}</span>
                  {rest}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="text-pretty text-note text-reed">
        A reload, closing the tab or Clear ends the chat for good.
      </p>
    </div>
  );
}
