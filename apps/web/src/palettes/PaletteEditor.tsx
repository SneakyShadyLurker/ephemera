import { Collapsible } from "@base-ui/react/collapsible";
import {
  builtInBase,
  type ContrastShortfall,
  type CustomPalette,
  contrastShortfalls,
  customPaletteId,
  isCustomPalette,
  PALETTE_NAME_LENGTH,
  PALETTES,
  type PaletteChoice,
  type PaletteRole,
  type PaletteScheme,
} from "@ephemera/core";
import { useBlocker } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon, MoonIcon, SunIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { scrollBehavior } from "../app/reduced-motion.ts";
import { useTheme } from "../app/theme.tsx";
import { CardProse } from "../creator/CardLayout.tsx";
import { applySettings, currentSettings } from "../settings/settings.ts";
import { FIELD } from "../sheet/fields.ts";
import { identity } from "../signin/identity.ts";
import { ColourField, shortfallText } from "./ColourField.tsx";
import {
  closeDraft,
  currentDraft,
  draftInput,
  markSaved,
  moveDraft,
  renameDraft,
  showScheme,
  startOver,
  stillOpen,
  usePaletteDraft,
} from "./draft.ts";
import { deleteCustomPalette, saveCustomPalette } from "./queries.ts";
import {
  BUILT_IN_NAMES,
  FOLLOWS,
  isFollowing,
  KEY_GROUPS,
  MORE_GROUPS,
  ROLE_LABELS,
} from "./roles.ts";

type Scheme = "light" | "dark";

const SCHEME_WORDS = { light: "By day", dark: "By night" } as const;

const HELP = "text-pretty text-note text-reed";

/** A synthetic scene in every voice and highlight; nothing of a chat. */
const SAMPLE = `Mara (31): *She sets the lantern down on the sill.* "You came back. :rose[Mind the blue tin], and :sage[the third stair creaks]."

Mara (31): :thought[Older than his letters made him sound.]

The wind worries at the shutters. :iris[A gull cries over the water.] :mist[The light turns, and turns.]`;

const fieldId = (slot: number, role: PaletteRole) => `palette-${slot}-${role}`;

/**
 * Editing a custom palette, below the picker: its name, the scheme being
 * edited (which the whole app shows meanwhile), a scene in every voice,
 * the key colours and, under All colours, the rest. Colours under their
 * contrast floors are named, by scheme, and save anyway. Nothing is saved
 * until Save; Cancel or Escape puts the saved palette back.
 */
