import { Collapsible } from "@base-ui/react/collapsible";
import { offeredEfforts, type StoredSamplerPreset } from "@ephemera/core";
import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useId, useState } from "react";
import { canDock, useCanDock, useFocusAcrossLayout, useFormFactor } from "@/app/form-factor.ts";
import { NoticeSlot } from "@/app/NoticeCard.tsx";
import { setSessionOpen, useUi } from "@/app/ui.ts";
import { CloseIcon } from "@/components/icons";
import { ModelSelect } from "@/components/model-select";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Drawer,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  PANEL_TITLE,
} from "@/components/ui/drawer";
import {
  LEAF_TRIGGER,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TRIGGER,
} from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/text";
import { useContextWindow, useModelInfo, useModelOptions } from "../api.ts";
import { charactersQuery } from "../characters/queries.ts";
import { PersonaSelect } from "../personas/PersonaSelect.tsx";
import {
  bindCharacter,
  boundPersona,
  personasQuery,
  refreshPersonas,
} from "../personas/queries.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import {
  type PresetKind,
  presetsQuery,
  REASONING_LABELS,
  samplerSummary,
} from "../presets/queries.ts";
import { useSettings, useUpdateSettings } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { COMPACT_LABEL, EXPLANATION } from "../sheet/fields.ts";
import { useNotReached } from "../signin/hooks.ts";
import { useChatCharacter, useChatPersona } from "./character.ts";
import { useStartChat } from "./StartChat.tsx";

/** Session's sheet, below the docked width. */
export const SESSION_SHEET = "[data-session-sheet]";
/** Session docked beside the thread. */
const SESSION_DOCK = "[data-session-dock]";
const FIRST_CONTROL = 'a[href], button, [tabindex="0"], select, input, textarea';

/**
 * Session settings for this chat. Docked beside the thread on wide desktops,
 * a side sheet on tablets and narrower desktops, a bottom sheet on phones.
 */
export function SessionPanel({ toggle }: { toggle: RefObject<HTMLButtonElement | null> }) {
  const open = useUi((state) => state.sessionOpen);
  const formFactor = useFormFactor();
  const docked = useCanDock();
  // Docking swaps the aside for a sheet, or back: focus inside Session stays inside it.
  useFocusAcrossLayout(docked, (lost) => {
    if (lost.closest(`${SESSION_DOCK}, ${SESSION_SHEET}`) === null) return null;
    const panel = document.querySelector<HTMLElement>(docked ? SESSION_DOCK : SESSION_SHEET);
    return panel?.querySelector<HTMLElement>(FIRST_CONTROL);
  });

  if (docked) {
    return (
      <Collapsible.Root open={open} className="contents">
        <Collapsible.Panel
          render={<aside />}
          aria-labelledby="session-title"
          data-session-dock=""
          data-leaving={open ? undefined : ""}
          inert={!open}
          className="dock-side shrink-0 overflow-clip"
        >
          <div className="flex h-full w-80 flex-col border-rush border-l">
            <DrawerHeader>
              <h2 id="session-title" className={PANEL_TITLE}>
                Session
              </h2>
              <Button
                size="icon"
                aria-label="Close Session"
                onClick={() => {
                  setSessionOpen(false);
                  // The panel leaves with its button; focus returns to the toggle.
                  toggle.current?.focus();
                }}
              >
                <CloseIcon />
              </Button>
            </DrawerHeader>
            <SessionFields />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    );
  }

  const phone = formFactor === "phone";
  return (
    <Drawer
      open={open}
      onOpenChange={setSessionOpen}
      swipeDirection={phone ? "down" : "right"}
      showSwipeHandle={phone}
    >
      {/*
       * Gone because the window now docks Session, the sheet leaves focus to the dock
       * (`useFocusAcrossLayout`) instead of returning it to the toggle after it.
       */}
      <DrawerContent data-session-sheet="" finalFocus={() => !canDock()}>
        <DrawerHeader>
          <DrawerTitle>Session</DrawerTitle>
          <DrawerCloseIcon label="Close Session" />
        </DrawerHeader>
        <SessionFields />
      </DrawerContent>
    </Drawer>
  );
}

