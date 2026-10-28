import {
  type AnswerBlock,
  type BlockTokens,
  type CardAnswer,
  CREATOR_TAGS,
  type CreatorKind,
  SCENARIO_BLOCKS,
} from "@ephemera/core";
import { type ReactNode, useId, useState } from "react";
import { DisclosureChevron } from "@/components/ui/disclosure";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/text";
import { CardProse } from "./CardLayout.tsx";
import { blockTitle, SUBJECT_PARTS } from "./sections.ts";

/*
 * The finished card's text in the showcase, in the character's voice: the
 * opening at the story's measure, the tags, and the blocks as disclosure
 * rows. Card text is untrusted and stays inert: plain text, or the
 * tightened renderer (CardProse).
 */

/** The card's one tag, set by its kind, as the existing tag chips. */
export function TagChips({ kind }: { kind: CreatorKind }) {
  return (
    <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
      <li className="flex h-7 items-center rounded-md bg-surface-selected px-2.5 text-ink text-note">
        {CREATOR_TAGS[kind]}
      </li>
    </ul>
  );
}

/** "Opening" as story prose at the chat's measure. */
function Opening({ text }: { text: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid max-w-measure gap-3">
      <h3 id={headingId} className="flex min-h-8 items-center font-medium text-ink text-ui">
        Opening
      </h3>
      <CardProse text={text} streaming={false} />
    </section>
  );
}

/** One block as a disclosure row on the canvas, under a hairline. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="disclosure border-rush border-t">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 font-medium text-ink text-ui touch:min-h-13 [&::-webkit-details-marker]:hidden">
        {label}
        <DisclosureChevron className="text-reed" />
      </summary>
      <div className="grid gap-5 pb-6">{children}</div>
    </details>
  );
}

const partText = (block: AnswerBlock | undefined, name: string) =>
  block?.blocks.find((inner) => inner.name === name)?.text ?? "";

/** The estimate against its cap; over the cap in ember, with why it still keeps. */
function TokenLine({ tokens }: { tokens: BlockTokens | undefined }) {
  if (tokens === undefined) return null;
  const over = tokens.tokens > tokens.cap;
  return (
    <p className={cn("border-rush border-t pt-4 text-note", over ? "text-ember" : "text-reed")}>
      {formatCount(tokens.tokens)} of {formatCount(tokens.cap)} tokens
      {over &&
        ". Over the budget: it takes more of each reply's context, and it can still be kept."}
    </p>
  );
}

/** With several subjects: which one the rows show, by full name, with "1 of 3". */
function SubjectPicker({
  subjects,
  shown,
  onShow,
}: {
  subjects: AnswerBlock[];
  shown: number;
  onShow: (index: number) => void;
}) {
  const labelId = useId();
  const items = Object.fromEntries(
    subjects.map((block, index) => [String(index), blockTitle(block.name)]),
  );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span id={labelId} className="font-medium text-ink text-ui">
        Subject
      </span>
      <Select
        items={items}
        value={String(shown)}
        onValueChange={(value) => {
          if (typeof value === "string") onShow(Number(value));
        }}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          placeholder="Choose a subject"
          className="w-auto min-w-0 max-w-72 flex-1 tablet:w-64 tablet:flex-none"
        />
        <SelectContent label="Subjects" className="min-w-64">
          {subjects.map((block, index) => (
            <SelectItem key={block.name} value={String(index)}>
              {blockTitle(block.name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-note text-reed tabular-nums">
        {shown + 1} of {subjects.length}
      </span>
    </div>
  );
}

/**
 * The content column after the name: the opening, the
 * tags (after the opening on phones; with the name elsewhere), then the
 * blocks as disclosure rows, the subject picker when there are several, and
 * the token count against its cap.
 */
export function ShowcaseText({
  kind,
  answer,
  tokens,
  phone,
}: {
  kind: CreatorKind;
  answer: CardAnswer;
  tokens: BlockTokens[];
  phone: boolean;
}) {
  const [subject, setSubject] = useState(0);
  const block = answer.blocks[subject];
  const find = (name: string) => answer.blocks.find((candidate) => candidate.name === name);

  return (
    <div className="grid gap-8">
      <Opening text={answer.firstMessage.text} />
      {phone && <TagChips kind={kind} />}
      {kind !== "scenario" ? (
        <div className="grid">
          {answer.blocks.length > 1 && (
            <div className="pb-4">
              <SubjectPicker subjects={answer.blocks} shown={subject} onShow={setSubject} />
            </div>
          )}
          {SUBJECT_PARTS.map(([name, label]) => (
            <Row key={`${block?.name}/${name}`} label={label}>
              <CardProse text={partText(block, name)} streaming={false} />
            </Row>
          ))}
          <TokenLine tokens={tokens.find((counted) => counted.block === block?.name)} />
        </div>
      ) : (
        <div className="grid">
          {SCENARIO_BLOCKS.map((name) => (
            <Row key={name} label={name}>
              <CardProse text={find(name)?.text ?? ""} streaming={false} />
            </Row>
          ))}
          <TokenLine tokens={tokens.find((counted) => counted.block === "description")} />
        </div>
      )}
    </div>
  );
}
