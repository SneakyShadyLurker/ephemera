import { HIGHLIGHT_TONES, THOUGHT_MARK } from "@ephemera/core";
import { cn } from "@/lib/cn";
import { CardProse } from "../creator/CardLayout.tsx";

/*
 * The formatting key: each mark the chat draws in a character's reply,
 * written as a prompt would ask for it and drawn beside it by the chat's own
 * renderer and scene voices, so the key always shows what the chat shows.
 * Each sample says what it is; the tones come from core's vocabulary.
 */

const CUE = "Kate (25):";

const MARKS: string[] = [
  "Plain lines are narration.",
  `${CUE} "Quoted speech."`,
  `${CUE} *an action*`,
  `${CUE} :${THOUGHT_MARK}[a thought]`,
  ...HIGHLIGHT_TONES.map((tone) => `:${tone}[${tone}]`),
  "> Quoted lines stand apart.",
];

const HELP = "text-pretty text-note text-reed";
/** A mark as written, selected whole with one click; in prose it stays on one line. */
const MARK = "cursor-text select-all whitespace-nowrap font-mono text-meta";

/**
 * Beside the form on wide screens (`aside`), sticky as the blocks scroll by;
 * elsewhere a section of the form, after the blocks.
 */
export function FormattingKey({ placement }: { placement: "aside" | "section" }) {
  const aside = placement === "aside";
  const marks = (
    <ul
      aria-label="Marks, as written and as the chat shows them"
      className={cn("grid gap-x-8 gap-y-3.5", !aside && "tablet:grid-cols-2")}
    >
      {MARKS.map((written) => (
        <li key={written} className="grid min-w-0 content-start gap-0.5">
          <div className="voice-scene [&_blockquote]:my-0">
            <CardProse text={written} streaming={false} />
          </div>
          <code className={cn(MARK, "whitespace-normal break-words text-reed")}>{written}</code>
        </li>
      ))}
    </ul>
  );
  const help = (
    <>
      <p className={HELP}>
        What the chat draws in a reply. Ask for the marks you want in any block, such as Formatting.
      </p>
      {marks}
      <p className={HELP}>
        Marks touch their words: <code className={MARK}>*smiles*</code>, never{" "}
        <code className={MARK}>* smiles *</code>.
      </p>
    </>
  );
  if (aside) {
    return (
      <section
        aria-labelledby="formatting-key"
        className="sticky top-8 grid h-fit max-h-[calc(100dvh-7rem)] gap-4 self-start overflow-y-auto border-rush border-l pl-5"
      >
        <h2 id="formatting-key" className="font-semibold text-ink text-ui">
          Formatting
        </h2>
        {help}
      </section>
    );
  }
  return help;
}
