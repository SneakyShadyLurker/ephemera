import {
  CARD_LIMITS,
  ENTRY_ACTIVATIONS,
  ENTRY_LOGICS,
  type EntryActivation,
  type EntryLogic,
  type EntryPlacement,
  type EntrySettings,
  type EntrySettingsPatch,
  entryActivation,
  entrySettings,
  entryTitle,
  LOREBOOK_RULES,
  type LorebookEntry,
  MAX_CHAT_TURNS,
  splitPoolNames,
} from "@ephemera/core";
import { useId, useState } from "react";
import { ChanceArc, MoreIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { NumberField } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Switch, SwitchField } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { oneOf } from "@/lib/one-of.ts";
import { countOf } from "@/lib/text";
import { FIELD } from "../sheet/fields.ts";
import { Labelled } from "../sheet/Labelled.tsx";
import { DepthField, RoleField } from "../sheet/RoleFields.tsx";
import { activationChange, entryKeyProblems, isActivation, secondaryKeyProblems } from "./book.ts";
import {
  ACTIVATION_TEXT,
  chainingAnswer,
  chainingOffNote,
  chanceHelp,
  entrySource,
  KEY_PROBLEM_REASON,
  keywordsHelp,
  LOGIC_TEXT,
  matchingAnswer,
  PLACEMENT_TEXT,
  PLACEMENTS,
  POOL_HELP,
  placementAnswer,
  poolAnswer,
  SOURCE_CONFLICT,
  SOURCE_TEXT,
  type Source,
  secondaryConsequence,
  TIMING_COUNT,
  timingAnswer,
  timingSentence,
} from "./copy.ts";
import { KeywordsField } from "./KeywordsField.tsx";
import { ActivationMark } from "./marks.tsx";
import { SettingsRow } from "./SettingsRow.tsx";

const HELP = "text-pretty text-note text-reed";
const LABEL = "font-medium text-ink text-ui";

/** The editor's closed rows, in the order the owner asks them. */
const ENTRY_ROWS = ["where", "when", "pool", "brings", "matches"] as const;
export type EntryRow = (typeof ENTRY_ROWS)[number];

const PLACEMENT_ITEMS = Object.fromEntries(
  PLACEMENTS.map((placement) => [placement, PLACEMENT_TEXT[placement].label]),
) as Record<EntryPlacement, string>;
const LOGIC_ITEMS = Object.fromEntries(
  ENTRY_LOGICS.map((logic) => [logic, LOGIC_TEXT[logic].label]),
) as Record<EntryLogic, string>;

const isPlacement = oneOf(PLACEMENTS);
const isLogic = oneOf(ENTRY_LOGICS);

