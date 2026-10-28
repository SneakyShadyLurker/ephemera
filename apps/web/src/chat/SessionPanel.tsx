import { offeredEfforts } from "@ephemera/core";
import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useId, useState } from "react";
import { useCanDock, useFormFactor } from "@/app/form-factor.ts";
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
} from "@/components/ui/select";
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
import { useNotReached } from "../signin/hooks.ts";
import { useChatCharacter, useChatPersona } from "./character.ts";
import { useStartChat } from "./StartChat.tsx";

/** Session's sheet, below the docked width. */
export const SESSION_SHEET = "[data-session-sheet]";

/**
 * Session settings for this chat. Docked beside the thread on wide desktops,
 * a side sheet on tablets and narrower desktops, a bottom sheet on phones.
 */
export function SessionPanel({ toggle }: { toggle: RefObject<HTMLButtonElement | null> }) {
  const open = useUi((state) => state.sessionOpen);
  const formFactor = useFormFactor();
  const docked = useCanDock();

  if (docked) {
    return (
      open && (
        <aside
          aria-labelledby="session-title"
          className="flex w-80 shrink-0 flex-col border-rush border-l transition-[opacity,translate] duration-(--duration-panel-in) ease-spring starting:translate-x-(--panel-shift) starting:opacity-0"
        >
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
        </aside>
      )
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
      <DrawerContent data-session-sheet="">
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
      <span id={labelId} className="font-medium text-ink text-ui">
        {label}
      </span>
      {children(labelId)}
      {note && (
        <p
          key={typeof note === "string" ? note : undefined}
          className="text-pretty text-note text-reed transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
        >
          {note}
        </p>
      )}
    </div>
  );
}

const NO_CHARACTER = "none";

/** Who the chat is with. Switching starts a new chat, asking first if this one has content. */
function CharacterField() {
  const characters = useQuery(charactersQuery);
  const current = useChatCharacter();
  const { start, dialog } = useStartChat();
  const list = characters.data ?? [];

  return (
    <Field label="Character" note="Switching starts a new chat.">
      {(labelId) => (
        <>
          <Select
            value={current?.id ?? NO_CHARACTER}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              const next = list.find((character) => character.id === value);
              start(next?.id ?? null, next?.name ?? "");
            }}
          >
            <SelectTrigger
              aria-labelledby={labelId}
              placeholder="No character"
              className={LEAF_TRIGGER.trigger}
            >
              <span className="flex min-w-0 flex-1 items-center gap-3">
                {current && (
                  <PortraitLeaf
                    id={current.id}
                    name={current.name}
                    version={current.portrait}
                    className={LEAF_TRIGGER.leaf}
                  />
                )}
                <span className="truncate">{current?.name ?? "No character"}</span>
              </span>
            </SelectTrigger>
            <SelectContent label="Characters">
              <SelectItem value={NO_CHARACTER}>
                <span className="flex items-center gap-3">
                  <span aria-hidden="true" className="w-6 shrink-0" />
                  <span className="truncate">No character</span>
                </span>
              </SelectItem>
              {list.map((character) => (
                <SelectItem
                  key={character.id}
                  value={character.id}
                  label={character.name}
                  className="h-12 touch:h-14"
                >
                  <span className="flex items-center gap-3">
                    <PortraitLeaf
                      id={character.id}
                      name={character.name}
                      version={character.portrait}
                      className="w-6"
                    />
                    <span className="truncate">{character.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      {failed && (
        <p role="alert" className="text-ember text-note">
          Not changed: {notReachedText}.
        </p>
      )}
      {moved && (
        <p role="status" className="text-pretty text-note text-reed arrive">
          {moved}
        </p>
      )}
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
  const list = presets.data ?? [];
  return (
    <Field label={label} note={note}>
      {(labelId) => (
        <div className="flex items-center gap-1">
          <Select
            value={chosen?.id ?? null}
            items={Object.fromEntries(list.map((preset) => [preset.id, preset.name]))}
            onValueChange={(value) => {
              const preset = list.find((option) => option.id === value);
              if (preset) onChoose(preset);
            }}
          >
            <SelectTrigger aria-labelledby={labelId} placeholder={presetPlaceholder(presets)} />
            <SelectContent label={`${label}s`}>
              {list.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

/**
 * How replies are drawn. A preset that names a model switches the chat to it;
 * an effort the chat's model does not offer is not sent, and this says so.
 */
function SamplerPresetField() {
  const presets = useQuery(presetsQuery("sampler"));
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const model = useModelInfo(settings.model);
  const chosen = presets.data?.find((preset) => preset.id === settings.samplerPresetId);
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
      onChoose={(preset) =>
        updateSettings({
          samplerPresetId: preset.id,
          ...(preset.values.model === null ? {} : { model: preset.values.model }),
        })
      }
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
