import { CARD_FIELD_LABELS, CARD_LIMITS } from "@ephemera/core";
import { m } from "motion/react";
import { useId, useRef, useState } from "react";
import { MoreIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Unfold } from "@/components/ui/disclosure";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { ReviewField, useReview, useSettled } from "../rework/ReviewField.tsx";
import { useReworkLocked } from "../rework/session.ts";
import { TrackedText } from "../rework/TrackedText.tsx";
import { FIELD, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
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
  // Rework's Apply or Undo) has rows of its own.
  if (keys.length !== alternates.length) setKeys(alternates.map(newKey));
  const [open, setOpen] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ key: string; text: string; index: number } | null>(null);
  const firstId = useId();
  const list = useRef<HTMLOListElement>(null);
  const glide = useGlide();
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
          <label htmlFor={firstId} className="flex h-9 items-center font-medium text-ink text-ui">
            {CARD_FIELD_LABELS.firstMessage}
          </label>
          <ReviewField
            field={{ kind: "text", key: "firstMessage" }}
            label={CARD_FIELD_LABELS.firstMessage}
          >
            <textarea
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
          <span className="font-medium text-ink text-ui">
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
        {alternates.length > 0 && (
          <Glides>
            <ol
              ref={list}
              data-settle={settled ? "" : undefined}
              className="settle-glow grid grid-cols-[minmax(0,1fr)] border-rush border-t"
            >
              {alternates.map((text, index) => {
                const key = keys[index] ?? String(index);
                const number = index + 1;
                const label = `Alternate ${number}`;
                const tracked = review.items.filter(
                  (item) =>
                    item.change.field.kind === "alternate" && item.change.field.index === index,
                );
                return (
                  <m.li
                    key={key}
                    data-key={key}
                    className="border-rush border-b bg-canvas"
                    {...glide}
                  >
                    {base !== null && tracked.length > 0 ? (
                      <div className="grid gap-2 py-3">
                        <div className="flex items-center gap-1">
                          <span className="flex min-h-9 min-w-0 flex-1 items-center font-medium text-ink text-ui touch:min-h-11">
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
                            <textarea
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
                  </m.li>
                );
              })}
            </ol>
          </Glides>
        )}
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
                <span className="flex min-h-9 items-center font-medium text-ink text-ui touch:min-h-11">
                  New alternate
                </span>
                <TrackedText text="" items={[item]} label="New alternate" />
              </li>
            ))}
          </ol>
        )}
        {removed !== null && (
          <p role="status" className="flex items-center gap-2 text-note text-reed arrive">
            Alternate {removed.index + 1} removed.
            <Button size="text" className="text-ink" disabled={locked} onClick={undo}>
              Undo
            </Button>
          </p>
        )}
      </div>
    </section>
  );
}
