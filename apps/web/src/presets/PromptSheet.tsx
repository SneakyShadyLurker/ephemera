import {
  type AuthorsNote,
  BUILT_IN_NAMES,
  blockOrder,
  blockRole,
  clipText,
  GENERATION_TYPES,
  type GenerationType,
  isPlaceable,
  PRESET_LIMITS,
  type PromptActions,
  type PromptBlock,
  type PromptPreset,
  type PromptReasoning,
  type PromptRole,
  promptPresetSchema,
  reasoningTagSchema,
  sourceTemplateSchema,
} from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { m } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useCanDock, useFormFactor } from "@/app/form-factor.ts";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { ChatIcon, MoreIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Unfold } from "@/components/ui/disclosure";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Switch, SwitchField } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { depthText, ROLE_NAMES } from "@/lib/roles";
import { isNotFound } from "../api.ts";
import { useAutosave } from "../sheet/autosave.ts";
import { ConflictNotice, useReload } from "../sheet/ConflictNotice.tsx";
import { FIELD, HELP, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
import { CloseRow, Glides, MoveButtons, OpenRow, useGlide } from "../sheet/ordering.tsx";
import {
  NameField,
  SHEET_FRAME,
  SheetBody,
  SheetHeader,
  SheetLoading,
  SheetMissing,
  SheetNotice,
  useLeaveGuard,
  useSheetState,
} from "../sheet/SheetFrame.tsx";
import {
  addOptional,
  BLOCK_SOURCE,
  blockName,
  inChat,
  insertCustom,
  isInChat,
  missingOptional,
  moveBefore,
  moveInOrder,
  type Removed,
  removeBlock,
  restoreBlock,
  runningOrder,
  setOrder,
  setPlace,
  setTriggers,
  shiftDepth,
  updateBlock,
} from "./blocks.ts";
import { FormattingKey } from "./FormattingKey.tsx";
import { NoteEditor } from "./NoteEditor.tsx";
import { PRESETS_BACK, PresetActions } from "./PresetFrame.tsx";
import { presetArrivals, presetQuery, savePromptPreset } from "./queries.ts";

const LABEL = sheetLabel();

const ROLES = Object.entries(ROLE_NAMES) as [PromptRole, string][];

/** The actions a block can accompany. */
const TRIGGER_NAMES: Record<GenerationType, string> = {
  normal: "Send",
  regenerate: "Regenerate",
  swipe: "Swipe",
  continue: "Continue",
  impersonate: "Write for me",
  quiet: "Quiet",
};

function blockMeta(block: PromptBlock): string {
  const inside = isInChat(block) ? `, ${depthText(block.depth ?? 0)}` : "";
  if (block.kind === "source") {
    const source = BLOCK_SOURCE[block.id] ?? "";
    return `${inside === "" ? source : `${source}, as ${ROLE_NAMES[blockRole(block)]}${inside}`}${block.template ? ", in a template" : ""}`;
  }
  if (block.kind === "custom") return `${ROLE_NAMES[block.role]}${inside}`;
  if (block.kind === "text") {
    if (inside !== "") return `${ROLE_NAMES[blockRole(block)]}${inside}`;
    return block.content === "" ? "Empty" : block.content;
  }
  return "";
}

export function PromptPresetScreen({ id }: { id: string }) {
  const query = useQuery({ ...presetQuery("prompt", id), refetchOnMount: "always" });
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
  const { name, blocks, actions, reasoning, authorsNote, revision } = query.data;
  return (
    <PromptPresetEditor
      key={`${id}:${round}`}
      id={id}
      preset={{ name, blocks, actions, reasoning, authorsNote }}
      revision={revision}
      onReload={reload}
    />
  );
}

function PromptPresetEditor({
  id,
  preset,
  revision,
  onReload,
}: {
  id: string;
  preset: PromptPreset;
  revision: number;
  /** Fetches the saved preset and reopens the sheet on it (a conflict's Reload). */
  onReload: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const phone = useFormFactor() === "phone";
  // Wide enough for the formatting key beside the form, as the character sheet's index.
  const wide = useCanDock();
  const [fields, setFields] = useState(preset);
  const [open, setOpen] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectName] = useState(() => presetArrivals.take(id).selectName === true);
  const leaving = useRef(false);

  const autosave = useAutosave({
    id,
    revision,
    fields,
    schema: promptPresetSchema,
    labels: {
      name: "Name",
      blocks: "A block",
      actions: "An action instruction",
      reasoning: "Reasoning",
      authorsNote: "The Author's Note",
    },
    wholeLabel: "The preset",
    save: savePromptPreset,
    onSaved: (saved, stored) =>
      queryClient.setQueryData(presetQuery("prompt", saved).queryKey, stored),
  });
  const leaveGuard = useLeaveGuard(
    autosave,
    (value) => {
      leaving.current = value;
    },
    false,
    "prompt preset",
  );

  const setBlocks = (next: PromptBlock[]) => {
    setFields((current) => ({ ...current, blocks: next }));
    autosave.touch("blocks");
  };

  /** Keeps a moved row in view, focused if it lost focus, and says where it went. */
  const settle = (blockId: string, message: string) => {
    setAnnouncement(message);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
      row?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
      if (document.activeElement === document.body) {
        row?.querySelector<HTMLElement>("[aria-expanded]")?.focus({ preventScroll: true });
      }
    });
  };

  const rearrange = (next: PromptBlock[], blockId: string, message: string) => {
    setBlocks(next);
    settle(blockId, message);
  };

  const add = () => {
    const block: PromptBlock = {
      kind: "custom",
      id: crypto.randomUUID(),
      name: "New block",
      role: "system",
      content: "",
      enabled: true,
      depth: null,
    };
    const after =
      open !== null && !isInChat(fields.blocks.find((b) => b.id === open) ?? block) ? open : null;
    setBlocks(insertCustom(fields.blocks, block, after));
    setOpen(block.id);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLInputElement>(
          `[data-block="${CSS.escape(block.id)}"] input[name="block-name"]`,
        )
        ?.select(),
    );
  };

  const remove = (blockId: string) => {
    const result = removeBlock(fields.blocks, blockId);
    setRemoved(result.removed);
    setOpen(null);
    setBlocks(result.blocks);
  };

  const order = runningOrder(fields.blocks);
  const chat = inChat(fields.blocks);
  const customCount = fields.blocks.filter((block) => block.kind === "custom").length;
  const addButton = (
    <div className="flex shrink-0 flex-wrap gap-2">
      {missingOptional(fields.blocks).map((id) => (
        <Button
          key={id}
          onClick={() =>
            rearrange(addOptional(fields.blocks, id), id, `${BUILT_IN_NAMES[id]} added.`)
          }
          className="shrink-0"
        >
          <PlusIcon size={16} />
          Add {BUILT_IN_NAMES[id]} block
        </Button>
      ))}
      <Button
        onClick={add}
        disabled={customCount >= PRESET_LIMITS.customBlocks}
        className="shrink-0"
      >
        <PlusIcon size={16} />
        Add block
      </Button>
    </div>
  );

  const row = (
    block: PromptBlock,
    position: { first: boolean; last: boolean },
    inside: boolean,
  ) => (
    <BlockRow
      block={block}
      open={open === block.id}
      onOpen={(next) => setOpen(next ? block.id : null)}
      inside={inside}
      first={position.first}
      last={position.last}
      others={order.filter((other) => other.id !== block.id)}
      onChange={(change) => setBlocks(updateBlock(fields.blocks, block.id, change))}
      onMove={(step) =>
        rearrange(
          moveInOrder(fields.blocks, block.id, step),
          block.id,
          `${blockName(block)} moved ${step < 0 ? "earlier" : "later"}.`,
        )
      }
      onMoveBefore={(beforeId, beforeName) =>
        rearrange(
          moveBefore(fields.blocks, block.id, beforeId),
          block.id,
          `${blockName(block)} moved before ${beforeName}.`,
        )
      }
      onDepth={(delta) => {
        const next = shiftDepth(fields.blocks, block.id, delta);
        const depth = inChat(next).find((b) => b.id === block.id)?.depth ?? 0;
        rearrange(next, block.id, `${blockName(block)} is now ${depthText(depth)}.`);
      }}
      onPlace={(depth) =>
        rearrange(
          setPlace(fields.blocks, block.id, depth),
          block.id,
          depth !== null
            ? `${blockName(block)} is now inside the chat, ${depthText(depth)}.`
            : block.kind === "custom"
              ? `${blockName(block)} is back in the running order, above the chat history.`
              : `${blockName(block)} is back in the running order.`,
        )
      }
      onOrder={(order) =>
        rearrange(
          setOrder(fields.blocks, block.id, order),
          block.id,
          `${blockName(block)} now has order ${order}.`,
        )
      }
      onTriggers={(triggers) => setBlocks(setTriggers(fields.blocks, block.id, triggers))}
      canDuplicate={customCount < PRESET_LIMITS.customBlocks}
      onDuplicate={() => {
        if (block.kind !== "custom" || customCount >= PRESET_LIMITS.customBlocks) return;
        const copy: PromptBlock = {
          ...block,
          id: crypto.randomUUID(),
          name: clipText(`${block.name} (copy)`, PRESET_LIMITS.nameLength),
        };
        setBlocks(
          block.depth === null
            ? insertCustom(fields.blocks, copy, block.id)
            : [...fields.blocks, copy],
        );
        setOpen(copy.id);
      }}
      onRemove={() => remove(block.id)}
    />
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <SheetHeader
        back={PRESETS_BACK}
        title={fields.name.trim() || "Prompt preset"}
        status={autosave.status}
        creating={false}
        noun="prompt preset"
        frame={wide ? SHEET_FRAME.keyed : SHEET_FRAME.form}
      >
        <PresetActions
          kind="prompt"
          id={id}
          name={fields.name}
          flush={autosave.flush}
          discard={autosave.discard}
          onError={setNotice}
        />
      </SheetHeader>
      <SheetBody
        label="Prompt preset"
        aside={wide && <FormattingKey placement="aside" />}
        asideFrame="keyed"
        after={
          autosave.status.kind === "conflict" && (
            <ConflictNotice
              noun="prompt preset"
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
              Builds the prompt of every reply while this preset is in use.
            </p>
          </div>
        </section>
        <section className={SHEET_GRID} aria-labelledby="prompt-blocks">
          <h2 id="prompt-blocks" className={LABEL}>
            Blocks
          </h2>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            <div className="flex min-h-9 items-center justify-between gap-3">
              <p className={HELP}>Sent top to bottom. Switch a block off to leave it out.</p>
              {!phone && addButton}
            </div>
            <ol
              aria-label="Blocks in send order"
              className="grid grid-cols-[minmax(0,1fr)] border-rush border-t"
            >
              {order.map((block, index) =>
                block.kind === "chatHistory" ? (
                  <ChatHistoryBand
                    key={block.id}
                    enabled={block.enabled !== false}
                    onToggle={(enabled) =>
                      setBlocks(
                        updateBlock(fields.blocks, block.id, (current) =>
                          current.kind === "chatHistory" ? { ...current, enabled } : current,
                        ),
                      )
                    }
                  >
                    {chat.map((inside, at) => (
                      <li key={inside.id} className="border-rush border-b last:border-b-0">
                        {row(
                          inside,
                          { first: false, last: at === chat.length - 1 && inside.depth === 0 },
                          true,
                        )}
                      </li>
                    ))}
                  </ChatHistoryBand>
                ) : (
                  <li key={block.id} className="border-rush border-b">
                    {row(block, { first: index === 0, last: index === order.length - 1 }, false)}
                  </li>
                ),
              )}
            </ol>
            {phone && <div>{addButton}</div>}
            {removed !== null && (
              <p role="status" className="flex items-center gap-2 text-note text-reed arrive">
                {blockName(removed.block)} removed.
                {customCount >= PRESET_LIMITS.customBlocks ? (
                  <span>
                    It can't come back while the preset has {PRESET_LIMITS.customBlocks} custom
                    blocks.
                  </span>
                ) : (
                  <Button
                    size="text"
                    className="text-ink"
                    onClick={() => {
                      setBlocks(restoreBlock(fields.blocks, removed));
                      setOpen(removed.block.id);
                      setRemoved(null);
                    }}
                  >
                    Undo
                  </Button>
                )}
              </p>
            )}
            <p role="status" className="sr-only">
              {announcement}
            </p>
          </div>
        </section>
        {!wide && (
          <section className={SHEET_GRID} aria-labelledby="prompt-formatting">
            <h2 id="prompt-formatting" className={LABEL}>
              Formatting
            </h2>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
              <FormattingKey placement="section" />
            </div>
          </section>
        )}
        <AuthorsNoteSection
          note={fields.authorsNote}
          onChange={(change) => {
            setFields((current) => ({
              ...current,
              authorsNote: { ...current.authorsNote, ...change },
            }));
            autosave.touch("authorsNote");
          }}
        />
        <ActionsSection
          actions={fields.actions}
          onChange={(change) => {
            setFields((current) => ({ ...current, actions: { ...current.actions, ...change } }));
            autosave.touch("actions");
          }}
        />
        <ReasoningSection
          reasoning={fields.reasoning}
          onChange={(change) => {
            setFields((current) => ({
              ...current,
              reasoning: { ...current.reasoning, ...change },
            }));
            autosave.touch("reasoning");
          }}
        />
      </SheetBody>
      {leaveGuard}
    </main>
  );
}

/**
 * The preset's Author's Note: one note for every chat and character using the
 * preset, kept here while switched off.
 */
function AuthorsNoteSection({
  note,
  onChange,
}: {
  note: AuthorsNote;
  onChange: (change: Partial<AuthorsNote>) => void;
}) {
  return (
    <section className={SHEET_GRID} aria-labelledby="prompt-authors-note">
      <h2 id="prompt-authors-note" className={LABEL}>
        Author's Note
      </h2>
      <div className="grid gap-5">
        <p className={HELP}>
          Guidance the model reads with every character's chat, at its place in the chat or right
          after the main prompt. Lorebook entries placed above or below it travel with it.
        </p>
        <SwitchField
          checked={note.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          label="Send the Author's Note"
          description={
            note.enabled
              ? "Sent while on, as often as its frequency says."
              : "Off: kept here and not placed in the prompt; {{authorsNote}} still reads it."
          }
        />
        <div className="grid gap-4">
          <NoteEditor note={note} onChange={onChange} />
        </div>
      </div>
    </section>
  );
}

function ActionsSection({
  actions,
  onChange,
}: {
  actions: PromptActions;
  onChange: (change: Partial<PromptActions>) => void;
}) {
  return (
    <section className={SHEET_GRID} aria-labelledby="prompt-actions">
      <h2 id="prompt-actions" className={LABEL}>
        Actions
      </h2>
      <div className="grid gap-5">
        <p className={HELP}>Extra instructions sent when you use an action.</p>
        {(
          [
            [
              "continue",
              "Continue",
              "Sent last when you continue a reply. Ephemera joins the continuation to the existing text.",
            ],
            [
              "writeForMe",
              "Write for me",
              "Sent last when the model writes your next message into the composer.",
            ],
          ] as const
        ).map(([key, label, help]) => {
          const id = key === "continue" ? "action-continue" : "action-write-for-me";
          return (
            <div key={key} className="grid gap-1.5">
              <label htmlFor={id} className="font-medium text-ink text-ui">
                {label}
              </label>
              <textarea
                id={id}
                name={id}
                aria-describedby={`${id}-help`}
                value={actions[key]}
                maxLength={PRESET_LIMITS.blockText}
                rows={1}
                placeholder="Nothing extra is sent while this is empty."
                onChange={(event) => onChange({ [key]: event.target.value })}
                className={cn(FIELD, "font-mono text-note")}
              />
              <p id={`${id}-help`} className={HELP}>
                {help}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Reasoning in the prompt: read out of replies
 * that carry it inside their text, and sent back with the latest replies.
 */
function ReasoningSection({
  reasoning,
  onChange,
}: {
  reasoning: PromptReasoning;
  onChange: (change: Partial<PromptReasoning>) => void;
}) {
  const tagId = useId();
  const tagValid = reasoningTagSchema.safeParse(reasoning.tag).success;
  return (
    <section className={SHEET_GRID} aria-labelledby="prompt-reasoning">
      <h2 id="prompt-reasoning" className={LABEL}>
        Reasoning
      </h2>
      <div className="grid gap-5">
        <p className={HELP}>
          Most models send their reasoning apart from the reply and need nothing here. These are for
          models that write it inside the reply, and for sending it back.
        </p>
        <label className="flex items-start gap-3">
          <Switch
            checked={reasoning.autoParse}
            onCheckedChange={(autoParse) => onChange({ autoParse })}
            className="mt-0.5"
          />
          <span className="grid gap-0.5">
            <span className="font-medium text-ink text-ui">Read reasoning out of replies</span>
            <span className={HELP}>
              Text inside the tag, at the start of a reply, shows as reasoning instead of story.
            </span>
          </span>
        </label>
        <div className="grid gap-1.5">
          <label htmlFor={tagId} className="font-medium text-ink text-ui">
            Tag
          </label>
          <div className="flex max-w-60 items-center gap-1 text-reed text-ui">
            <span aria-hidden="true">&lt;</span>
            <input
              id={tagId}
              value={reasoning.tag}
              maxLength={PRESET_LIMITS.reasoningTagLength}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!tagValid}
              aria-describedby={`${tagId}-help`}
              onChange={(event) => onChange({ tag: event.target.value.trim() })}
              className={cn(FIELD, "h-9 min-h-0 flex-1 py-0 font-mono text-note touch:h-11")}
            />
            <span aria-hidden="true">&gt;</span>
          </div>
          <p id={`${tagId}-help`} className={cn(HELP, !tagValid && "text-ember")}>
            {tagValid
              ? `Reasoning is written as <${reasoning.tag}>…</${reasoning.tag}>.`
              : "A tag starts with a letter; letters, digits, _ . and - follow."}
          </p>
        </div>
        <label className="flex items-start gap-3">
          <Switch
            checked={reasoning.addToPrompts}
            onCheckedChange={(addToPrompts) => onChange({ addToPrompts })}
            className="mt-0.5"
          />
          <span className="grid gap-0.5">
            <span className="font-medium text-ink text-ui">Send reasoning back</span>
            <span className={HELP}>
              The reasoning of the latest replies goes with them in the prompt, inside the tag.
            </span>
          </span>
        </label>
        <div className="grid max-w-60 gap-1.5">
          <span className="font-medium text-ink text-ui">Latest replies</span>
          <NumberField
            label="Latest replies"
            value={reasoning.maxAdditions}
            min={1}
            max={PRESET_LIMITS.maxDepth}
            disabled={!reasoning.addToPrompts}
            onValueChange={(value) => onChange({ maxAdditions: value ?? 1 })}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Chat history is the waterline: blocks above come before the conversation,
 * blocks placed inside the chat sit here by depth, blocks below follow it.
 */
function ChatHistoryBand({
  enabled,
  onToggle,
  children,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  const hasBlocks = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <li
      data-block="chatHistory"
      className="relative border-control-edge border-y py-1 pl-3 before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-control-edge dark:bg-surface"
    >
      <div className="flex min-h-12 items-center gap-3 pr-1 pl-1">
        <span className="grid w-7 place-items-center text-reed" aria-hidden="true">
          <ChatIcon size={16} />
        </span>
        <span className="grid min-w-0 flex-1">
          <span
            className={cn(
              "font-medium text-ui italic transition-colors duration-(--duration-quick) ease-fade",
              enabled ? "text-ink" : "text-reed",
            )}
          >
            Chat history
          </span>
          <span id="chat-history-help" className="text-pretty text-meta text-reed">
            {enabled
              ? "The conversation so far."
              : "Off: no messages of the chat are sent, nor the blocks and notes inside it."}
          </span>
        </span>
        {/* At the end of the band, so the blocks inside stay aligned with its name. */}
        <Switch
          size="sm"
          checked={enabled}
          aria-label="Send Chat history"
          aria-describedby="chat-history-help"
          onCheckedChange={onToggle}
        />
      </div>
      {hasBlocks && (
        <>
          <p className="pb-1 pl-11 text-meta text-reed">Oldest messages</p>
          <ol aria-label="Blocks inside the chat" className="grid border-rush border-y">
            {children}
          </ol>
          <p className="pt-1 pb-1 pl-11 text-meta text-reed">Latest message</p>
        </>
      )}
    </li>
  );
}

function Segmented<Value extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: Value;
  options: [Value, string][];
  onChange: (value: Value) => void;
}) {
  return (
    <ToggleGroup
      aria-labelledby={labelledBy}
      value={[value]}
      onValueChange={(next) => {
        const chosen = options.find(([key]) => key === next[0]);
        if (chosen) onChange(chosen[0]);
      }}
      className="w-fit"
    >
      {options.map(([key, text]) => (
        <ToggleGroupItem key={key} value={key} labelled>
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

type RowProps = {
  block: PromptBlock;
  open: boolean;
  onOpen: (open: boolean) => void;
  inside: boolean;
  first: boolean;
  last: boolean;
  others: PromptBlock[];
  onChange: (change: (block: PromptBlock) => PromptBlock) => void;
  onMove: (step: -1 | 1) => void;
  onMoveBefore: (id: string, name: string) => void;
  onDepth: (delta: 1 | -1) => void;
  onPlace: (depth: number | null) => void;
  onOrder: (order: number) => void;
  onTriggers: (triggers: GenerationType[]) => void;
  /** False at the custom block limit: a copy would make the preset unsavable. */
  canDuplicate: boolean;
  onDuplicate: () => void;
  onRemove: () => void;
};

function BlockRow(props: RowProps) {
  const { block, open, onOpen, inside } = props;
  const glide = useGlide();
  const name = blockName(block);
  const meta = blockMeta(block);
  const enabled = block.kind === "chatHistory" || block.enabled;
  const toggle =
    block.kind === "chatHistory" ? null : (
      <Switch
        size="sm"
        checked={block.enabled}
        aria-label={`Send ${name}`}
        onCheckedChange={(checked) =>
          props.onChange((current) =>
            current.kind === "chatHistory" ? current : { ...current, enabled: checked },
          )
        }
      />
    );
  return (
    <Glides>
      <m.div data-block={block.id} {...glide}>
        {/* Opening a block folds its row away as the block unfolds, so the height eases. */}
        <Unfold show={!open}>
          <div className="flex items-center gap-3 pl-1">
            {toggle}
            <OpenRow
              label={`${name}: ${enabled ? meta : `off. ${meta}`}`}
              onOpen={() => onOpen(true)}
              className="pr-1"
            >
              <span className="grid min-w-0 flex-1 items-center gap-x-3 tablet:grid-cols-[13rem_minmax(0,1fr)]">
                <span
                  className={cn(
                    "truncate font-medium text-ui transition-colors duration-(--duration-quick) ease-fade",
                    enabled ? "text-ink" : "text-reed",
                  )}
                >
                  {name}
                </span>
                <span
                  className={cn(
                    "truncate text-note transition-colors duration-(--duration-quick) ease-fade",
                    enabled && block.kind !== "source" && meta !== "Empty"
                      ? "text-narration"
                      : "text-reed",
                  )}
                >
                  {enabled ? meta : `Off. ${meta}`}
                </span>
              </span>
            </OpenRow>
            {inside && <span className="sr-only">Inside the chat</span>}
          </div>
        </Unfold>
        <Unfold show={open}>
          {/* Padded inside, so the folding box reaches no height at all. */}
          <div className="py-3 pl-1">
            <OpenBlock {...props} toggle={toggle} name={name} />
          </div>
        </Unfold>
      </m.div>
    </Glides>
  );
}

function OpenBlock({
  block,
  onOpen,
  inside,
  first,
  last,
  others,
  onChange,
  onMove,
  onMoveBefore,
  onDepth,
  onPlace,
  onOrder,
  onTriggers,
  canDuplicate,
  onDuplicate,
  onRemove,
  toggle,
  name,
}: RowProps & { toggle: React.ReactNode; name: string }) {
  const id = useId();
  const [movingBefore, setMovingBefore] = useState(false);
  const custom = block.kind === "custom" ? block : null;
  const placeable = isPlaceable(block) ? block : null;
  const depth = placeable?.depth ?? null;
  const templateValid =
    block.kind !== "source" || sourceTemplateSchema.safeParse(block.template ?? "").success;
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        {toggle}
        {movingBefore ? (
          <MoveBefore
            others={others}
            onMove={(target) => {
              setMovingBefore(false);
              onMoveBefore(target.id, blockName(target));
            }}
            onCancel={() => setMovingBefore(false)}
          />
        ) : (
          <>
            <CloseRow onClose={() => onOpen(false)}>{name}</CloseRow>
            {inside ? (
              <MoveButtons
                earlierLabel={`Send ${name} one message earlier`}
                laterLabel={`Send ${name} one message later`}
                canMoveEarlier={(depth ?? 0) < PRESET_LIMITS.maxDepth}
                canMoveLater={(depth ?? 0) > 0}
                onEarlier={() => onDepth(1)}
                onLater={() => onDepth(-1)}
              />
            ) : (
              <MoveButtons
                earlierLabel={`Move ${name} earlier`}
                laterLabel={`Move ${name} later`}
                canMoveEarlier={!first}
                canMoveLater={!last}
                onEarlier={() => onMove(-1)}
                onLater={() => onMove(1)}
              />
            )}
            <Menu>
              <MenuTrigger render={<Button size="icon" aria-label={`More for ${name}`} />}>
                <MoreIcon />
              </MenuTrigger>
              <MenuContent label={`${name} actions`}>
                <MenuItem disabled={inside} onClick={() => setMovingBefore(true)}>
                  Move before…
                </MenuItem>
                {custom && (
                  <>
                    <MenuItem disabled={!canDuplicate} onClick={onDuplicate}>
                      Duplicate
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem danger onClick={onRemove}>
                      Remove
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
          </>
        )}
      </div>
      {block.kind === "source" && (
        <p className={cn(HELP, "tablet:pl-10")}>
          {BLOCK_SOURCE[block.id]}, when a reply is written.{" "}
          {placeable
            ? "Move it, place it inside the chat, or switch it off to leave it out."
            : "Move it, or switch it off to leave it out."}
        </p>
      )}
      {placeable && (
        <div className="grid gap-4 tablet:pl-10">
          <div className="grid gap-4 tablet:grid-cols-[minmax(0,1fr)_auto]">
            {custom && (
              <label className="grid gap-1.5">
                <span className="text-note text-reed">Name</span>
                <input
                  name="block-name"
                  value={custom.name}
                  maxLength={PRESET_LIMITS.nameLength}
                  autoComplete="off"
                  onChange={(event) =>
                    onChange((current) => ({ ...current, name: event.target.value }))
                  }
                  className={cn(FIELD, "h-9 py-0 text-ui touch:h-11")}
                />
              </label>
            )}
            <div className={cn("grid gap-1.5", !custom && "tablet:col-span-2")}>
              <span id={`${id}-role`} className="text-note text-reed">
                Sent as
              </span>
              <Segmented
                labelledBy={`${id}-role`}
                value={blockRole(placeable)}
                options={ROLES}
                onChange={(role) =>
                  onChange((current) => (isPlaceable(current) ? { ...current, role } : current))
                }
              />
            </div>
            <div className="grid gap-1.5 tablet:col-span-2">
              <span id={`${id}-place`} className="text-note text-reed">
                Place
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  labelledBy={`${id}-place`}
                  value={depth === null ? "order" : "chat"}
                  options={[
                    ["order", "In the running order"],
                    ["chat", "Inside the chat"],
                  ]}
                  onChange={(place) =>
                    onPlace(place === "order" ? null : PRESET_LIMITS.defaultDepth)
                  }
                />
                {depth !== null && (
                  <span className="flex items-center gap-2 text-ink text-ui">
                    <NumberField
                      value={depth}
                      min={0}
                      max={PRESET_LIMITS.maxDepth}
                      step={1}
                      label="Messages from the end"
                      className="w-28 touch:w-40"
                      onValueChange={(value) => {
                        if (value !== null) {
                          onChange((current) =>
                            isPlaceable(current) ? { ...current, depth: value } : current,
                          );
                        }
                      }}
                    />
                    messages from the end
                  </span>
                )}
              </div>
              {depth !== null && <p className={HELP}>0 puts it after the latest message.</p>}
            </div>
            {depth !== null && (
              <div className="grid gap-1.5 tablet:col-span-2">
                <span className="flex items-center gap-2 text-ink text-ui">
                  <NumberField
                    value={blockOrder(placeable)}
                    min={-PRESET_LIMITS.maxOrder}
                    max={PRESET_LIMITS.maxOrder}
                    step={1}
                    label="Order"
                    className="w-28 touch:w-40"
                    onValueChange={(value) => {
                      if (value !== null) onOrder(value);
                    }}
                  />
                  order
                </span>
                <p className={HELP}>
                  At one depth, lower orders are sent first; blocks of one order and role go as one
                  message. New blocks have {PRESET_LIMITS.defaultOrder}.
                </p>
              </div>
            )}
            {isPlaceable(block) && (
              <div className="grid gap-1.5 tablet:col-span-2">
                <span id={`${id}-triggers`} className="text-note text-reed">
                  Sent for
                </span>
                <ToggleGroup
                  multiple
                  aria-labelledby={`${id}-triggers`}
                  aria-describedby={`${id}-triggers-help`}
                  value={placeable.triggers ?? []}
                  onValueChange={(next) =>
                    onTriggers(GENERATION_TYPES.filter((type) => next.includes(type)))
                  }
                  className="w-fit flex-wrap"
                >
                  {GENERATION_TYPES.map((type) => (
                    <ToggleGroupItem key={type} value={type} labelled>
                      {TRIGGER_NAMES[type]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p id={`${id}-triggers-help`} className={HELP}>
                  {(placeable.triggers ?? []).length === 0
                    ? "None chosen: sent for every kind of generation."
                    : block.kind === "source"
                      ? "For the others it is still sent, as a system message, inside the chat after the latest message when placed there."
                      : "Left out of the others."}
                </p>
              </div>
            )}
            {block.kind === "text" && (
              <label className="flex items-start gap-3 tablet:col-span-2">
                <Switch
                  checked={block.forbidOverrides ?? false}
                  onCheckedChange={(forbidOverrides) =>
                    onChange((current) =>
                      current.kind === "text" ? { ...current, forbidOverrides } : current,
                    )
                  }
                  className="mt-0.5"
                />
                <span className="grid gap-0.5">
                  <span className="font-medium text-ink text-ui">Keep it over the character's</span>
                  <span className={HELP}>
                    {block.id === "main"
                      ? "A character's own system prompt never replaces it, whatever Settings say."
                      : "A character's own post-history instructions never replace these, whatever Settings say."}
                  </span>
                </span>
              </label>
            )}
          </div>
          {(block.kind === "text" || block.kind === "custom") && (
            <textarea
              aria-label={`${name} text`}
              value={block.content}
              maxLength={PRESET_LIMITS.blockText}
              placeholder="Nothing is sent while this is empty."
              onChange={(event) =>
                onChange((current) =>
                  current.kind === "text" || current.kind === "custom"
                    ? { ...current, content: event.target.value }
                    : current,
                )
              }
              className={FIELD}
            />
          )}
        </div>
      )}
      {block.kind === "source" && (
        <div className="grid gap-1.5 tablet:pl-10">
          <label htmlFor={`${id}-template`} className="text-note text-reed">
            Template
          </label>
          <textarea
            id={`${id}-template`}
            aria-describedby={`${id}-template-help`}
            value={block.template ?? ""}
            rows={1}
            maxLength={PRESET_LIMITS.blockText}
            placeholder="Sent as it is while this is empty."
            aria-invalid={!templateValid}
            onChange={(event) =>
              onChange((current) =>
                current.kind === "source" ? { ...current, template: event.target.value } : current,
              )
            }
            className={cn(FIELD, "font-mono text-note")}
          />
          <p id={`${id}-template-help`} className={cn(HELP, !templateValid && "text-ember")}>
            {templateValid
              ? "Write {{content}} where the text goes, such as [Scenario: {{content}}]."
              : "Add {{content}} to keep this block's text."}
          </p>
        </div>
      )}
    </div>
  );
}

/** Moves a block before another, chosen by name. Not a form: the sheet is one form already. */
function MoveBefore({
  others,
  onMove,
  onCancel,
}: {
  others: PromptBlock[];
  onMove: (target: PromptBlock) => void;
  onCancel: () => void;
}) {
  const labelId = useId();
  const [target, setTarget] = useState<string | null>(others[0]?.id ?? null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => trigger.current?.focus(), []);
  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <span id={labelId} className="text-ink text-ui">
        Move before
      </span>
      <Select
        value={target}
        items={Object.fromEntries(others.map((other) => [other.id, blockName(other)]))}
        onValueChange={(value) => setTarget(typeof value === "string" ? value : null)}
      >
        <SelectTrigger
          ref={trigger}
          aria-labelledby={labelId}
          placeholder="Choose a block"
          className="w-56"
        />
        <SelectContent label="Blocks">
          {others.map((other) => (
            <SelectItem key={other.id} value={other.id}>
              {blockName(other)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        disabled={target === null}
        onClick={() => {
          const chosen = others.find((other) => other.id === target);
          if (chosen) onMove(chosen);
        }}
      >
        Move
      </Button>
      <Button onClick={onCancel}>Cancel</Button>
    </div>
  );
}
