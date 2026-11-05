import { CARD_FIELD_LABELS, CARD_LIMITS } from "@ephemera/core";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { type ReactNode, useId, useRef, useState } from "react";
import { fade, spring } from "@/app/motion.tsx";
import { InlineStatus } from "@/app/NoticeCard.tsx";
import { useReducedMotion } from "@/app/reduced-motion.ts";
import { MoreIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Unfold } from "@/components/ui/disclosure";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { ReviewField, useReview, useSettled } from "../rework/ReviewField.tsx";
import { useReworkLocked } from "../rework/session.ts";
import { TrackedText } from "../rework/TrackedText.tsx";
import { AuthoringField } from "../sheet/FieldFeedback.tsx";
import { FIELD, FIELD_LABEL, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
import {
  CloseRow,
  Glides,
  MoveButtons,
  MoveToPosition,
  moved,
  OpenRow,
  useGlide,
} from "../sheet/ordering.tsx";

type Change = { firstMessage?: string; alternateGreetings?: string[] };

const newKey = (): string => crypto.randomUUID();

/**
 * The first message stays open; alternates are rows with a number and a
 * one-line preview, one open at a time. Order is the swipe order. Removing an
 * alternate can be undone until the next removal or leaving the sheet.
 * Read-only while an AI Rework works or is under review; then an alternate
 * the review changes or removes opens as its tracked view, and greetings it
 * adds follow the list as new rows.
 */
export function Greetings({
  first,
  alternates,
  onChange,
}: {
  first: string;
  alternates: string[];
  onChange: (change: Change) => void;
}) {
  const [keys, setKeys] = useState(() => alternates.map(newKey));
  // Every change made here keys its rows with it; a list that changed from outside (an AI
  // Rework's Apply or Undo) has rows of its own, which replace the old ones without folding.
  const [outside, setOutside] = useState(0);
  if (keys.length !== alternates.length) {
    setKeys(alternates.map(newKey));
    setOutside(outside + 1);
  }
  const [open, setOpen] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ key: string; text: string; index: number } | null>(null);
  const firstId = useId();
  const list = useRef<HTMLOListElement>(null);
  const locked = useReworkLocked();
  const review = useReview();
  const settled = useSettled("alternateGreetings");
  const base = review.base;
  const added = review.items.filter((item) => item.change.field.kind === "alternate_new");

  /** Reorders at once; the moved row glides (ordering.tsx).*/
  const rearrange = (nextKeys: string[], nextAlternates: string[], nextFirst?: string) => {
    setKeys(nextKeys);
    onChange({
      alternateGreetings: nextAlternates,
      ...(nextFirst === undefined ? {} : { firstMessage: nextFirst }),
    });
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= alternates.length || from === to) return;
    rearrange(moved(keys, from, to), moved(alternates, from, to));
  };

  const add = () => {
    if (alternates.length >= CARD_LIMITS.alternateGreetings) return;
    const key = newKey();
    setKeys([...keys, key]);
    setOpen(key);
    onChange({ alternateGreetings: [...alternates, ""] });
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLTextAreaElement>(`[data-key="${key}"] textarea`)?.focus(),
    );
  };

  const remove = (index: number) => {
    const key = keys[index];
    const text = alternates[index];
    if (key === undefined || text === undefined) return;
    setRemoved({ key, text, index });
    setKeys(keys.filter((_, i) => i !== index));
    onChange({ alternateGreetings: alternates.filter((_, i) => i !== index) });
  };

  const undo = () => {
    if (removed === null) return;
    const at = Math.min(removed.index, alternates.length);
    setKeys([...keys.slice(0, at), removed.key, ...keys.slice(at)]);
    onChange({
      alternateGreetings: [...alternates.slice(0, at), removed.text, ...alternates.slice(at)],
    });
    setOpen(removed.key);
    setRemoved(null);
  };

  /** Swaps an alternate with the first message. */
  const makeFirst = (index: number) => {
    const text = alternates[index];
    if (text === undefined) return;
    const nextAlternates = alternates.map((item, i) => (i === index ? first : item));
    rearrange(keys, nextAlternates, text);
  };

  const moveTo = (from: number, position: number) => {
    if (Number.isInteger(position)) {
      move(from, Math.max(1, Math.min(position, alternates.length)) - 1);
    }
    setMoving(null);
  };

  return (
    <section id="s-greetings" aria-labelledby={`${firstId}-heading`} className={SHEET_GRID}>
      <h2 id={`${firstId}-heading`} className={sheetLabel()}>
        Greetings
      </h2>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <div className="grid gap-1.5">
          <label htmlFor={firstId} className={cn(FIELD_LABEL, "flex h-9 items-center")}>
            {CARD_FIELD_LABELS.firstMessage}
          </label>
          <ReviewField
            field={{ kind: "text", key: "firstMessage" }}
            label={CARD_FIELD_LABELS.firstMessage}
          >
            <AuthoringField
              id={firstId}
              value={first}
              placeholder="How the story opens"
              rows={2}
              maxLength={CARD_LIMITS.textLength}
              readOnly={locked}
              aria-readonly={locked || undefined}
              onChange={(event) => onChange({ firstMessage: event.target.value })}
              className={FIELD}
            />
          </ReviewField>
        </div>
        <div className="flex h-9 items-center justify-between">
          <span className={FIELD_LABEL}>
            Alternates
            {alternates.length > 0 && (
              <span className="ml-2 font-normal text-meta text-reed tabular-nums">
                {alternates.length}
              </span>
            )}
          </span>
          <Button
            onClick={add}
            disabled={locked || alternates.length >= CARD_LIMITS.alternateGreetings}
          >
            <PlusIcon size={16} />
            Add alternate
          </Button>
        </div>
        <Glides>
          {/* Kept while a removed last row folds away; empty, it draws no line. */}
          <ol
            ref={list}
            data-settle={settled ? "" : undefined}
            className="settle-glow grid grid-cols-[minmax(0,1fr)] border-rush border-t empty:hidden"
          >
            <AnimatePresence key={outside} initial={false}>
              {alternates.map((text, index) => {
                const key = keys[index] ?? String(index);
                const number = index + 1;
                const label = `Alternate ${number}`;
                const tracked = review.items.filter(
                  (item) =>
                    item.change.field.kind === "alternate" && item.change.field.index === index,
                );
                return (
                  <GreetingRow key={key} rowKey={key}>
                    {base !== null && tracked.length > 0 ? (
                      <div className="grid gap-2 py-3">
                        <div className="flex items-center gap-1">
                          <span
                            className={cn(
                              FIELD_LABEL,
                              "flex min-h-9 min-w-0 flex-1 items-center  touch:min-h-11",
                            )}
                          >
                            {label}
                          </span>
                          <MoveButtons
                            earlierLabel={`Move ${label} earlier`}
                            laterLabel={`Move ${label} later`}
                            canMoveEarlier={false}
                            canMoveLater={false}
                            onEarlier={() => {}}
                            onLater={() => {}}
                          />
                          <Button size="icon" aria-label={`More for ${label}`} disabled>
                            <MoreIcon />
                          </Button>
                        </div>
                        <TrackedText
                          text={base.alternateGreetings[index] ?? text}
                          items={tracked}
                          label={label}
                        />
                      </div>
                    ) : (
                      // Opening one folds its row away as its editor unfolds, so the height eases.
                      <>
                        <Unfold show={open !== key}>
                          <OpenRow
                            label={`${label}: ${text === "" ? "empty" : text.slice(0, 80)}`}
                            onOpen={() => setOpen(key)}
                            className="h-11 px-1 touch:h-12"
                          >
                            <span className="w-6 shrink-0 text-right text-meta text-reed tabular-nums">
                              {number}
                            </span>
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate text-ui",
                                text === "" ? "text-reed" : "text-narration",
                              )}
                            >
                              {text === "" ? "Empty" : text}
                            </span>
                          </OpenRow>
                        </Unfold>
                        <Unfold show={open === key}>
                          <div className="grid gap-2 py-3">
                            <div className="flex items-center gap-1">
                              {moving === key ? (
                                <MoveToPosition
                                  current={number}
                                  count={alternates.length}
                                  onMove={(position) => moveTo(index, position)}
                                  onCancel={() => setMoving(null)}
                                />
                              ) : (
                                <>
                                  <CloseRow onClose={() => setOpen(null)}>{label}</CloseRow>
                                  <MoveButtons
                                    earlierLabel={`Move ${label} earlier`}
                                    laterLabel={`Move ${label} later`}
                                    canMoveEarlier={!locked && index > 0}
                                    canMoveLater={!locked && index < alternates.length - 1}
                                    onEarlier={() => move(index, index - 1)}
                                    onLater={() => move(index, index + 1)}
                                  />
                                  <Menu>
                                    <MenuTrigger
                                      disabled={locked}
                                      render={
                                        <Button size="icon" aria-label={`More for ${label}`} />
                                      }
                                    >
                                      <MoreIcon />
                                    </MenuTrigger>
                                    <MenuContent label={`${label} actions`}>
                                      <MenuItem onClick={() => makeFirst(index)}>
                                        Use as first message
                                      </MenuItem>
                                      <MenuItem
                                        disabled={alternates.length < 2}
                                        onClick={() => setMoving(key)}
                                      >
                                        Move to position
                                      </MenuItem>
                                      <MenuSeparator />
                                      <MenuItem danger onClick={() => remove(index)}>
                                        Remove
                                      </MenuItem>
                                    </MenuContent>
                                  </Menu>
                                </>
                              )}
                            </div>
                            <AuthoringField
                              id={`${firstId}-${key}`}
                              aria-label={label}
                              value={text}
                              rows={2}
                              maxLength={CARD_LIMITS.textLength}
                              readOnly={locked}
                              aria-readonly={locked || undefined}
                              onChange={(event) =>
                                onChange({
                                  alternateGreetings: alternates.map((item, i) =>
                                    i === index ? event.target.value : item,
                                  ),
                                })
                              }
                              className={FIELD}
                            />
                          </div>
                        </Unfold>
                      </>
                    )}
                  </GreetingRow>
                );
              })}
            </AnimatePresence>
          </ol>
        </Glides>
        {base !== null && added.length > 0 && (
          <ol
            aria-label="New alternates"
            className={cn(
              "grid grid-cols-[minmax(0,1fr)] border-rush",
              alternates.length === 0 && "border-t",
            )}
          >
            {added.map((item) => (
              <li
                key={item.change.at}
                className="change-arrive grid gap-2 border-rush border-b py-3"
              >
                <span className={cn(FIELD_LABEL, "flex min-h-9 items-center  touch:min-h-11")}>
                  New alternate
                </span>
                <TrackedText text="" items={[item]} label="New alternate" />
              </li>
            ))}
          </ol>
        )}
        {removed !== null && (
          <InlineStatus
            as="p"
            role="status"
            className="arrive"
            actions={
              <Button size="text" className="text-ink" disabled={locked} onClick={undo}>
                Undo
              </Button>
            }
          >
            Alternate {removed.index + 1} removed.
          </InlineStatus>
        )}
      </div>
    </section>
  );
}

/**
 * One alternate's row: it glides to a new place, grows in when added back,
 * and folds away when removed, with its last contents and inert at once.
 * Under reduced motion it keeps its height through the fade.
 */
function GreetingRow({ rowKey, children }: { rowKey: string; children: ReactNode }) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const glide = useGlide();
  const duration = present ? "--duration-panel-in" : "--duration-panel-out";
  return (
    <m.li
      data-key={rowKey}
      inert={!present}
      aria-hidden={!present || undefined}
      layout={glide.layout}
      initial={{ height: reduced ? "auto" : 0, opacity: 0, overflow: "clip" }}
      animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
      exit={{ height: reduced ? "auto" : 0, opacity: 0, overflow: "clip" }}
      transition={{ ...glide.transition, height: spring(duration), opacity: fade(duration) }}
      className="border-rush border-b bg-canvas"
    >
      {children}
    </m.li>
  );
}
