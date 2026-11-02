import { Component, lazy, type ReactNode, type Ref, Suspense } from "react";
import { LamplightRim } from "@/components/lamplight.tsx";
import { cn } from "@/lib/cn";
import { LEAF_EDGE } from "../portraits/Portrait.tsx";
import type { CardRow } from "./sections.ts";

/*
 * The showcase's layout, shared by the card being written and the finished
 * card: the 2:3 frame in its own column (sticky beside the text from
 * tablet up, compact above it on phones) and the card's text in the
 * character's voice. Card text is untrusted: plain text, or the tightened
 * renderer with raw HTML off, images not loaded and links inert.
 */

const Markdown = lazy(() =>
  import("../chat/Markdown.tsx").then((module) => ({ default: module.Markdown })),
);

/** The card's prose: the story face at the story's size and measure. */
const PROSE = "voice-story prose-turn text-story-phone tablet:text-story";

function PlainText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap">{text}</p>;
}

/** If the renderer fails to load or to render, the text still shows, plain. */
class PlainTextFallback extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

export function CardProse({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={PROSE}>
      <PlainTextFallback text={text}>
        <Suspense fallback={<PlainText text={text} />}>
          <Markdown streaming={streaming}>{text}</Markdown>
        </Suspense>
      </PlainTextFallback>
    </div>
  );
}

/**
 * Short text that arrives word by word (the name, the tagline): each new
 * word fades in briefly and the earlier ones stay still. Under reduced
 * motion words appear at once.
 */
export function Words({ text }: { text: string }) {
  return text.split(/(\s+)/).map((word, index) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: words only append, so a growing last word keeps its span.
      key={index}
      className="transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0 motion-reduce:transition-none"
    >
      {word}
    </span>
  ));
}

/**
 * One pass of light along the lower edge of its positioned parent (styles.css
 * `lamplight-edge`): the brainstorm row being written.
 */
export function FrameEdge() {
  return <span aria-hidden="true" className="lamplight-edge" />;
}

/**
 * The 2:3 frame on the surface, and `progress` (0 to 1) as a thin dusk line
 * along its lower edge (a stage without a measure, `pending`, draws none). While its work runs (`busy`) the rim travels its
 * edge; when the work ends it closes if the work finished (`settled`) and
 * fades otherwise, then `onEnd`.
 */
export function CardFrame({
  progress,
  busy,
  settled,
  onEnd,
  children,
}: {
  progress?: number | "pending" | undefined;
  busy: boolean;
  settled: boolean;
  onEnd?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="relative isolate">
      <div className="@container relative grid aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface">
        {children}
        {typeof progress === "number" && (
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-dusk transition-[scale] duration-(--duration-panel-in) ease-fade"
            style={{ scale: `${Math.min(1, Math.max(0, progress))} 1` }}
          />
        )}
      </div>
      <LamplightRim busy={busy} settled={settled} onEnd={onEnd} />
    </div>
  );
}

/**
 * Without art: the name in the character's voice on the leaf, set as it
 * arrives, and under it what is happening, never a failure placard. The
 * leaf's hairline edge is the portrait's.
 */
export function NameLeaf({ name, caption }: { name: string; caption?: string | undefined }) {
  return (
    <>
      <span aria-hidden="true" className={cn("absolute inset-0 rounded-[inherit]", LEAF_EDGE)} />
      <div aria-hidden="true" className="relative grid gap-2 self-end p-[9%]">
        {name !== "" && (
          <span className="line-clamp-4 text-balance break-words font-[460] font-story text-[clamp(0.75rem,11cqi,1.3125rem)] text-narration italic leading-[1.25]">
            <Words text={name} />
          </span>
        )}
        {caption !== undefined && (
          <span
            key={caption}
            className="text-note text-reed transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
          >
            {caption}
          </span>
        )}
      </div>
    </>
  );
}

/** The result's frame (the card being written, the showcase), shared by the header and the Keep bar. */
export const CREATOR_FRAME = "mx-auto w-full max-w-creator px-5 tablet:px-6";

/**
 * The showcase's grid: one column on phones, and on tablets while the card's
 * column would fall below 24rem; then a 12rem frame column; on desktop 18rem
 * beside the story's 40rem measure. Classes that apply only with the columns
 * side by side use `@card:`; the grid's parent is its `@container`.
 */
export const SHOWCASE_GRID = `${CREATOR_FRAME} grid grid-cols-[minmax(0,1fr)] gap-6 pt-4 pb-16 tablet:gap-10 tablet:pt-8 @card:max-desktop:grid-cols-[12rem_minmax(0,1fr)] desktop:grid-cols-[minmax(0,18rem)_minmax(0,40rem)] desktop:gap-14`;