function SessionFields() {
  return (
    // One shrinkable column: a long name truncates in its trigger instead of widening the panel.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-7 overflow-y-auto px-5 pt-2 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
      <CharacterField />
      <PersonaField />
      <hr className="border-rush" />
      <SamplerPresetField />
      <ModelField />
      <PromptPresetField />
    </div>
  );
}

/** A labelled Session field; the label names its control through `aria-labelledby`. */
function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: ReactNode;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <span id={labelId} className={COMPACT_LABEL}>
        {label}
      </span>
      {children(labelId)}
      {note && (
        <p
          key={typeof note === "string" ? note : undefined}
          className={cn(
            EXPLANATION,
            "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0",
          )}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/** Leaving for the gallery: a sheet over the chat closes, so it does not reopen over the next one. */
const leaveSession = () => {
  if (!canDock()) setSessionOpen(false);
};

/**
 * Who the chat is with, chosen in the gallery: the row shows the character
 * and opens the gallery, where each card's Chat starts a chat with it. No
 * character starts a chat without one, asking first as any switch does.
 */
function CharacterField() {
  const characters = useQuery(charactersQuery);
  const current = useChatCharacter();
  const { start, dialog } = useStartChat();
  const rowId = useId();
  // An empty library has nothing to switch to: the note points to where characters come from.
  const empty = characters.data?.length === 0;

  return (
    <Field label="Character">
      {(labelId) => (
        <>
          <Link
            to="/characters"
            onClick={leaveSession}
            aria-labelledby={`${labelId} ${rowId}`}
            className={cn(TRIGGER, current && LEAF_TRIGGER.trigger)}
          >
            <span id={rowId} className="flex min-w-0 flex-1 items-center gap-3">
              {current && (
                <PortraitLeaf
                  id={current.id}
                  name={current.name}
                  version={current.portrait}
                  className={LEAF_TRIGGER.leaf}
                />
              )}
              <span className={cn("min-w-0 flex-1 truncate", !current && "text-reed")}>
                {current?.name ?? "No character"}
              </span>
              <span className="shrink-0 pr-1 text-note text-reed">
                {current ? "Change" : "Choose"}
              </span>
            </span>
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p className={EXPLANATION}>
              {empty ? (
                <>
                  No characters yet. Add one in{" "}
                  <Link
                    to="/characters"
                    onClick={leaveSession}
                    className="underline decoration-control-edge underline-offset-4 hover:decoration-ink touch:relative touch:-my-3 touch:py-3"
                  >
                    Characters
                  </Link>
                  .
                </>
              ) : (
                "Switching starts a new chat."
              )}
            </p>
            {current && (
              <Button size="text" className="-mr-2" onClick={() => start(null, "")}>
                No character
              </Button>
            )}
          </div>
          {dialog}
        </>
      )}
    </Field>
  );
}

/**
 * Who the user is. Changing persona keeps the chat; each turn keeps the
 * persona it was sent as. "Always use with" binds the persona to the
 * character, taking it from another persona if needed.
 */
function PersonaField() {
  const queryClient = useQueryClient();
  const personas = useQuery(personasQuery);
  const persona = useChatPersona();
  const character = useChatCharacter();
  const [moved, setMoved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const notReachedText = useNotReached();
  const list = personas.data ?? [];
  const bound = character ? boundPersona(personas.data, character.id) : null;

  const bind = async (checked: boolean) => {
    if (!character || !persona) return;
    const holder = list.find((other) => other.id === bound && other.id !== persona.id);
    const ok = await bindCharacter(character.id, checked ? persona.id : null);
    setFailed(!ok);
    if (!ok) return;
    setMoved(
      checked && holder
        ? `${character.name} now goes with ${persona.name}, no longer with ${holder.name}.`
        : null,
    );
    await refreshPersonas(queryClient);
  };

  return (
    <div className="grid gap-2">
      <Field
        label="Persona"
        note="Changing persona keeps the chat. Your next messages are cued as the new persona."
      >
        {(labelId) => <PersonaSelect labelId={labelId} onChosen={() => setMoved(null)} />}
      </Field>
      {character && persona && (
        <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-ink text-ui touch:min-h-11">
          <Checkbox
            checked={bound === persona.id}
            onCheckedChange={(checked) => void bind(checked)}
          />
          Always use with {character.name}
        </label>
      )}
      {/* The grid's gap moves inside the slot, so it folds away with the line. */}
      <NoticeSlot
        className="-mt-2"
        value={
          failed
            ? ({ kind: "alert", text: `Not changed: ${notReachedText}.` } as const)
            : moved
              ? ({ kind: "status", text: moved } as const)
              : null
        }
      >
        {(notice) => (
          <p
            role={notice.kind}
            className={cn(
              "text-pretty pt-2 text-note",
              notice.kind === "alert" ? "text-ember" : "text-reed",
            )}
          >
            {notice.text}
          </p>
        )}
      </NoticeSlot>
    </div>
  );
}

/**
 * A preset select of the Session panel: the listed presets, the chosen one
 * (only a listed preset is shown as chosen; its id is never shown as a
 * name), its Edit link, and Try again while the first load failed.
 */
function PresetField<T extends { id: string; name: string }>({
  kind,
  label,
  note,
  presets,
  chosen,
  onChoose,
}: {
  kind: PresetKind;
  label: string;
  note: string | undefined;
  presets: UseQueryResult<T[]>;
  chosen: T | undefined;
  onChoose: (preset: T) => void;
}) {
  return (
    <Field label={label} note={note}>
      {(labelId) => (
        <div className="flex items-center gap-1">
          <PresetSelect
            labelId={labelId}
            label={label}
            presets={presets}
            chosen={chosen}
            onChoose={onChoose}
          />
          {chosen && (
            <Link
              to={kind === "sampler" ? "/presets/sampler/$id" : "/presets/prompt/$id"}
              params={{ id: chosen.id }}
              aria-label={`Edit ${chosen.name}`}
              className={buttonVariants({ className: "px-2.5" })}
            >
              Edit
            </Link>
          )}
          {presets.isError && presets.data === undefined && (
            <Button variant="outline" onClick={() => void presets.refetch()}>
              Try again
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

/** The preset list itself, as a field (Session) or set in a line of words (beside the composer). */
function PresetSelect<T extends { id: string; name: string }>({
  labelId,
  label,
  presets,
  chosen,
  onChoose,
  look = "field",
}: {
  labelId: string;
  label: string;
  presets: UseQueryResult<T[]>;
  chosen: T | undefined;
  onChoose: (preset: T) => void;
  look?: "field" | "inline";
}) {
  const list = presets.data ?? [];
  return (
    <Select
      value={chosen?.id ?? null}
      items={Object.fromEntries(list.map((preset) => [preset.id, preset.name]))}
      onValueChange={(value) => {
        const preset = list.find((option) => option.id === value);
        if (preset) onChoose(preset);
      }}
    >
      <SelectTrigger
        aria-labelledby={labelId}
        look={look}
        placeholder={look === "inline" ? "None" : presetPlaceholder(presets)}
      />
      <SelectContent label={`${label}s`} {...(look === "inline" && { className: "min-w-64" })}>
        {list.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            {preset.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The chat's sampler preset and how choosing one is saved: a preset that
 * names a model switches the chat to it. Session and the composer's line
 * both choose through it.
 */
function useSamplerChoice() {
  const presets = useQuery(presetsQuery("sampler"));
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const chosen = presets.data?.find((preset) => preset.id === settings.samplerPresetId);
  const choose = (preset: StoredSamplerPreset) =>
    updateSettings({
      samplerPresetId: preset.id,
      ...(preset.values.model === null ? {} : { model: preset.values.model }),
    });
  return { presets, chosen, choose };
}

/** The sampler preset set in a line of words, as the composer shows it; it chooses as Session does. */
export function SamplerPresetSelect({ labelId }: { labelId: string }) {
  const { presets, chosen, choose } = useSamplerChoice();
  return (
    <PresetSelect
      labelId={labelId}
      label="Sampler preset"
      presets={presets}
      chosen={chosen}
      onChoose={choose}
      look="inline"
    />
  );
}

/**
 * How replies are drawn. A preset that names a model switches the chat to it;
 * an effort the chat's model does not offer is not sent, and this says so.
 */
function SamplerPresetField() {
  const { presets, chosen, choose } = useSamplerChoice();
  const settings = useSettings();
  const model = useModelInfo(settings.model);
  const named = chosen?.values.model ?? null;
  const effort = chosen?.values.reasoning;
  const note = chosen
    ? named !== null && settings.model !== null && named !== settings.model
      ? `${chosen.name} names ${named}; this chat now uses ${settings.model}.`
      : model !== undefined && effort !== undefined && !offeredEfforts(model).includes(effort)
        ? `${chosen.name} asks for ${REASONING_LABELS[effort].toLowerCase()} reasoning; ${model.id} doesn't offer it, so none is sent.`
        : samplerSummary(chosen.values, false)
    : undefined;
  return (
    <PresetField
      kind="sampler"
      label="Sampler preset"
      note={note}
      presets={presets}
      chosen={chosen}
      onChoose={choose}
    />
  );
}

/** What a preset select says when no listed preset is chosen. */
const presetPlaceholder = (list: { isPending: boolean; isError: boolean; data?: unknown }) =>
  list.isPending
    ? "Loading presets…"
    : list.isError && list.data === undefined
      ? "Presets could not be loaded"
      : "Choose a preset";

function ModelField() {
  const settings = useSettings();
  const { model } = settings;
  const options = useModelOptions(model);
  const updateSettings = useUpdateSettings();
  const window = useContextWindow(model, settings);
  const windowNote =
    window === null
      ? ""
      : window === "loading"
        ? ""
        : window.limit === "owner"
          ? ` Context ${formatCount(window.tokens)} of ${formatCount(window.model)} tokens, limited in Settings.`
          : window.limit === "default"
            ? ` Context ${formatCount(window.tokens)} of ${formatCount(window.model)} tokens, the default limit; Settings can change it.`
            : ` Context window ${formatCount(window.tokens)} tokens${window.source === "owner" ? ", set by you" : ""}.`;

  return (
    <Field
      label="Model"
      note={
        window === null && model !== null ? (
          <>
            Used for every reply from now on, and kept after a reload. No known context window:{" "}
            <WindowLink model={model}>set one</WindowLink> to send.
          </>
        ) : (
          `Used for every reply from now on, and kept after a reload.${windowNote}`
        )
      }
    >
      {(labelId) => (
        <ModelSelect
          labelId={labelId}
          options={options}
          value={model}
          onChange={(chosen) => updateSettings({ model: chosen })}
          className="max-w-none tablet:w-full"
        />
      )}
    </Field>
  );
}

/** What is sent, in which order: the preset that builds every prompt. */
function PromptPresetField() {
  const presets = useQuery(presetsQuery("prompt"));
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  return (
    <PresetField
      kind="prompt"
      label="Prompt preset"
      note="Builds the prompt of every reply from now on."
      presets={presets}
      chosen={presets.data?.find((preset) => preset.id === settings.promptPresetId)}
      onChoose={(preset) => updateSettings({ promptPresetId: preset.id })}
    />
  );
}
