import {
  blankCard,
  CARD_FIELD_LABELS,
  CARD_LIMITS,
  type CharacterCard,
  type CharacterNote,
  DEFAULT_CHARACTER_NOTE,
  type EditableFields,
  editableFieldsSchema,
  type Lorebook,
  lorebookSchema,
  type ReworkCard,
  type SheetFields,
  sheetFieldsSchema,
  type TextKey,
} from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useCanDock } from "@/app/form-factor.ts";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { ChatIcon, SectionsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { depthText, ROLE_NAMES } from "@/lib/roles";
import { isNotFound } from "../api.ts";
import { CastSection } from "../cast/CastSection.tsx";
import { useStartChat } from "../chat/StartChat.tsx";
import { LorebookSection } from "../lorebook/SheetSection.tsx";
import { MemorySection } from "../memory/MemorySection.tsx";
import { personasQuery } from "../personas/queries.ts";
import { PortraitField } from "../portraits/PortraitField.tsx";
import { Dock } from "../rework/Dock.tsx";
import { LorebookReview } from "../rework/LorebookReview.tsx";
import { ReviewField } from "../rework/ReviewField.tsx";
import { ReworkButton } from "../rework/ReworkButton.tsx";
import { reworkStore, useReworkLocked } from "../rework/session.ts";
import { isLocked } from "../rework/store.ts";
import { applySettings, currentSettings, useSettings } from "../settings/settings.ts";
import { useAutosave } from "../sheet/autosave.ts";
import { ConflictNotice, useReload } from "../sheet/ConflictNotice.tsx";
import { FIELD, HELP, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
import { DepthField, RoleField } from "../sheet/RoleFields.tsx";
import { SheetActions } from "../sheet/SheetActions.tsx";
import {
  NameField,
  SHEET_FRAME,
  SheetBody,
  SheetHeader,
  SheetLoading,
  SheetMissing,
  SheetNotice,
  useCreated,
  useLeaveGuard,
  useSheetState,
} from "../sheet/SheetFrame.tsx";
import { NewArtButton } from "../sheet-art/NewArtButton.tsx";
import { sheetArtStore, useSheetArt } from "../sheet-art/session.ts";
import type { SheetArtCard } from "../sheet-art/store.ts";
import { Greetings } from "./Greetings.tsx";
import { setOpened } from "./gallery-state.ts";
import {
  characterQuery,
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  refreshCharacters,
  saveCharacter,
  updateCachedCharacter,
} from "./queries.ts";
import { TagsField } from "./TagsField.tsx";

const BACK = { to: "/characters", label: "Characters" } as const;

/**
 * What the sheet edits and saves: the card's editable fields, its Character's Note,
 * and its embedded lorebook, which an AI Rework can change and the lorebook
 * screen edits on its own.
 */
const sheetDraftSchema = sheetFieldsSchema.extend({ lorebook: lorebookSchema.nullable() });
type SheetDraft = SheetFields & { lorebook: Lorebook | null };

/** Fields the lorebook screen saves as well. */
const SHARED = ["lorebook"] as const;

const FIELD_LABELS: Record<keyof SheetDraft, string> = {
  ...CARD_FIELD_LABELS,
  lorebook: "Lorebook",
};

const SECTIONS = [
  ["identity", "Identity"],
  ["description", CARD_FIELD_LABELS.description],
  ["personality", CARD_FIELD_LABELS.personality],
  ["scenario", CARD_FIELD_LABELS.scenario],
  ["lorebook", "Lorebook"],
  ["memory", "Memory"],
  ["cast", "Cast"],
  ["greetings", "Greetings"],
  ["examples", CARD_FIELD_LABELS.exampleDialogue],
  ["prompts", "Prompts"],
  ["character-note", CARD_FIELD_LABELS.characterNote],
  ["notes", CARD_FIELD_LABELS.creatorNotes],
] as const;

/** The sheet's fields: the card's editable ones, its Character's Note, and its book. */
const editable = (card: CharacterCard): SheetDraft => {
  const keys = Object.keys(editableFieldsSchema.shape) as (keyof EditableFields)[];
  const fields = Object.fromEntries(keys.map((key) => [key, card[key]])) as EditableFields;
  return {
    ...fields,
    characterNote: card.characterNote ?? null,
    lorebook: card.lorebook ?? null,
  };
};

/** What an AI Rework reads and changes of the sheet, as it stands; values pass through unchanged. */
const reworkCardOf = (fields: SheetDraft): ReworkCard => ({
  name: fields.name,
  description: fields.description,
  personality: fields.personality,
  scenario: fields.scenario,
  firstMessage: fields.firstMessage,
  alternateGreetings: fields.alternateGreetings,
  exampleDialogue: fields.exampleDialogue,
  systemPrompt: fields.systemPrompt,
  postHistoryInstructions: fields.postHistoryInstructions,
  creatorNotes: fields.creatorNotes,
  tags: fields.tags,
  characterNote: fields.characterNote ?? null,
  lorebook: fields.lorebook,
});

/** `/characters/$id`, where the id "new" opens an empty sheet. */
export function SheetScreen({ id }: { id: string }) {
  const { fresh, onCreated, forget } = useCreated(id);
  // Always refetch on arrival and wait for it: the editor seeds its fields once, so it
  // must not start from a cached copy that another tab or device has since changed.
  const query = useQuery({ ...characterQuery(id), enabled: !fresh, refetchOnMount: "always" });
  // Reload also leaves a just-created sheet for the saved entity it fetched.
  const [round, reload] = useReload(() => query.refetch(), forget);
  const state = useSheetState(id, query);
  if (fresh) {
    return (
      <SheetEditor
        key="new"
        initialId={null}
        card={blankCard("")}
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
        noun="character"
        notFound={isNotFound(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (state === "loading" || query.data === undefined) return <SheetLoading />;
  return (
    <SheetEditor
      key={`${id}:${round}`}
      initialId={id}
      card={query.data.card}
      portrait={query.data.portrait}
      revision={query.data.revision}
      onReload={reload}
    />
  );
}

function SheetEditor({
  initialId,
  card,
  portrait: initialPortrait,
  revision,
  onCreated,
  onReload,
}: {
  initialId: string | null;
  card: CharacterCard;
  portrait: number | null;
  /** The loaded character's revision; 0 for a new one. */
  revision: number;
  onCreated?: (id: string) => void;
  /** Fetches the saved character and reopens the sheet on it (a conflict's Reload). */
  onReload: () => Promise<void>;
}) {
  const wide = useCanDock();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id, setId] = useState(initialId);
  const [fields, setFields] = useState(() => editable(card));
  const { preferCharacterPrompt, preferCharacterInstructions } = useSettings();
  const [portrait, setPortraitVersion] = useState(initialPortrait);
  const creating = id === null;
  const leaving = useRef(false);
  /** A failed sheet action (duplicate, delete), said once in words. */
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useReworkLocked();
  /** New art saves its pick (uploading, or waiting for the sign-in to send it again). */
  const artSaving = useSheetArt(
    (state) => state.useRun?.status === "saving" || state.useRun?.status === "waiting",
  );
  /** The portrait waits: an AI Rework works or is under review, or New art saves its pick. */
  const held = artSaving || locked;
  /** The portrait field uploads or removes; it owns the state and reports it here. */
  const [portraitBusy, setPortraitBusy] = useState(false);
  /**
   * An AI Rework waits for a portrait change under way: it would read the
   * portrait as it was, and the change would land under its review.
   */
  const portraitChanging = portraitBusy || artSaving;
  /** A portrait New art saved, which surfaces out of blur once. */
  const [arrivedPortrait, setArrivedPortrait] = useState<number | null>(null);
  /** The card as New art reads it when a run or a save starts, kept current with the sheet. */
  const artCardRef = useRef<SheetArtCard>({ fields, portrait });
  useLayoutEffect(() => {
    artCardRef.current = { fields, portrait };
  });
  /** Whether the AI Rework composer is open; the dock reopens it. */
  const [composing, setComposing] = useState(false);
  const reworkButton = useRef<HTMLButtonElement>(null);

  const autosave = useAutosave({
    id,
    revision,
    fields,
    schema: sheetDraftSchema,
    labels: FIELD_LABELS,
    wholeLabel: "The card",
    // The lorebook screen edits the book too: Keep mine sends it only when this sheet changed it.
    shared: SHARED,
    // A new sheet has no book, and the create route takes the sheet's fields alone.
    create: (created, { lorebook: _book, ...sheet }) => createCharacter(created, sheet),
    save: saveCharacter,
    onCreated: (created) => {
      onCreated?.(created);
      setId(created);
      setOpened(created);
      void refreshCharacters(queryClient);
      // While a navigation away waits for this save, the URL is left to it.
      if (!leaving.current) {
        void navigate({ to: "/characters/$id", params: { id: created }, replace: true });
      }
    },
    onSaved: (saved, character) => updateCachedCharacter(queryClient, saved, character),
  });

  /**
   * The sheet's fields for a rework about to start. A book this sheet has not
   * changed is taken from the latest saved copy first (another tab's or
   * screen's save may have reached the cache since the sheet opened), so the
   * rework and its Apply build on the newest book.
   */
  const reworkCard = (): ReworkCard => {
    let book = fields.lorebook;
    const saved = id === null ? undefined : queryClient.getQueryData(characterQuery(id).queryKey);
    if (saved !== undefined && !autosave.isUnsaved("lorebook")) {
      const latest = saved.card.lorebook ?? null;
      if (latest !== book && autosave.adopt({ lorebook: latest }, saved.revision)) {
        book = latest;
        setFields((current) => ({ ...current, lorebook: latest }));
      }
    }
    return reworkCardOf({ ...fields, lorebook: book });
  };

  /** The one way fields change; none do while an AI Rework works or its changes are under review. */
  const edit = (change: Partial<SheetDraft>) => {
    if (isLocked(reworkStore.getState())) return;
    setFields((current) => ({ ...current, ...change }));
    autosave.touch(...(Object.keys(change) as (keyof SheetDraft)[]));
  };

  /** Apply: the accepted changes, written as one edit through the autosave. */
  const applyRework = () => {
    const result = reworkStore.getState().apply();
    if (result !== null) edit(result.next);
  };
  /** Undo: the fields Apply wrote back as they were, but those typed in since. */
  const undoRework = () => {
    const restore = reworkStore.getState().undo(reworkCardOf(fields));
    if (Object.keys(restore).length > 0) edit(restore);
  };

  // The rework session belongs to this character's sheet; leaving the sheet empties it.
  useEffect(() => {
    if (id !== null) reworkStore.getState().open(id);
  }, [id]);
  // New art's session too: its candidates are drafts of this sheet.
  useEffect(
    () => () => {
      reworkStore.getState().clear();
      sheetArtStore.getState().clear();
    },
    [],
  );

  /** The one owner of a portrait change: the sheet's version, the cached character and the gallery. */
  const portraitChanged = (version: number | null) => {
    setPortraitVersion(version);
    if (id === null) return;
    updateCachedCharacter(queryClient, id, { portrait: version });
    void refreshCharacters(queryClient);
  };

  const leaveGuard = useLeaveGuard(
    autosave,
    (value) => {
      leaving.current = value;
    },
    creating,
    "character",
  );

  useEffect(
    () => () => {
      // A sheet left by any route keeps the gallery's list fresh.
      void refreshCharacters(queryClient);
    },
    [queryClient],
  );

  const text = (
    section: string,
    key: keyof EditableFields & TextKey,
    help?: ReactNode,
    mono?: boolean,
  ) => (
    <section id={`s-${section}`} className={SHEET_GRID}>
      <label htmlFor={`field-${key}`} className={sheetLabel()}>
        {CARD_FIELD_LABELS[key]}
      </label>
      <div className="grid gap-2">
        <ReviewField
          field={{ kind: "text", key }}
          label={CARD_FIELD_LABELS[key]}
          face={mono ? "mono" : "turn"}
        >
          <textarea
            id={`field-${key}`}
            value={String(fields[key])}
            maxLength={CARD_LIMITS.textLength}
            readOnly={locked}
            aria-readonly={locked || undefined}
            onChange={(event) => edit({ [key]: event.target.value })}
            className={cn(FIELD, mono && "font-mono text-note")}
          />
        </ReviewField>
        {help && <p className={HELP}>{help}</p>}
      </div>
    </section>
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <SheetHeader
        back={BACK}
        title={fields.name.trim() || "New character"}
        status={autosave.status}
        creating={creating}
        noun="character"
        frame={wide ? SHEET_FRAME.indexed : SHEET_FRAME.form}
      >
        {!wide && <SectionsMenu />}
        <ChatButton id={id} name={fields.name} flush={autosave.flush} locked={locked} />
        <ReworkButton
          id={id}
          portrait={portrait}
          portraitChanging={portraitChanging}
          card={reworkCard}
          open={composing}
          onOpenChange={setComposing}
          trigger={reworkButton}
        />
        {id !== null && (
          <MoreActions
            id={id}
            name={fields.name}
            flush={autosave.flush}
            discard={autosave.discard}
            onError={setNotice}
            locked={locked}
          />
        )}
      </SheetHeader>

      <SheetBody
        label="Character sheet"
        after={
          autosave.status.kind === "conflict" && (
            <ConflictNotice
              noun="character"
              onReload={onReload}
              onKeepMine={autosave.keepMine}
              reviewing={locked}
            />
          )
        }
        onBlur={() => {
          if (autosave.hasUnsaved()) void autosave.flush();
        }}
        aside={wide && <SheetIndex count={fields.alternateGreetings.length + 1} />}
      >
        {notice && <SheetNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <section
          id="s-identity"
          aria-label="Identity"
          className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 tablet:grid-cols-[7rem_minmax(0,40rem)] tablet:gap-x-6"
        >
          {/* From tablet the portrait spans the identity and its details beside it. */}
          <div className="tablet:row-span-2">
            <PortraitField
              owner="characters"
              noun="character"
              id={id}
              version={portrait}
              locked={held}
              arrived={arrivedPortrait}
              onBusyChange={setPortraitBusy}
              onChange={portraitChanged}
              primary={
                id === null
                  ? undefined
                  : ({ busy }) => (
                      <NewArtButton
                        characterId={id}
                        name={fields.name.trim() || "this character"}
                        portrait={portrait}
                        card={() => artCardRef.current}
                        onPortrait={(version) => {
                          setArrivedPortrait(version);
                          portraitChanged(version);
                        }}
                        held={held}
                        disabled={held || busy}
                        onOpen={() => setComposing(false)}
                      />
                    )
              }
            />
          </div>
          <div className="grid content-start gap-4">
            <ReviewField
              field={{ kind: "text", key: "name" }}
              label={CARD_FIELD_LABELS.name}
              face="title"
              framed={false}
            >
              <NameField
                value={fields.name}
                maxLength={CARD_LIMITS.nameLength}
                readOnly={locked}
                onChange={(name) => edit({ name })}
              />
            </ReviewField>
            <TagsField tags={fields.tags} onChange={(tags) => edit({ tags })} />
          </div>
          <CardDetails fields={fields} edit={edit} locked={locked} />
        </section>

        {text("description", "description", <>Who {"{{char}}"} is.</>)}
        {text("personality", "personality")}
        {text("scenario", "scenario")}

        <LorebookSection
          id={id}
          name={fields.name.trim() || "this character"}
          book={fields.lorebook ?? undefined}
          review={<LorebookReview />}
        />

        <MemorySection id={id} name={fields.name.trim() || "this character"} />

        <CastSection id={id} name={fields.name.trim() || "this character"} />

        <Greetings
          first={fields.firstMessage}
          alternates={fields.alternateGreetings}
          onChange={(change) => edit(change)}
        />

        {text(
          "examples",
          "exampleDialogue",
          <>
            Example dialogue. Separate passages with --- on its own line, with a blank line on
            either side.
          </>,
          true,
        )}

        <section id="s-prompts" className={SHEET_GRID}>
          <h2 className={sheetLabel("line")}>Prompts</h2>
          <div className="grid gap-5">
            <PromptField
              field="systemPrompt"
              value={fields.systemPrompt}
              placeholder="The preset's main prompt"
              locked={locked}
              help={
                preferCharacterPrompt ? (
                  <>Replaces the preset's main prompt. Write {"{{original}}"} to include it.</>
                ) : (
                  "Not used: Settings prefers the preset's main prompt."
                )
              }
              onChange={(systemPrompt) => edit({ systemPrompt })}
            />
            <PromptField
              field="postHistoryInstructions"
              value={fields.postHistoryInstructions}
              placeholder="The preset's instructions"
              locked={locked}
              help={
                preferCharacterInstructions ? (
                  <>
                    Replaces the preset's post-history instructions. Write {"{{original}}"} to
                    include them.
                  </>
                ) : (
                  "Not used: Settings prefers the preset's post-history instructions."
                )
              }
              onChange={(postHistoryInstructions) => edit({ postHistoryInstructions })}
            />
          </div>
        </section>

        <CharactersNote
          name={fields.name.trim() || "this character"}
          note={fields.characterNote ?? null}
          locked={locked}
          onChange={(characterNote) => edit({ characterNote })}
        />

        {text("notes", "creatorNotes", "For you, never sent in chats.")}
      </SheetBody>
      <Dock
        card={reworkCardOf(fields)}
        save={autosave.status}
        onApply={applyRework}
        onUndo={undoRework}
        onCompose={() => setComposing(true)}
        returnFocus={reworkButton}
      />
      {leaveGuard}
    </main>
  );
}

type Edit = (change: Partial<SheetDraft>) => void;

function SmallField({
  label,
  value,
  placeholder,
  locked,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-note text-reed">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        maxLength={CARD_LIMITS.shortTextLength}
        readOnly={locked}
        aria-readonly={locked || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD, "h-9 py-0 text-ui touch:h-11")}
      />
    </label>
  );
}

function SmallFields({
  fields,
  edit,
  locked,
}: {
  fields: EditableFields;
  edit: Edit;
  locked: boolean;
}) {
  return (
    <>
      <SmallField
        label="Nickname"
        value={fields.nickname}
        placeholder="Optional"
        locked={locked}
        onChange={(nickname) => edit({ nickname })}
      />
      <SmallField
        label="Creator"
        value={fields.creator}
        locked={locked}
        onChange={(creator) => edit({ creator })}
      />
      <SmallField
        label="Version"
        value={fields.characterVersion}
        locked={locked}
        onChange={(characterVersion) => edit({ characterVersion })}
      />
    </>
  );
}

/**
 * The card's optional details (Nickname, Creator, Version) under one
 * disclosure after the identity, so the portrait, name and tags lead; its
 * summary says what is set. On phones it spans the identity's width.
 */
function CardDetails({
  fields,
  edit,
  locked,
}: {
  fields: EditableFields;
  edit: Edit;
  locked: boolean;
}) {
  const set = [fields.creator, fields.characterVersion && `version ${fields.characterVersion}`]
    .filter(Boolean)
    .join(", ");
  return (
    <details className="disclosure col-span-2 border-rush border-y tablet:col-start-2 tablet:col-span-1">
      <summary className="flex h-12 cursor-pointer list-none items-center gap-2 text-ink text-ui">
        <span>Card details</span>
        <DisclosureChevron className="text-reed" />
        <span className="min-w-0 flex-1 truncate pl-1 text-meta text-reed">{set}</span>
      </summary>
      <div className="grid gap-3 pb-4 tablet:grid-cols-3">
        <SmallFields fields={fields} edit={edit} locked={locked} />
      </div>
    </details>
  );
}

function PromptField({
  field,
  value,
  placeholder,
  help,
  locked,
  onChange,
}: {
  field: "systemPrompt" | "postHistoryInstructions";
  value: string;
  placeholder: string;
  help: ReactNode;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="font-medium text-ink text-ui">
        {CARD_FIELD_LABELS[field]}
      </label>
      <ReviewField field={{ kind: "text", key: field }} label={CARD_FIELD_LABELS[field]}>
        <textarea
          id={id}
          value={value}
          placeholder={placeholder}
          maxLength={CARD_LIMITS.textLength}
          readOnly={locked}
          aria-readonly={locked || undefined}
          onChange={(event) => onChange(event.target.value)}
          className={FIELD}
        />
      </ReviewField>
      <p className={HELP}>{help}</p>
    </div>
  );
}

function ChatButton({
  id,
  name,
  flush,
  locked,
}: {
  id: string | null;
  name: string;
  flush: () => Promise<boolean>;
  /** A chat would start from the card while an AI Rework holds it. */
  locked: boolean;
}) {
  const { start, dialog } = useStartChat();
  return (
    <>
      <Button
        variant="outline"
        disabled={id === null || locked}
        onClick={async () => {
          if (id === null) return;
          await flush();
          start(id, name.trim());
        }}
      >
        <ChatIcon size={16} />
        Chat
      </Button>
      {dialog}
    </>
  );
}

/** Duplicate, export and delete, on the shared sheet actions. */
function MoreActions({
  id,
  name,
  flush,
  discard,
  onError,
  locked,
}: {
  id: string;
  name: string;
  flush: () => Promise<boolean>;
  discard: () => void;
  onError: (message: string) => void;
  /** Duplicate and Delete wait while an AI Rework holds the sheet; Export stays. */
  locked: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const duplicate = {
    copy: () => duplicateCharacter(id),
    open: async (copy: string) => {
      await refreshCharacters(queryClient);
      setOpened(copy);
      void navigate({ to: "/characters/$id", params: { id: copy } });
    },
  };

  const remove = async () => {
    if (!(await deleteCharacter(id))) return false;
    discard();
    // The server forgot it as the chosen character and unbound its persona; so does this tab.
    if (currentSettings().characterId === id) applySettings({ characterId: null });
    queryClient.removeQueries({ queryKey: characterQuery(id).queryKey });
    await Promise.all([
      refreshCharacters(queryClient),
      // Every cached persona, not only the list: the tab cannot tell which one was unbound.
      queryClient.invalidateQueries({ queryKey: personasQuery.queryKey }),
    ]);
    setOpened(null);
    void navigate({ to: "/characters" });
    return true;
  };

  return (
    <SheetActions
      name={name}
      label="Character actions"
      flush={flush}
      onError={onError}
      duplicate={duplicate}
      exports={[
        { label: "Export as PNG", file: { kind: "character", id, format: "png" } },
        { label: "Export as JSON", file: { kind: "character", id, format: "json" } },
      ]}
      deleteTitle={`Delete ${name.trim() || "this character"}?`}
      deleteDescription="The card and its portrait are removed from Ephemera. Export first to keep a copy."
      onDelete={remove}
      locked={locked}
    />
  );
}

/**
 * Moves to a section and puts focus in its first field, which it returns; a
 * field under review is its tracked view, which takes focus without the
 * phone keyboard.
 */
function goToSection(key: string): HTMLElement | null {
  const section = document.getElementById(`s-${key}`);
  if (section === null) return null;
  section.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  const field = section.querySelector<HTMLElement>("[data-tracked], textarea, input");
  field?.focus({ preventScroll: true });
  return field;
}

function SectionsMenu() {
  // The menu returns focus when it closes: to the chosen section's field, not the trigger.
  const chosen = useRef<HTMLElement | null>(null);
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon" aria-label="Go to section" />}>
        <SectionsIcon />
      </MenuTrigger>
      <MenuContent
        label="Sections"
        finalFocus={() => {
          const field = chosen.current;
          chosen.current = null;
          field?.focus({ preventScroll: true });
          return field === null;
        }}
      >
        {SECTIONS.map(([key, label]) => (
          <MenuItem
            key={key}
            onClick={() => {
              chosen.current = goToSection(key);
            }}
          >
            {label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Desktop from 1360px: the sheet's contents, with the section in view marked. */
function SheetIndex({ count }: { count: number }) {
  const [current, setCurrent] = useState<string>("identity");
  useEffect(() => {
    // A callback reports only the sections whose state changed, so the band's
    // contents are kept across callbacks.
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = entry.target.id.slice(2);
          if (entry.isIntersecting) inBand.add(key);
          else inBand.delete(key);
        }
        // While a field is being edited on screen, its section stays marked.
        const editing = document.activeElement?.closest('section[id^="s-"]');
        if (editing != null) {
          const { top, bottom } = editing.getBoundingClientRect();
          if (bottom > 0 && top < window.innerHeight) return setCurrent(editing.id.slice(2));
        }
        // Else the section that starts at or above the band's top edge, or the first one in it.
        const edge = window.innerHeight * 0.1;
        const keys = SECTIONS.map(([key]) => key).filter((key) => inBand.has(key));
        const started = keys.filter(
          (key) => (document.getElementById(`s-${key}`)?.getBoundingClientRect().top ?? 0) <= edge,
        );
        const chosen = started.at(-1) ?? keys[0];
        if (chosen !== undefined) setCurrent(chosen);
      },
      { rootMargin: "-10% 0px -60% 0px" },
    );
    for (const [key] of SECTIONS) {
      const section = document.getElementById(`s-${key}`);
      if (section) observer.observe(section);
    }
    // Editing a field marks its section, wherever the band is.
    const onFocus = (event: FocusEvent) => {
      const section =
        event.target instanceof Element ? event.target.closest('section[id^="s-"]') : null;
      if (section !== null) setCurrent(section.id.slice(2));
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
  return (
    <nav
      aria-label="On this sheet"
      className="sticky top-8 hidden h-fit w-index shrink-0 desktop:block"
    >
      <ul className="grid border-rush border-l">
        {SECTIONS.map(([key, label]) => (
          <li key={key}>
            <a
              href={`#s-${key}`}
              aria-current={current === key ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                goToSection(key);
              }}
              className="-ml-px block border-transparent border-l-2 py-1.5 pl-4 text-note text-reed transition-colors duration-(--duration-tint) hover:text-ink aria-[current=location]:border-ink aria-[current=location]:text-ink"
            >
              {label}
              {key === "greetings" && (
                <span className="ml-1.5 text-meta text-reed tabular-nums">{count}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The Character's Note: text sent
 * inside every chat with the character, at its depth and role. Saved in the
 * typed character field, included in its native export.
 */
function CharactersNote({
  name,
  note,
  locked,
  onChange,
}: {
  name: string;
  note: CharacterNote | null;
  locked: boolean;
  onChange: (note: CharacterNote) => void;
}) {
  const textId = useId();
  const statusId = useId();
  const helpId = useId();
  const value = note ?? DEFAULT_CHARACTER_NOTE;
  const sent = value.prompt.trim() !== "";
  const role = ROLE_NAMES[value.role].toLowerCase();
  return (
    <section id="s-character-note" className={SHEET_GRID} aria-labelledby="sheet-character-note">
      <h2 id="sheet-character-note" className={sheetLabel()}>
        {CARD_FIELD_LABELS.characterNote}
      </h2>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor={textId} className="sr-only">
            {CARD_FIELD_LABELS.characterNote}
          </label>
          <ReviewField
            field={{ kind: "text", key: "characterNote" }}
            label={CARD_FIELD_LABELS.characterNote}
          >
            <textarea
              id={textId}
              value={value.prompt}
              rows={2}
              autoComplete="off"
              placeholder="For example: {{char}} never raises their voice."
              aria-describedby={`${statusId} ${helpId}`}
              readOnly={locked}
              aria-readonly={locked || undefined}
              onChange={(event) => onChange({ ...value, prompt: event.target.value })}
              className={FIELD}
            />
          </ReviewField>
          <p className={HELP}>
            <span id={statusId}>
              {sent
                ? `Sent in every chat with ${name}, ${depthText(value.depth)}, as ${role === "assistant" ? "an" : "a"} ${role} message.`
                : "Empty, nothing is sent."}
            </span>{" "}
            <span id={helpId}>
              No chat can change it. Saved with the character; the prompt preset's Author's Note is
              separate.
            </span>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 tablet:grid-cols-4">
          <DepthField
            value={value.depth}
            readOnly={locked}
            onChange={(depth) => onChange({ ...value, depth })}
          />
          <RoleField
            value={value.role}
            readOnly={locked}
            onChange={(role) => onChange({ ...value, role })}
          />
        </div>
      </div>
    </section>
  );
}
