import {
  CARD_LIMITS,
  type CharacterSummary,
  type PersonaFields,
  type PersonaSummary,
  personaFieldsSchema,
} from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isNotFound } from "../api.ts";
import { charactersQuery } from "../characters/queries.ts";
import { PortraitLeaf } from "../portraits/Portrait.tsx";
import { PortraitField } from "../portraits/PortraitField.tsx";
import {
  applySettings,
  currentSettings,
  useSetting,
  useUpdateSettings,
} from "../settings/settings.ts";
import { useAutosave } from "../sheet/autosave.ts";
import { ConflictNotice, useReload } from "../sheet/ConflictNotice.tsx";
import { FIELD, SHEET_GRID } from "../sheet/fields.ts";
import { SheetActions } from "../sheet/SheetActions.tsx";
import {
  NameField,
  SheetBody,
  SheetHeader,
  SheetLoading,
  SheetMissing,
  SheetNotice,
  useCreated,
  useLeaveGuard,
  useSheetState,
} from "../sheet/SheetFrame.tsx";
import { useNotReached } from "../signin/hooks.ts";
import { BindingPicker } from "./BindingPicker.tsx";
import { setOpenedPersona } from "./Gallery.tsx";
import {
  bindCharacter,
  createPersona,
  deletePersona,
  duplicatePersona,
  personaQuery,
  personasQuery,
  refreshPersonas,
  savePersona,
} from "./queries.ts";

const BACK = { to: "/personas", label: "Personas" } as const;
const LABELS: Record<keyof PersonaFields, string> = { name: "Name", description: "Description" };
const LABEL =
  "mb-2 block font-semibold text-ink text-ui tablet:mb-0 tablet:pt-2.5 tablet:text-right";
const HELP = "text-pretty text-note text-reed";

