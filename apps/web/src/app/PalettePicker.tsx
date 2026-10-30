import { Collapsible } from "@base-ui/react/collapsible";
import {
  builtInBase,
  CUSTOM_SLOTS,
  type CustomPalette,
  type CustomSlot,
  customPaletteId,
  customPaletteSlot,
  isCustomPalette,
  PALETTE_CHOICES,
  PALETTES,
  type PaletteChoice,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState, ViewTransition } from "react";
import { ChevronDownIcon, EditIcon, PlusIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { oneOf } from "@/lib/one-of.ts";
import { readBuiltIn } from "../palettes/derive.ts";
import {
  closeDraft,
  currentDraft,
  editSaved,
  type PaletteDraft,
  startDraft,
  usePaletteDraft,
} from "../palettes/draft.ts";
import { PaletteEditor } from "../palettes/PaletteEditor.tsx";
import { customPalettesQuery } from "../palettes/queries.ts";
import { BUILT_IN_NAMES } from "../palettes/roles.ts";
import { useScheme, useTheme } from "./theme.tsx";

/**
 * Keeps arrow keys on a button inside a radio group: the group would take
 * them to move to, and choose, another palette.
 */
const keepArrows = (event: KeyboardEvent) => {
  if (event.key.startsWith("Arrow")) event.stopPropagation();
};

const isChoice = oneOf(PALETTE_CHOICES);

/** A palette's name on screen: a built-in's, or the player's own. */
function paletteName(id: PaletteChoice, customs: readonly CustomPalette[]): string {
  if (!isCustomPalette(id)) return BUILT_IN_NAMES[id];
  return customs.find((custom) => customPaletteId(custom.slot) === id)?.name ?? "Your palette";
}

/** A palette's two schemes: a built-in's as styles.css resolves them, or a saved one's. */
function paletteColours(id: PaletteChoice, customs: readonly CustomPalette[]) {
  const saved = customs.find((custom) => customPaletteId(custom.slot) === id);
  if (saved !== undefined) return { light: saved.light, dark: saved.dark };
  return readBuiltIn(builtInBase(id));
}

/**
 * One scheme of a palette in miniature: a slip of text on its canvas, its
 * accent and three highlight tones. The swatch scopes the palette's tokens
 * (styles.css), so it reads the `-base` surfaces rather than the app's
 * tinted ones.
 */
function Scheme({ scheme }: { scheme: "light" | "dark" }) {
  return (
    <div
      className={
        scheme === "light"
          ? "grid content-center gap-1.5 bg-(--canvas-base) p-2 [color-scheme:light]"
          : "grid content-center gap-1.5 bg-(--canvas-base) p-2 [color-scheme:dark]"
      }
    >
      <div className="grid gap-1 rounded-sm bg-(--surface-base) p-1.5">
        <span className="h-1 w-4/5 rounded-full bg-ink" />
        <span className="h-1 w-3/5 rounded-full bg-reed" />
      </div>
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-5 rounded-full bg-dusk" />
        <span className="ml-auto size-1.5 rounded-full bg-(--tone-rose)" />
        <span className="size-1.5 rounded-full bg-(--tone-sage)" />
        <span className="size-1.5 rounded-full bg-(--tone-iris)" />
      </div>
    </div>
  );
}

/** A palette's day and night side by side, in its own colours. */
function Swatch({ palette }: { palette: PaletteChoice }) {
  return (
    <div
      data-palette={palette}
      aria-hidden="true"
      className="grid aspect-[16/9] grid-cols-2 overflow-hidden rounded-lg border border-(--rush-base)"
    >
      <Scheme scheme="light" />
      <Scheme scheme="dark" />
    </div>
  );
}

const TILE =
  "grid gap-2 rounded-xl border border-rush bg-surface p-1.5 pb-2 transition-[background-color,border-color,box-shadow,scale] duration-(--duration-quick) ease-fade";

/** A choosable palette: its swatch, radio and name, the whole tile one label. */
function PaletteTile({
  value,
  name,
  editing = false,
  action,
}: {
  value: PaletteChoice;
  name: string;
  editing?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="relative min-w-0">
      <label
        className={cn(
          TILE,
          "cursor-pointer hover:bg-surface-hover active:scale-(--press-scale) has-data-checked:border-dusk-line has-data-checked:shadow-[0_0_0_1px_var(--dusk-line)]",
          editing && "border-dashed border-dusk-line",
        )}
      >
        <Swatch palette={value} />
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 px-1 text-ink text-ui",
            action !== undefined && "pr-12",
          )}
        >
          <Radio value={value} />
          <span className="truncate">{name}</span>
        </span>
      </label>
      {action}
    </div>
  );
}