/** An entry's actions: duplicate it, or remove it (with Undo in the list). */
export function EntryMenu({
  title,
  onDuplicate,
  onRemove,
}: {
  title: string;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon" aria-label={`More for ${title}`} />}>
        <MoreIcon />
      </MenuTrigger>
      <MenuContent label="Entry actions">
        <MenuItem onClick={onDuplicate}>Duplicate</MenuItem>
        <MenuSeparator />
        <MenuItem danger onClick={onRemove}>
          Remove
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** The editor's inline padding, shared with the lorebook header's frames. */
export const ENTRY_INSET = { start: "pl-5 tablet:pl-10", end: "pr-5 tablet:pr-10" } as const;
export const ENTRY_X = cn(ENTRY_INSET.start, ENTRY_INSET.end);

interface EntryEditorProps {
  entry: LorebookEntry;
  index: number;
  /** The entry's More menu, when the header does not carry it. */
  menu: React.ReactNode;
  /**
   * The book's scan depth as activation reads it, whether it chains entries,
   * and the event pool names its entries use.
   */
  book: { depth: number; chaining: boolean; pools: readonly string[] };
  /** Which of the rows are open, kept by the screen for its visit. */
  openRows: readonly EntryRow[];
  onRow: (row: EntryRow, open: boolean) => void;
  /** Card fields the settings writer does not own. */
  onChange: (change: Partial<LorebookEntry>) => void;
  /** World Info settings, written by core's `withEntrySettings`. */
  onSettings: (patch: EntrySettingsPatch) => void;
  /** Shows the book settings with focus on Chaining. */
  onOpenBookSettings: () => void;
}

/**
 * One entry: title and Enabled, how it goes in (always, on keywords or by
 * chance), the keywords, the secondary condition, the text, then closed rows that
 * answer where it goes, when it goes in, which event pool it is in, what
 * brings it in and what it matches, and last what the card holds that Ephemera keeps but does not use.
 * Every change goes to the book at once; the layout follows the editor's own
 * width.
 */
export function EntryEditor(props: EntryEditorProps) {
  const { entry, index, menu, onChange, onSettings } = props;
  const settings = entrySettings(entry);
  const titleId = "entry-title";
  const contentId = useId();
  const constant = entry.constant === true;
  const activation = entryActivation(entry, settings);
  const open = (row: EntryRow) => props.openRows.includes(row);
  const row = (id: EntryRow) => ({
    open: open(id),
    onOpenChange: (next: boolean) => props.onRow(id, next),
  });
  return (
    <section
      aria-labelledby={titleId}
      // Centred alone; on desktop it starts beside the list (LorebookScreen's split view).
      className={cn(
        ENTRY_X,
        "@container mx-auto grid w-full max-w-column grid-cols-[minmax(0,1fr)] gap-6 pt-4 pb-16 desktop:mx-0 arrive tablet:pt-8",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <input
          id={titleId}
          aria-label="Title"
          value={entry.comment ?? ""}
          placeholder={entryTitle({ ...entry, comment: "" }, index)}
          maxLength={CARD_LIMITS.textLength}
          autoComplete="off"
          onChange={(event) => onChange({ comment: event.target.value })}
          className="-mx-1.5 min-w-48 flex-1 basis-48 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-semibold text-heading text-ink outline-none transition-[border-color,background-color] duration-(--duration-tint) placeholder:text-reed hover:border-rush focus:border-dusk-line focus:bg-surface touch:border-b-rush"
        />
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex h-9 items-center gap-2 text-ink text-ui touch:h-11">
            <Switch checked={entry.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
            Enabled
          </label>
          {menu}
        </div>
      </div>

      <div className="grid gap-4">
        <GoesIn
          entry={entry}
          settings={settings}
          activation={activation}
          onChange={onChange}
          onSettings={onSettings}
        />
        <KeywordsField
          keys={entry.keys}
          problems={entryKeyProblems(entry)}
          dimmed={constant}
          help={keywordsHelp(settings, constant, entry.useRegex)}
          onChange={(keys) => onChange({ keys })}
        />
        <SecondaryCondition entry={entry} settings={settings} onSettings={onSettings} />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={contentId} className={LABEL}>
          Text
        </label>
        <textarea
          id={contentId}
          value={entry.content}
          rows={4}
          maxLength={CARD_LIMITS.textLength}
          onChange={(event) => onChange({ content: event.target.value })}
          className={FIELD}
        />
        <p className={HELP}>
          What the model reads when the entry goes in. Macros such as {"{{char}}"} work.
        </p>
      </div>

      <div className="grid border-rush border-b">
        <SettingsRow
          label="Where it goes"
          answer={placementAnswer(settings, entry.insertionOrder)}
          {...row("where")}
        >
          <WhereItGoes
            entry={entry}
            settings={settings}
            onChange={onChange}
            onSettings={onSettings}
          />
        </SettingsRow>
        <SettingsRow
          label="When it goes in"
          answer={timingAnswer(settings, activation === "keywords" ? settings.chance : null)}
          {...row("when")}
        >
          <WhenItGoesIn
            settings={settings}
            keywords={activation === "keywords"}
            onSettings={onSettings}
          />
        </SettingsRow>
        <SettingsRow label="Event pool" answer={poolAnswer(settings)} {...row("pool")}>
          <EventPool settings={settings} pools={props.book.pools} onSettings={onSettings} />
        </SettingsRow>
        <SettingsRow
          label="What brings it in"
          answer={chainingAnswer(settings, props.book.chaining)}
          {...row("brings")}
        >
          <WhatBringsItIn
            settings={settings}
            chaining={props.book.chaining}
            onSettings={onSettings}
            onOpenBookSettings={props.onOpenBookSettings}
          />
        </SettingsRow>
        <SettingsRow
          label="What it matches"
          answer={matchingAnswer(settings, props.book.depth)}
          {...row("matches")}
        >
          <WhatItMatches
            entry={entry}
            settings={settings}
            bookDepth={props.book.depth}
            onChange={onChange}
            onSettings={onSettings}
          />
        </SettingsRow>
      </div>
    </section>
  );
}

/**
 * How the entry goes in: always, on its keywords, or by chance. "By chance"
 * reveals its percentage, rising in when the choice brings it, not on opening.
 */
function GoesIn({
  entry,
  settings,
  activation,
  onChange,
  onSettings,
}: {
  entry: LorebookEntry;
  settings: EntrySettings;
  activation: EntryActivation;
  onChange: (change: Partial<LorebookEntry>) => void;
  onSettings: (patch: EntrySettingsPatch) => void;
}) {
  const labelId = useId();
  const helpId = useId();
  const [revealed, setRevealed] = useState(false);
  // The arc glides only after the owner changes the number here, never on opening.
  const [lively, setLively] = useState(false);
  const chance = settings.chance;
  return (
    <div className="grid gap-1.5">
      <span id={labelId} className={LABEL}>
        Goes in
      </span>
      <ToggleGroup
        aria-labelledby={labelId}
        value={[activation]}
        onValueChange={(value) => {
          const next = value[0];
          if (!isActivation(next) || next === activation) return;
          setRevealed(next === "chance");
          onChange(activationChange(entry, next));
        }}
        // The three options stack when the editor is narrow.
        className="grid w-full @sm:inline-flex @sm:w-fit"
      >
        {ENTRY_ACTIVATIONS.map((value) => (
          <ToggleGroupItem key={value} value={value} labelled className="justify-start">
            <ActivationMark activation={value} />
            {ACTIVATION_TEXT[value]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {activation === "chance" && chance !== null && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1.5",
            revealed && "arrive",
          )}
        >
          <span className="flex items-center gap-1.5">
            <NumberField
              label="Chance in percent"
              describedBy={helpId}
              value={chance}
              min={1}
              max={99}
              className="w-32 touch:w-40"
              onValueChange={(value) => {
                if (value === null) return;
                setLively(true);
                onSettings({ probability: Math.trunc(value) });
              }}
            />
            <span aria-hidden="true" className="text-ink text-ui">
              %
            </span>
            <ChanceArc chance={chance} lively={lively} className="ml-1" />
          </span>
          <p id={helpId} className={cn(HELP, "min-w-0 flex-1 basis-48")}>
            {chanceHelp(chance)}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The secondary keywords as one sentence and a second keyword field; without
 * any, a quiet button that reveals the field with focus in it. An emptied
 * field stays while it has focus and goes back to the button when focus leaves.
 */
function SecondaryCondition({
  entry,
  settings,
  onSettings,
}: {
  entry: LorebookEntry;
  settings: EntrySettings;
  onSettings: (patch: EntrySettingsPatch) => void;
}) {
  const keys = settings.secondaryKeys;
  const [revealed, setRevealed] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const conditionId = useId();

  if (keys.length === 0 && !revealed) {
    return (
      <Button
        variant="quiet"
        className="-ml-2 h-auto min-h-9 justify-self-start whitespace-normal px-2 py-1.5 text-left font-normal text-reed text-ui touch:min-h-11"
        onClick={() => setRevealed(true)}
      >
        <PlusIcon size={16} />
        Add words the messages must also have, or must not have
      </Button>
    );
  }
  const logic = settings.logic;
  return (
    <fieldset
      aria-labelledby={conditionId}
      className={cn("grid min-w-0 gap-2", revealed && "arrive")}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (choosing || (next instanceof Node && event.currentTarget.contains(next))) return;
        if (keys.length === 0) setRevealed(false);
      }}
    >
      <p
        id={conditionId}
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ink text-ui"
      >
        <span>Goes in only if the messages</span>
        <span className="inline-flex items-center gap-x-1.5">
          <Select
            value={logic}
            items={LOGIC_ITEMS}
            onOpenChange={setChoosing}
            onValueChange={(value) => {
              if (isLogic(value)) onSettings({ logic: value });
            }}
          >
            <SelectTrigger
              aria-label="Secondary keyword condition"
              placeholder="Condition"
              className="inline-flex h-8 w-auto gap-1.5 pr-1.5 pl-2.5 touch:h-11"
            />
            <SelectContent label="Conditions" className="w-[min(20rem,calc(100vw-2rem))]">
              {ENTRY_LOGICS.map((value) => (
                <SelectItem key={value} value={value} description={LOGIC_TEXT[value].description}>
                  {LOGIC_TEXT[value].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>these:</span>
        </span>
      </p>
      <KeywordsField
        label="Secondary keywords"
        keys={keys}
        problems={secondaryKeyProblems(entry)}
        dimmed={false}
        help="Same rules as the keywords."
        focusOnMount={revealed}
        notice={(problems) => {
          const [first] = problems;
          if (first === undefined) return "";
          return `${problems.length > 1 ? `${first.key}: ` : ""}${secondaryConsequence(logic, problems.length, keys.length)} ${KEY_PROBLEM_REASON[first.problem]}`;
        }}
        onChange={(secondaryKeys) => onSettings({ secondaryKeys })}
      />
      {entry.selective === false && keys.length > 0 && (
        <p className={HELP}>
          The card switches these words off, so the entry goes in on its keywords alone. Changing
          them switches them on.
        </p>
      )}
    </fieldset>
  );
}

function WhereItGoes({
  entry,
  settings,
  onChange,
  onSettings,
}: {
  entry: LorebookEntry;
  settings: EntrySettings;
  onChange: (change: Partial<LorebookEntry>) => void;
  onSettings: (patch: EntrySettingsPatch) => void;
}) {
  // Depth and role rise in only when a placement change brings them, not on opening.
  const [revealed, setRevealed] = useState(false);
  const inChat = settings.placement === "depth";
  const orderNote = useId();
  return (
    <>
      <div className="grid gap-3 @lg:grid-cols-[minmax(0,1fr)_10rem]">
        <Labelled label="Placement">
          {(labelId) => (
            <Select
              value={settings.placement}
              items={PLACEMENT_ITEMS}
              onValueChange={(value) => {
                if (!isPlacement(value) || value === settings.placement) return;
                setRevealed(value === "depth");
                onSettings({ placement: value });
              }}
            >
              <SelectTrigger aria-labelledby={labelId} placeholder="Placement" />
              <SelectContent label="Placements" className="min-w-[min(22rem,calc(100vw-2rem))]">
                {PLACEMENTS.map((value) => (
                  <SelectItem
                    key={value}
                    value={value}
                    description={PLACEMENT_TEXT[value].description}
                  >
                    {PLACEMENT_TEXT[value].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Labelled>
        <Labelled label="Order">
          {() => (
            <NumberField
              key={entry.insertionOrder}
              label="Order"
              describedBy={orderNote}
              defaultValue={entry.insertionOrder}
              step={10}
              onValueCommitted={(value) => {
                if (value !== null && value !== entry.insertionOrder) {
                  onChange({ insertionOrder: value });
                }
              }}
            />
          )}
        </Labelled>
      </div>
      {inChat && (
        <div
          className={cn("grid grid-cols-2 gap-3 @lg:grid-cols-[10rem_10rem]", revealed && "arrive")}
        >
          <DepthField
            value={settings.depth}
            note="Messages from the end; 0 is after the last message"
            onChange={(depth) => onSettings({ depth })}
          />
          <RoleField value={settings.role} onChange={(role) => onSettings({ role })} />
        </div>
      )}
      <p id={orderNote} className={HELP}>
        Sent lowest order first. If the budget runs out, the lowest orders are dropped first;
        entries staying in from earlier messages are kept.
      </p>
    </>
  );
}

function WhenItGoesIn({
  settings,
  keywords,
  onSettings,
}: {
  settings: EntrySettings;
  /** Whether it goes in on its keywords, where a trigger chance is set here. */
  keywords: boolean;
  onSettings: (patch: EntrySettingsPatch) => void;
}) {
  const sentenceId = useId();
  const chanceId = useId();
  const field = (label: string, key: "sticky" | "cooldown" | "delay", note: string) => (
    <Labelled label={label} note={note}>
      {() => (
        <NumberField
          label={label}
          describedBy={sentenceId}
          value={settings[key]}
          min={0}
          max={MAX_CHAT_TURNS}
          onValueChange={(value) => {
            const patch: EntrySettingsPatch = {};
            patch[key] = Math.trunc(value ?? 0);
            onSettings(patch);
          }}
        />
      )}
    </Labelled>
  );
  return (
    <>
      <div className="grid gap-3 @xs:grid-cols-2 @md:grid-cols-3">
        {field("Sticky", "sticky", "messages")}
        {field("Cooldown", "cooldown", "messages")}
        {field("Delay", "delay", "messages in the chat")}
      </div>
      <div className="grid gap-1">
        <p id={sentenceId} className="text-pretty text-ink text-note">
          {timingSentence(settings)}
        </p>
        <p className={HELP}>{TIMING_COUNT}</p>
      </div>
      {keywords && (
        <div className="grid gap-3 @xs:grid-cols-2 @md:grid-cols-3">
          <Labelled label="Chance" note="% of matches; 100 is every time">
            {() => (
              <NumberField
                label="Chance in percent"
                describedBy={chanceId}
                value={settings.chance ?? 100}
                min={1}
                max={100}
                onValueChange={(value) => {
                  if (value === null) return;
                  const chance = Math.trunc(value);
                  onSettings(
                    chance >= 100
                      ? { useProbability: false }
                      : { useProbability: true, probability: chance },
                  );
                }}
              />
            )}
          </Labelled>
          <p id={chanceId} className={cn(HELP, "self-center @xs:col-span-1 @md:col-span-2")}>
            Rolled once per reply when its keywords match. A sticky entry stays in without a roll.
          </p>
        </div>
      )}
    </>
  );
}

/**
 * Its event pools: names as tokens with the book's other names offered, then
 * its weight and Prioritize, which rise in when the first name brings them.
 */
function EventPool({
  settings,
  pools,
  onSettings,
}: {
  settings: EntrySettings;
  /** The pool names the book's entries use. */
  pools: readonly string[];
  onSettings: (patch: EntrySettingsPatch) => void;
}) {
  const weightId = useId();
  const [revealed, setRevealed] = useState(false);
  const names = settings.poolNames;
  const counted = LOREBOOK_RULES.poolsPerEntry;
  return (
    <>
      <p className={HELP}>{POOL_HELP}</p>
      <KeywordsField
        label="Pool names"
        item="pool"
        split={splitPoolNames}
        suggestions={pools.filter((name) => !names.includes(name))}
        keys={names}
        problems={[]}
        dimmed={false}
        help={`Enter or a comma adds one.${names.length > counted ? ` Only the first ${counted} count.` : ""}`}
        onChange={(poolNames) => {
          setRevealed(names.length === 0 && poolNames.length > 0);
          onSettings({ poolNames });
        }}
      />
      {names.length > 0 && (
        <div className={cn("grid gap-4", revealed && "arrive")}>
          <div className="grid gap-3 @xs:grid-cols-2 @md:grid-cols-3">
            <Labelled label="Weight" note="Relative to the pool's other entries">
              {() => (
                <NumberField
                  label="Weight"
                  describedBy={weightId}
                  value={settings.poolWeight}
                  min={LOREBOOK_RULES.poolWeight.min}
                  max={LOREBOOK_RULES.poolWeight.max}
                  onValueChange={(value) => {
                    if (value !== null) onSettings({ poolWeight: Math.trunc(value) });
                  }}
                />
              )}
            </Labelled>
            <p id={weightId} className={cn(HELP, "self-center @xs:col-span-1 @md:col-span-2")}>
              When several of its entries trigger, the pool draws one: an entry weighing 200 is
              picked twice as often as one weighing 100.
            </p>
          </div>
          <SwitchField
            label="Prioritize this entry"
            description="Among this pool's entries that trigger, prioritized ones win, highest order first."
            checked={settings.poolPrioritized}
            onCheckedChange={(on) => onSettings({ poolPrioritized: on })}
          />
        </div>
      )}
    </>
  );
}

function WhatBringsItIn({
  settings,
  chaining,
  onSettings,
  onOpenBookSettings,
}: {
  settings: EntrySettings;
  chaining: boolean;
  onSettings: (patch: EntrySettingsPatch) => void;
  onOpenBookSettings: () => void;
}) {
  const labelId = useId();
  const source = entrySource(settings);
  const choose = (next: Source) =>
    onSettings({
      excludeRecursion: next === "keywordsOnly",
      recursiveOnly: next === "entryOnly",
    });
  return (
    <>
      {!chaining && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 basis-56 text-pretty text-ink text-note">
            {chainingOffNote(settings)}
          </p>
          <Button variant="outline" onClick={onOpenBookSettings}>
            Open book settings
          </Button>
        </div>
      )}
      <div className="grid gap-1.5">
        <span id={labelId} className="text-meta text-reed">
          Can go in through
        </span>
        <ToggleGroup
          aria-labelledby={labelId}
          value={source === null ? [] : [source]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "keywordsOrEntry" || next === "keywordsOnly" || next === "entryOnly") {
              choose(next);
            }
          }}
          className="grid w-full @lg:inline-flex @lg:w-fit"
        >
          {(Object.keys(SOURCE_TEXT) as Source[]).map((value) => (
            <ToggleGroupItem key={value} value={value} labelled className="justify-start">
              {SOURCE_TEXT[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {source === null ? (
          <p className="text-pretty text-ink text-note">{SOURCE_CONFLICT}</p>
        ) : (
          source === "entryOnly" && <p className={HELP}>Skips the first read of the chat.</p>
        )}
      </div>
      <SwitchField
        label="Its text can bring in other entries"
        description="Other entries' keywords are looked for in its text."
        checked={!settings.preventRecursion}
        onCheckedChange={(on) => onSettings({ preventRecursion: !on })}
      />
    </>
  );
}

function WhatItMatches({
  entry,
  settings,
  bookDepth,
  onChange,
  onSettings,
}: {
  entry: LorebookEntry;
  settings: EntrySettings;
  bookDepth: number;
  onChange: (change: Partial<LorebookEntry>) => void;
  onSettings: (patch: EntrySettingsPatch) => void;
}) {
  const bookMessages = countOf(bookDepth, "message");
  return (
    <>
      <div className="grid gap-4 @md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] @md:gap-3">
        <Labelled label="Scan depth" note={`Blank uses the book's: ${bookMessages}`}>
          {() => (
            <NumberField
              label="Scan depth"
              value={settings.scanDepth}
              min={0}
              max={LOREBOOK_RULES.maxScanDepth}
              onValueChange={(value) =>
                onSettings({ scanDepth: value === null ? null : Math.trunc(value) })
              }
            />
          )}
        </Labelled>
        <TriState
          label="Match case"
          value={settings.caseSensitive}
          note="Default is off"
          onChange={(caseSensitive) => onSettings({ caseSensitive })}
        />
        <TriState
          label="Whole words"
          value={settings.wholeWords}
          note="Default is on"
          onChange={(wholeWords) => onSettings({ wholeWords })}
        />
      </div>
      {entry.useRegex && (
        <SwitchField
          label="Keywords are patterns"
          description="Set in the card: every keyword is a regular expression, slashes or not."
          checked
          onCheckedChange={(on) => onChange({ useRegex: on })}
        />
      )}
    </>
  );
}

/** Default, On or Off: an explicit value stays explicit, and Default writes null. */
function TriState({
  label,
  value,
  note,
  onChange,
}: {
  label: string;
  value: boolean | null;
  note: string;
  onChange: (value: boolean | null) => void;
}) {
  const current = value === null ? "default" : value ? "on" : "off";
  return (
    <Labelled label={label} note={note}>
      {(labelId) => (
        <ToggleGroup
          aria-labelledby={labelId}
          value={[current]}
          onValueChange={(next) => {
            const chosen = next[0];
            if (chosen === "default") onChange(null);
            else if (chosen === "on") onChange(true);
            else if (chosen === "off") onChange(false);
          }}
          className="w-fit"
        >
          <ToggleGroupItem value="default" labelled>
            Default
          </ToggleGroupItem>
          <ToggleGroupItem value="on" labelled>
            On
          </ToggleGroupItem>
          <ToggleGroupItem value="off" labelled>
            Off
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    </Labelled>
  );
}