/** `/personas/$id`, where the id "new" opens an empty sheet. */
export function PersonaSheetScreen({ id }: { id: string }) {
  const { fresh, onCreated, forget } = useCreated(id);
  // Always refetch on arrival and wait for it: the editor seeds its fields once.
  const query = useQuery({ ...personaQuery(id), enabled: !fresh, refetchOnMount: "always" });
  // Reload also leaves a just-created sheet for the saved entity it fetched.
  const [round, reload] = useReload(() => query.refetch(), forget);
  const state = useSheetState(id, query);
  if (fresh) {
    return (
      <PersonaEditor
        key="new"
        initialId={null}
        fields={{ name: "", description: "" }}
        portrait={null}
        revision={0}
        onCreated={onCreated}
        onReload={reload}
      />
    );
  }
  if (state === "error") {
    return (
      <SheetMissing
        back={BACK}
        noun="persona"
        notFound={isNotFound(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (state === "loading" || query.data === undefined) return <SheetLoading />;
  const { name, description, portrait, revision } = query.data;
  return (
    <PersonaEditor
      key={`${id}:${round}`}
      initialId={id}
      fields={{ name, description }}
      portrait={portrait}
      revision={revision}
      onReload={reload}
    />
  );
}

function PersonaEditor({
  initialId,
  fields: initialFields,
  portrait: initialPortrait,
  revision,
  onCreated,
  onReload,
}: {
  initialId: string | null;
  fields: PersonaFields;
  portrait: number | null;
  /** The loaded persona's revision; 0 for a new one. */
  revision: number;
  onCreated?: (id: string) => void;
  /** Fetches the saved persona and reopens the sheet on it (a conflict's Reload). */
  onReload: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id, setId] = useState(initialId);
  const [fields, setFields] = useState(initialFields);
  const [portrait, setPortraitVersion] = useState(initialPortrait);
  const [notice, setNotice] = useState<string | null>(null);
  const creating = id === null;
  const leaving = useRef(false);

  const autosave = useAutosave({
    id,
    revision,
    fields,
    schema: personaFieldsSchema,
    labels: LABELS,
    wholeLabel: "The persona",
    create: createPersona,
    save: savePersona,
    onCreated: (created) => {
      onCreated?.(created);
      setId(created);
      setOpenedPersona(created);
      void refreshPersonas(queryClient);
      // While a navigation away waits for this save, the URL is left to it.
      if (!leaving.current) {
        void navigate({ to: "/personas/$id", params: { id: created }, replace: true });
      }
    },
    onSaved: (saved, persona) => queryClient.setQueryData(personaQuery(saved).queryKey, persona),
  });

  const edit = (change: Partial<PersonaFields>) => {
    setFields((current) => ({ ...current, ...change }));
    autosave.touch(...(Object.keys(change) as (keyof PersonaFields)[]));
  };

  const leaveGuard = useLeaveGuard(
    autosave,
    (value) => {
      leaving.current = value;
    },
    creating,
    "persona",
  );

  useEffect(
    () => () => {
      // A sheet left by any route keeps the gallery's list fresh.
      void refreshPersonas(queryClient);
    },
    [queryClient],
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <SheetHeader
        back={BACK}
        title={fields.name.trim() || "New persona"}
        status={autosave.status}
        creating={creating}
        noun="persona"
      >
        {id !== null && (
          <PersonaActions
            id={id}
            name={fields.name}
            flush={autosave.flush}
            discard={autosave.discard}
            onError={setNotice}
          />
        )}
      </SheetHeader>

      <SheetBody
        label="Persona sheet"
        after={
          autosave.status.kind === "conflict" && (
            <ConflictNotice noun="persona" onReload={onReload} onKeepMine={autosave.keepMine} />
          )
        }
        onBlur={() => {
          if (autosave.hasUnsaved()) void autosave.flush();
        }}
      >
        {notice && <SheetNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <section
          aria-label="Identity"
          className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 tablet:grid-cols-[7rem_minmax(0,40rem)] tablet:gap-x-6"
        >
          <PortraitField
            owner="personas"
            noun="persona"
            id={id}
            version={portrait}
            onChange={(version) => {
              setPortraitVersion(version);
              if (id !== null) void refreshPersonas(queryClient, id);
            }}
          />
          <div className="grid content-start gap-5">
            <NameField
              value={fields.name}
              maxLength={CARD_LIMITS.nameLength}
              onChange={(name) => edit({ name })}
            />
            {id !== null && <DefaultSwitch id={id} name={fields.name} />}
          </div>
        </section>

        <section className={SHEET_GRID}>
          <label htmlFor="persona-description" className={LABEL}>
            Description
          </label>
          <div className="grid gap-2">
            <textarea
              id="persona-description"
              value={fields.description}
              maxLength={CARD_LIMITS.textLength}
              onChange={(event) => edit({ description: event.target.value })}
              className={FIELD}
            />
            <p className={HELP}>
              Who {"{{user}}"} is in the story. Sent at the persona description's place in the
              prompt preset while you chat as this persona.
            </p>
          </div>
        </section>

        {id !== null && <GoesWith id={id} />}
      </SheetBody>
      {leaveGuard}
    </main>
  );
}

/** A status line with Undo, as the sheet's removal notes are. */
function UndoLine({ children, onUndo }: { children: ReactNode; onUndo: () => void }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 text-note text-reed arrive">
      {children}
      <Button className="h-8 px-2 text-ink text-note touch:h-11" onClick={onUndo}>
        Undo
      </Button>
    </p>
  );
}

/** The default persona is a setting; turning it on here replaces the previous default. */
function DefaultSwitch({ id, name }: { id: string; name: string }) {
  const phone = useFormFactor() === "phone";
  const defaultPersonaId = useSetting((settings) => settings.defaultPersonaId);
  const updateSettings = useUpdateSettings();
  const personas = useQuery(personasQuery);
  const [replaced, setReplaced] = useState<PersonaSummary | null>(null);
  const hintId = useId();
  return (
    <div className="grid gap-2">
      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          className="mt-0.5"
          aria-describedby={hintId}
          checked={defaultPersonaId === id}
          onCheckedChange={(checked) => {
            const previous = personas.data?.find(
              (persona) => persona.id === defaultPersonaId && persona.id !== id,
            );
            setReplaced(checked ? (previous ?? null) : null);
            updateSettings({ defaultPersonaId: checked ? id : null });
          }}
        />
        <span className="grid gap-0.5">
          <span className="font-medium text-ink text-ui">Default persona</span>
          <span id={hintId} className={HELP}>
            New chats start as {phone || name.trim() === "" ? "this persona" : name.trim()}, unless
            the character goes with another.
          </span>
        </span>
      </label>
      {replaced && (
        <UndoLine
          onUndo={() => {
            updateSettings({ defaultPersonaId: replaced.id });
            setReplaced(null);
          }}
        >
          {replaced.name} is no longer the default.
        </UndoLine>
      )}
    </div>
  );
}

/** The characters this persona goes with, from the live list, so Session's changes show here too. */
function GoesWith({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const personas = useQuery(personasQuery);
  const characters = useQuery(charactersQuery);
  const [moved, setMoved] = useState<{ character: CharacterSummary; from: PersonaSummary } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const notReachedText = useNotReached();
  const persona = personas.data?.find((option) => option.id === id);
  const all = characters.data ?? [];
  const bound = all.filter((character) => persona?.characterIds.includes(character.id));

  const bind = async (character: CharacterSummary, personaId: string | null) => {
    const ok = await bindCharacter(character.id, personaId);
    setFailed(!ok);
    await refreshPersonas(queryClient);
    return ok;
  };

  const toggle = async (character: CharacterSummary, checked: boolean) => {
    const holder = personas.data?.find(
      (other) => other.id !== id && other.characterIds.includes(character.id),
    );
    if ((await bind(character, checked ? id : null)) && checked && holder) {
      setMoved({ character, from: holder });
    } else setMoved(null);
  };

  return (
    <section className={SHEET_GRID} aria-labelledby="persona-goes-with">
      <h2 id="persona-goes-with" className={`${LABEL} tablet:pt-1.5`}>
        Goes with
      </h2>
      <div className="grid gap-3">
        <ul aria-label="Characters" className="flex flex-wrap gap-1.5">
          {bound.map((character) => (
            <li key={character.id} className="arrive">
              <span className="flex h-9 items-center gap-2 rounded-md bg-surface-selected pr-0.5 pl-1.5 text-ink text-ui touch:h-11">
                <PortraitLeaf
                  id={character.id}
                  name={character.name}
                  version={character.portrait}
                  className="w-4"
                />
                <span className="max-w-60 truncate">{character.name}</span>
                <button
                  type="button"
                  aria-label={`${character.name} no longer goes with ${persona?.name ?? "this persona"}`}
                  onClick={() => void toggle(character, false)}
                  className="press relative grid size-8 place-items-center rounded-sm text-reed after:absolute after:-inset-1.5 hover:bg-surface-pressed hover:text-ink touch:size-10"
                >
                  <CloseIcon size={16} />
                </button>
              </span>
            </li>
          ))}
          {persona && (
            <li>
              <BindingPicker
                persona={persona}
                characters={all}
                personas={personas.data ?? []}
                onToggle={(character, checked) => void toggle(character, checked)}
              />
            </li>
          )}
        </ul>
        {moved && (
          <UndoLine
            onUndo={() => {
              void bind(moved.character, moved.from.id);
              setMoved(null);
            }}
          >
            {moved.character.name} now goes with {persona?.name}, no longer with {moved.from.name}.
          </UndoLine>
        )}
        {failed && (
          <p role="alert" className="text-ember text-note">
            Not changed: {notReachedText}.
          </p>
        )}
        <p className={HELP}>
          Starting a chat with these characters switches to this persona. A character goes with one
          persona at most.
        </p>
      </div>
    </section>
  );
}

function PersonaActions({
  id,
  name,
  flush,
  discard,
  onError,
}: {
  id: string;
  name: string;
  flush: () => Promise<boolean>;
  discard: () => void;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const duplicate = {
    copy: () => duplicatePersona(id),
    open: async (copy: string) => {
      await refreshPersonas(queryClient);
      setOpenedPersona(copy);
      void navigate({ to: "/personas/$id", params: { id: copy } });
    },
  };

  const remove = async () => {
    if (!(await deletePersona(id))) return false;
    discard();
    // The server forgot it as the chosen and default persona; so does this tab.
    const { personaId, defaultPersonaId } = currentSettings();
    applySettings({
      ...(personaId === id ? { personaId: null } : {}),
      ...(defaultPersonaId === id ? { defaultPersonaId: null } : {}),
    });
    queryClient.removeQueries({ queryKey: personaQuery(id).queryKey });
    await refreshPersonas(queryClient);
    setOpenedPersona(null);
    void navigate({ to: "/personas" });
    return true;
  };

  return (
    <SheetActions
      name={name}
      label="Persona actions"
      flush={flush}
      onError={onError}
      duplicate={duplicate}
      deleteTitle={`Delete ${name.trim() || "this persona"}?`}
      deleteDescription="The persona and its portrait are removed from Ephemera. Lines already in this chat are cued as You."
      onDelete={remove}
    />
  );
}