/** Frame column and card column; `actions` sit under the frame when the columns stand side by side. */
export function CardLayout({
  frame,
  actions,
  children,
}: {
  frame: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container">
      <div className={SHOWCASE_GRID}>
        <aside className="grid content-start justify-items-center gap-4 @card:sticky @card:top-8 @card:self-start @card:justify-items-stretch">
          <div className="w-28 @card:w-full">{frame}</div>
          {actions && <div className="hidden @card:grid @card:justify-items-start">{actions}</div>}
        </aside>
        <div className="grid min-w-0 content-start gap-8">
          {children}
          {actions && <div className="@card:hidden">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Where text arrives while the card is written: the point the column
 * follows, and after six seconds without new text (styles.css
 * `still-waiting`) who it waits for. `restart` changes with each new piece
 * of text, which restarts the wait. While the model thinks before its
 * first text, it says so at once instead. Beside the caret while nothing has
 * arrived at this point; under the text once some has, out of the flow,
 * so that nothing moves as the edge comes and goes.
 */
function EdgeMark({
  restart,
  beside,
  thinking = false,
}: {
  restart: number;
  beside: boolean;
  thinking?: boolean | undefined;
}) {
  return (
    <>
      <span
        data-writing-edge=""
        aria-hidden="true"
        className={beside ? undefined : "absolute bottom-0 left-0"}
      />
      <span
        key={thinking ? "thinking" : restart}
        className={cn(
          "pointer-events-none text-meta text-reed",
          thinking
            ? "transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
            : "still-waiting",
          !beside && "absolute top-full left-0 mt-1.5",
        )}
      >
        {thinking ? "Thinking" : "Waiting for the model"}
      </span>
    </>
  );
}

/** The card's name, the largest type on the screen, and its tagline, both in the character's voice. */
export function CardHeading({
  name,
  tagline,
  headingRef,
  label,
  edge,
}: {
  name: string;
  tagline: string;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Said instead of the name while it has not arrived. */
  label?: string | undefined;
  /**
   * The name or the tagline is being written: the caret stands where it
   * arrives. `thinking`: the model reasons before its first text.
   */
  edge?: { at: "name" | "tagline"; restart: number; thinking?: boolean } | undefined;
}) {
  const caret = (after: string) => (
    <span aria-hidden="true" className={cn("caret", after !== "" && "ml-1")} />
  );
  return (
    <header className="relative grid gap-3">
      <h2
        ref={headingRef}
        tabIndex={-1}
        aria-label={name === "" ? label : undefined}
        className="min-h-[2.25rem] text-pretty break-words font-[450] font-story text-ink text-title-phone outline-none tablet:min-h-10 tablet:text-title"
      >
        <Words text={name} />
        {edge?.at === "name" && caret(name)}
      </h2>
      {(tagline !== "" || edge?.at === "tagline") && (
        <p className="voice-story text-pretty text-narration text-story-phone tablet:text-story">
          <Words text={tagline} />
          {edge?.at === "tagline" && caret(tagline)}
        </p>
      )}
      {edge !== undefined &&
        (edge.at === "name" && name === "" ? (
          <p className="absolute top-0 left-4 flex h-9 items-center tablet:h-10">
            <EdgeMark restart={edge.restart} thinking={edge.thinking} beside />
          </p>
        ) : (
          <EdgeMark restart={edge.restart} thinking={edge.thinking} beside={false} />
        ))}
    </header>
  );
}

/** Placeholder line widths, varied by section so the page reads as text to come, not a form. */
const GHOST_WIDTHS = [
  ["100%", "62%"],
  ["94%", "78%", "40%"],
  ["100%", "48%"],
] as const;

/**
 * A section still to come while the card is written: faint lines at the
 * story's rhythm where its text will stand. Still, so that the writing edge
 * is the only thing that moves.
 */
function GhostLines({ section }: { section: string }) {
  const widths = GHOST_WIDTHS[section.length % GHOST_WIDTHS.length] ?? [];
  return (
    <div aria-hidden="true" className="grid">
      {widths.map((width) => (
        <span key={width} className="flex h-7 items-center tablet:h-[1.875rem]">
          <span className="h-2 rounded-full bg-surface" style={{ width }} />
        </span>
      ))}
    </div>
  );
}

/**
 * One section of the card: its label, then the text in the character's
 * voice. While the card is written, a section still to come shows quiet
 * placeholder lines, and the one being written the caret until its text
 * arrives.
 */
export function CardSection({
  row,
  streaming,
  edge,
}: {
  row: CardRow;
  streaming: boolean;
  /** Text arrives here now (EdgeMark's `restart`): the column follows this point, and waiting is said here. */
  edge?: number | undefined;
}) {
  return (
    <section className="relative grid gap-2 border-rush border-t pt-4">
      {row.heading !== undefined && (
        <p className="break-words font-story text-heading text-ink">{row.heading}</p>
      )}
      <h3
        className={cn(
          "font-medium text-ui transition-colors duration-(--duration-quick) ease-fade",
          row.state === "absent" ? "text-reed" : "text-ink",
        )}
      >
        {row.label}
      </h3>
      {row.text !== "" ? (
        <CardProse text={row.text} streaming={streaming && row.state === "incomplete"} />
      ) : edge !== undefined ? (
        <p className="flex h-7 items-center gap-3 tablet:h-[1.875rem]">
          <span aria-hidden="true" className="caret" />
          <EdgeMark restart={edge} beside />
        </p>
      ) : (
        streaming && row.state === "absent" && <GhostLines section={row.key} />
      )}
      {edge !== undefined && row.text !== "" && <EdgeMark restart={edge} beside={false} />}
    </section>
  );
}