/**
 * Settings > Appearance > Palette, named by the row's label (`labelId`):
 * the six built-ins and, in a row that
 * opens below them, up to three of the player's own: one choice over two
 * radio groups in a 3x3 grid (2 columns on phones). Saved ones are edited in place; the
 * one New tile starts another from any palette. Opening an editor while
 * another has unsaved changes asks first.
 */
export function PalettePicker({ labelId }: { labelId: string }) {
  const { palette, setPalette } = useTheme();
  const scheme = useScheme();
  const list = useQuery(customPalettesQuery);
  const customs = list.data ?? [];
  const draft = usePaletteDraft();
  const [open, setOpen] = useState(() => isCustomPalette(palette));
  const [pending, setPending] = useState<(() => void) | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const ownLabelId = useId();
  const answerId = useId();

  /** Runs `act` at once, or after the player agrees to discard the draft's unsaved changes. */
  const guard = (act: () => void) => {
    if (currentDraft()?.dirty === true) setPending(() => act);
    else act();
  };
  const openEditor = (act: () => void) =>
    guard(() => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      act();
    });
  // Focus returns to what opened the editor, or, once that is gone (a New
  // tile that became the saved palette), to the row above the palettes.
  const closeEditor = () => {
    closeDraft();
    const back = opener.current?.isConnected ? opener.current : trigger.current;
    opener.current = null;
    back?.focus();
  };

  const saved = (slot: CustomSlot) => customs.find((custom) => custom.slot === slot);
  const newDraft = draft !== null && !draft.saved ? draft : null;
  const freeSlot = CUSTOM_SLOTS.find((slot) => saved(slot) === undefined);
  const selected = isCustomPalette(palette) ? saved(customPaletteSlot(palette)) : undefined;
  const names = customs.map((custom) => custom.name);
  const answer =
    names.length === 0
      ? "None yet. Start one from any palette above."
      : selected !== undefined && !open
        ? `Using ${selected.name}.`
        : names.length === CUSTOM_SLOTS.length
          ? `${names.join(", ")}. All three slots are used.`
          : `${names.join(", ")}.`;

  const startFrom = (slot: CustomSlot, base: PaletteChoice) =>
    openEditor(() =>
      startDraft(slot, paletteName(base, customs), base, paletteColours(base, customs), scheme),
    );

  return (
    <div className="grid gap-2">
      {/* The checked swatch changes inside the Transition, which starts React's view transition. */}
      <ViewTransition>
        {/*
          Two radio groups over one choice, in reading order: the built-ins, the
          row that opens the player's own, then those. The grid holds both, so
          they line up as one 3x3 (2 columns on phones).
        */}
        <Collapsible.Root
          open={open || draft !== null}
          onOpenChange={setOpen}
          className="grid grid-cols-2 gap-3 tablet:grid-cols-3"
        >
          <RadioGroup<PaletteChoice>
            aria-labelledby={labelId}
            value={palette}
            onValueChange={(next) => {
              if (isChoice(next) && next !== palette) setPalette(next);
            }}
            className="contents"
          >
            {PALETTES.map((value) => (
              <PaletteTile key={value} value={value} name={BUILT_IN_NAMES[value]} />
            ))}
          </RadioGroup>
          <Collapsible.Trigger
            ref={trigger}
            aria-describedby={answerId}
            className="group/row col-span-full -mx-2 grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-2.5 text-left outline-none hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--dusk-line)] touch:min-h-14"
          >
            <span className="grid min-w-0 gap-0.5">
              <span id={ownLabelId} className="font-medium text-ink text-ui">
                Your palettes
              </span>
              <span id={answerId} className="text-pretty text-note text-reed">
                {answer}
              </span>
            </span>
            <ChevronDownIcon
              size={16}
              className="mt-0.5 text-reed transition-[rotate] duration-(--duration-arrive) ease-spring group-data-panel-open/row:rotate-180 motion-reduce:transition-none"
            />
          </Collapsible.Trigger>
          <Collapsible.Panel className="col-span-full -m-1 grid h-(--collapsible-panel-height) grid-cols-subgrid gap-3 overflow-hidden p-1 transition-[height,opacity] duration-(--duration-panel-in) ease-spring data-ending-style:h-0 data-starting-style:h-0 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-[opacity] motion-reduce:duration-(--duration-quick) motion-reduce:ease-fade">
            <RadioGroup<PaletteChoice>
              aria-labelledby={ownLabelId}
              value={palette}
              onValueChange={(next) => {
                if (isChoice(next) && next !== palette) setPalette(next);
              }}
              className="contents"
            >
              {CUSTOM_SLOTS.map((slot) => {
                const custom = saved(slot);
                if (newDraft?.slot === slot) return <DraftTile key={slot} draft={newDraft} />;
                if (custom !== undefined) {
                  const editing = draft?.slot === slot;
                  return (
                    <PaletteTile
                      key={slot}
                      value={customPaletteId(slot)}
                      name={custom.name}
                      editing={editing}
                      action={
                        editing ? (
                          <span className="pointer-events-none absolute right-3 bottom-3 text-dusk-line text-meta">
                            Editing
                          </span>
                        ) : (
                          <Tooltip label="Edit" side="top">
                            <Button
                              size="icon"
                              aria-label={`Edit ${custom.name}`}
                              className="absolute right-1 bottom-1 size-8 touch:size-11"
                              onKeyDown={keepArrows}
                              onClick={() => openEditor(() => editSaved(custom, scheme))}
                            >
                              <EditIcon size={16} />
                            </Button>
                          </Tooltip>
                        )
                      }
                    />
                  );
                }
                // The one way to a new palette, once the saved ones are known.
                if (slot !== freeSlot || newDraft !== null || !list.isSuccess) return null;
                return (
                  <NewTile
                    key={slot}
                    customs={customs}
                    current={palette}
                    onChoose={(base) => startFrom(slot, base)}
                  />
                );
              })}
            </RadioGroup>
          </Collapsible.Panel>
        </Collapsible.Root>
      </ViewTransition>
      {draft !== null && (
        <PaletteEditor
          key={draft.session}
          customs={customs}
          onClose={closeEditor}
          coloursOf={(base) => paletteColours(base, customs)}
          nameOf={(base) => paletteName(base, customs)}
        />
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title="Discard this palette?"
        description="Its changes are not saved. Discarding puts the palette back as it was."
        confirm="Discard"
        cancel="Keep editing"
        onConfirm={() => {
          const act = pending;
          setPending(null);
          closeDraft();
          act?.();
        }}
      />
    </div>
  );
}

/** A palette being made, not saved yet: its live swatch, not choosable. */
function DraftTile({ draft }: { draft: PaletteDraft }) {
  return (
    <div className={cn(TILE, "border-dashed border-dusk-line")}>
      <Swatch palette={customPaletteId(draft.slot)} />
      <span className="flex min-w-0 items-center gap-2 px-1 text-ink text-ui">
        <span className="truncate">{draft.name.trim() || "New palette"}</span>
        <span className="ml-auto shrink-0 text-dusk-line text-meta">Editing</span>
      </span>
    </div>
  );
}

/** The one place a new palette starts: a menu of every palette to start from. */
function NewTile({
  customs,
  current,
  onChoose,
}: {
  customs: readonly CustomPalette[];
  current: PaletteChoice;
  onChoose: (base: PaletteChoice) => void;
}) {
  const builtIns = PALETTES.map((id) => ({ id, name: BUILT_IN_NAMES[id] }));
  const own = customs.map((custom) => ({ id: customPaletteId(custom.slot), name: custom.name }));
  const item = ({ id, name }: { id: PaletteChoice; name: string }) => (
    <MenuItem key={id} onClick={() => onChoose(id)}>
      <span className="flex-1">{name}</span>
      {id === current && <span className="text-meta text-reed">In use</span>}
    </MenuItem>
  );
  return (
    <Menu>
      <MenuTrigger
        onKeyDown={keepArrows}
        className={cn(
          TILE,
          "cursor-pointer text-left outline-none hover:bg-surface-hover focus-visible:shadow-[0_0_0_2px_var(--dusk-line)] active:scale-(--press-scale)",
        )}
      >
        <span
          aria-hidden="true"
          className="grid aspect-[16/9] grid-cols-2 overflow-hidden rounded-lg border border-rush"
        >
          <span />
          <span className="border-rush border-l" />
        </span>
        <span className="flex items-center gap-2 px-1 text-ink text-ui">
          <PlusIcon size={16} className="text-reed" />
          New palette
        </span>
      </MenuTrigger>
      <MenuContent label="Start from" align="start">
        <p className="px-2.5 pt-1.5 pb-1 text-meta text-reed">Start from</p>
        {builtIns.map(item)}
        {own.length > 0 && <MenuSeparator />}
        {own.map(item)}
      </MenuContent>
    </Menu>
  );
}