export function PaletteEditor({
  customs,
  onClose,
  coloursOf,
  nameOf,
}: {
  customs: readonly CustomPalette[];
  onClose: () => void;
  coloursOf: (base: PaletteChoice) => Record<Scheme, PaletteScheme>;
  nameOf: (base: PaletteChoice) => string;
}) {
  const draft = usePaletteDraft();
  const { palette, setPalette, followPalette } = useTheme();
  const heading = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const nameId = useId();
  const [allOpen, setAllOpen] = useState(false);
  /** A save or a delete on its way: one at a time, so their answers cannot cross. */
  const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [nameMissing, setNameMissing] = useState(false);
  const [restart, setRestart] = useState<PaletteChoice | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Opening moves focus to the editor's heading, without summoning a keyboard.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, []);

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      const open = currentDraft();
      if (open === null) return false;
      if (open.dirty) return true;
      closeDraft();
      return false;
    },
    enableBeforeUnload: identity.guard(() => currentDraft()?.dirty === true),
    withResolver: true,
  });

  if (draft === null) return null;
  const { scheme, slot } = draft;
  const id = customPaletteId(slot);
  const shortfalls = {
    light: contrastShortfalls(draft.light),
    dark: contrastShortfalls(draft.dark),
  };
  const shortOf = (role: PaletteRole) => shortfalls[scheme].find((short) => short.role === role);
  const handSetCount = draft.handSet[scheme].length;

  const save = async () => {
    if (draft.name.trim() === "") {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    const submitted = draft;
    setBusy("saving");
    setFailed(null);
    const result = await saveCustomPalette(
      slot,
      draftInput(submitted),
      submitted.saved ? submitted.updatedAt : null,
    );
    setBusy(null);
    // An editor closed or reopened meanwhile is another session: the answer leaves it be.
    if (!stillOpen(submitted)) return;
    if (!result.ok) {
      const free = result.slotTaken?.free;
      if (free !== undefined) moveDraft(submitted, free);
      setFailed(
        result.slotTaken
          ? free === undefined
            ? `Not saved: ${result.reason}, and all three slots are used now. Delete one to keep this palette.`
            : `Not saved: ${result.reason}. It moves to the next free slot; save again to keep it.`
          : `Not saved: ${result.reason}. Your changes are still here.`,
      );
      return;
    }
    // A new palette is chosen as it closes, in one commit: it already shows.
    if (!submitted.saved) setPalette(customPaletteId(result.palette.slot), false);
    if (markSaved(submitted, result.palette)) onClose();
  };

  const remove = async () => {
    const submitted = draft;
    setBusy("deleting");
    setFailed(null);
    const result = await deleteCustomPalette(slot, submitted.updatedAt ?? 0);
    setBusy(null);
    if (!result.ok) {
      if (stillOpen(submitted)) setFailed(`Not deleted: ${result.reason}.`);
      return;
    }
    // Only this tab's own choice of it changes, to the palette it started from.
    if (currentSettings().palette === id) {
      const fallback = builtInBase(submitted.base);
      applySettings({ palette: fallback });
      followPalette(fallback);
    }
    if (stillOpen(submitted)) onClose();
  };

  /** Shows a colour the summary names: its scheme, All colours if it lives there, then the field. */
  const reveal = (short: ContrastShortfall, inScheme: Scheme) => {
    showScheme(inScheme);
    if (isFollowing(short.role)) setAllOpen(true);
    requestAnimationFrame(() => {
      const field = document.getElementById(fieldId(slot, short.role));
      field?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
      field?.querySelector("input")?.focus({ preventScroll: true });
    });
  };

  const field = (role: PaletteRole) => (
    <ColourField
      key={`${scheme}-${role}`}
      id={fieldId(slot, role)}
      role={role}
      value={draft[scheme][role]}
      shortfall={shortOf(role)}
      {...(isFollowing(role)
        ? {
            follows: {
              key: ROLE_LABELS[FOLLOWS[role]],
              handSet: draft.handSet[scheme].includes(role),
            },
          }
        : {})}
    />
  );

  const restartChoices: PaletteChoice[] = [
    ...PALETTES,
    ...customs.map((custom) => customPaletteId(custom.slot)).filter((other) => other !== id),
  ];

  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      className="grid max-w-xl gap-5 rounded-xl border border-rush bg-surface p-4 transition-[opacity,translate] duration-(--duration-panel-in) ease-spring starting:translate-y-(--rise) starting:opacity-0 tablet:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3
            ref={heading}
            id={headingId}
            tabIndex={-1}
            className="font-semibold text-ink text-lead outline-none"
          >
            {draft.saved ? `Edit ${draft.name.trim() || "palette"}` : "New palette"}
          </h3>
          <p className={HELP}>
            Started from {nameOf(draft.base)}. The whole app shows it while you edit.
          </p>
        </div>
        <Menu>
          <MenuTrigger render={<Button variant="quiet" className="shrink-0" />}>
            Start over
          </MenuTrigger>
          <MenuContent label="Start over from">
            <p className="px-2.5 pt-1.5 pb-1 text-meta text-reed">Start over from</p>
            {restartChoices.map((choice, index) => (
              <Fragment key={choice}>
                {index === PALETTES.length && <MenuSeparator />}
                <MenuItem onClick={() => setRestart(choice)}>
                  {isCustomPalette(choice) ? nameOf(choice) : BUILT_IN_NAMES[choice]}
                </MenuItem>
              </Fragment>
            ))}
          </MenuContent>
        </Menu>
      </div>

      <div className="grid gap-4 tablet:grid-cols-[minmax(0,1fr)_auto] tablet:items-end">
        <div className="grid gap-1.5">
          <label htmlFor={nameId} className="font-medium text-ink text-ui">
            Name
          </label>
          <input
            ref={nameRef}
            id={nameId}
            value={draft.name}
            maxLength={PALETTE_NAME_LENGTH}
            aria-invalid={nameMissing || undefined}
            onChange={(event) => {
              setNameMissing(false);
              renameDraft(event.target.value);
            }}
            className={cn(FIELD, "h-10 py-0 text-ui touch:h-11")}
          />
          {nameMissing && <p className="text-meta text-ember">Name it before saving.</p>}
        </div>
        <div className="grid gap-1.5">
          <span className="font-medium text-ink text-ui">Editing scheme</span>
          <ToggleGroup
            aria-label="Editing scheme"
            className="w-fit"
            value={[scheme]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "light" || next === "dark") showScheme(next);
            }}
          >
            <ToggleGroupItem value="light" labelled>
              <SunIcon size={16} />
              Day
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" labelled>
              <MoonIcon size={16} />
              Night
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <figure
        aria-label="Sample scene"
        className="grid gap-3 rounded-lg border border-rush bg-canvas px-4 py-3.5"
      >
        <p className="slip text-line text-ink">The tide is turning. Are you coming in?</p>
        <div className="voice-scene [&_blockquote]:my-0">
          <CardProse text={SAMPLE} streaming={false} />
        </div>
        {/* Pictures of the two button styles, not controls. */}
        <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
          <span className={buttonVariants({ variant: "primary" })}>Send</span>
          <span className={buttonVariants({ variant: "outline" })}>New reply</span>
        </div>
      </figure>

      {KEY_GROUPS.map((group) => (
        <fieldset key={group.title} className="grid gap-3">
          <legend className="mb-1 grid gap-0.5">
            <span className="font-medium text-ink text-ui">{group.title}</span>
            <span className={HELP}>{group.note}</span>
          </legend>
          <div className="grid gap-3 tablet:grid-cols-2">{group.roles.map(field)}</div>
        </fieldset>
      ))}

      <Collapsible.Root open={allOpen} onOpenChange={setAllOpen} className="border-rush border-t">
        <Collapsible.Trigger className="group/all -mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-3 text-left outline-none hover:bg-surface-hover focus-visible:shadow-[inset_0_0_0_2px_var(--dusk-line)] touch:min-h-14">
          <span className="grid flex-1 gap-0.5">
            <span className="font-medium text-ink text-ui">All colours</span>
            <span className={HELP}>
              {handSetCount === 0
                ? "Every other colour follows the ones above."
                : `${handSetCount} set by you ${scheme === "light" ? "by day" : "by night"}; the rest follow the ones above.`}
            </span>
          </span>
          <ChevronDownIcon
            size={16}
            className="text-reed transition-[rotate] duration-(--duration-arrive) ease-spring group-data-panel-open/all:rotate-180 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
        <Collapsible.Panel className="-mx-1.5 h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-panel-in) ease-spring data-ending-style:h-0 data-starting-style:h-0 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-[opacity] motion-reduce:duration-(--duration-quick) motion-reduce:ease-fade">
          <div className="grid gap-5 px-1.5 pt-1 pb-2">
            {MORE_GROUPS.map((group) => (
              <fieldset key={group.title} className="grid gap-3">
                <legend className="mb-1 font-medium text-ink text-ui">{group.title}</legend>
                <div className="grid gap-3 tablet:grid-cols-2">{group.roles.map(field)}</div>
              </fieldset>
            ))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>

      <Summary shortfalls={shortfalls} onReveal={reveal} />

      {failed && (
        <p role="alert" className="text-ember text-note">
          {failed}
        </p>
      )}

      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 rounded-b-xl border-rush border-t bg-surface px-4 py-3 tablet:static tablet:mx-0 tablet:mb-0 tablet:border-0 tablet:bg-transparent tablet:p-0">
        {draft.saved && (
          <Button variant="danger" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy !== null} onClick={() => void save()}>
          {busy === "saving" ? "Saving" : "Save palette"}
        </Button>
      </div>

      <ConfirmDialog
        open={restart !== null}
        onOpenChange={(open) => !open && setRestart(null)}
        title={restart === null ? "" : `Start over from ${nameOf(restart)}?`}
        description={`Both Day and Night take ${restart === null ? "its" : `${nameOf(restart)}'s`} colours, and colours you set by hand follow again. The name stays.`}
        confirm="Start over"
        cancel="Keep these colours"
        tone="primary"
        onConfirm={() => {
          if (restart !== null) startOver(restart, coloursOf(restart));
          setRestart(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${draft.name.trim() || "this palette"}?`}
        description={
          palette === id
            ? `It is removed from this server. The app goes back to ${BUILT_IN_NAMES[builtInBase(draft.base)]}.`
            : "It is removed from this server."
        }
        confirm="Delete"
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Discard this palette?"
        description="Its changes are not saved. Leaving puts the palette back as it was."
        confirm="Discard"
        cancel="Keep editing"
        onCancel={() => blocker.reset?.()}
        onConfirm={() => {
          closeDraft();
          blocker.proceed?.();
        }}
      />
    </section>
  );
}

/** Which colours may be hard to read, by scheme, each a way to its field. Advice, never a refusal. */
function Summary({
  shortfalls,
  onReveal,
}: {
  shortfalls: Record<Scheme, ContrastShortfall[]>;
  onReveal: (short: ContrastShortfall, scheme: Scheme) => void;
}) {
  const schemes = (["light", "dark"] as const).filter((scheme) => shortfalls[scheme].length > 0);
  return (
    <div role="status" className="grid gap-1.5">
      {schemes.length === 0 ? (
        <p className={HELP}>Every colour reads clearly by day and by night.</p>
      ) : (
        schemes.map((scheme) => (
          <p key={scheme} className="text-pretty text-ember text-note">
            {SCHEME_WORDS[scheme]},{" "}
            {shortfalls[scheme].length === 1
              ? "one colour may be hard to read:"
              : `${shortfalls[scheme].length} colours may be hard to read:`}{" "}
            {shortfalls[scheme].map((short, index) => (
              <span key={short.role}>
                {index > 0 && ", "}
                <button
                  type="button"
                  title={shortfallText(short)}
                  onClick={() => onReveal(short, scheme)}
                  className="rounded-sm underline underline-offset-2 outline-none hover:text-ink focus-visible:shadow-[0_0_0_2px_var(--dusk-line)]"
                >
                  {ROLE_LABELS[short.role]}
                </button>
              </span>
            ))}
            . It saves anyway.
          </p>
        ))
      )}
    </div>
  );
}
