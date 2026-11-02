import { cn } from "@/lib/cn";

/*
 * Every field's face, owned here: an edge and a ground, the placeholder in
 * reed, and focus turning the edge to dusk. The roles below differ only in
 * what genuinely differs: size, padding and type, and whether the field is
 * boxed at rest (a sheet field, a chat edit, a request to a model) or open
 * on the page until it is used (a title or a name).
 */
const FIELD_FACE =
  "rounded-md border bg-surface text-ink outline-none placeholder:text-reed focus:border-dusk-line";

/** A boxed field: in the control edge at rest, ringed while focused, growing with its text. */
const BOXED = cn(
  FIELD_FACE,
  "w-full resize-none border-control-edge [field-sizing:content] transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade focus:shadow-focus",
);

/**
 * A sheet field: grows with its text up to 60% of the view, then scrolls
 * inside. A read-only field (while an AI Rework works or is under review)
 * looks quiet.
 */
export const FIELD = cn(
  BOXED,
  "max-h-[60dvh] px-3.5 py-2.5 text-turn aria-readonly:border-rush aria-readonly:bg-canvas",
);

/** A chat message under edit: a sheet field's box in the turn's own type. */
export const EDIT_FIELD = cn(BOXED, "max-h-[60dvh] px-3.5 py-2.5");

/**
 * The owner's words to a model (the creator's description, the rework's
 * request, the art's direction): a roomier box in the story's size, its
 * lines 1.75rem apart, which the callers' heights count in.
 */
export const REQUEST_FIELD = cn(BOXED, "px-4 py-3 text-story leading-7");

/**
 * A title or name set as a heading (a sheet's name, a lorebook's): open on
 * the page at rest, an edge under the pointer, the field's face once
 * focused. The caller sets its type.
 */
export const TITLE_FIELD = cn(
  FIELD_FACE,
  "-mx-1.5 border-transparent bg-transparent px-1.5 font-semibold transition-[border-color,background-color] duration-(--duration-tint) hover:border-rush focus:bg-surface touch:border-b-rush",
);

/** The focus of a field made of several parts (tokens, a search box with its icon, the composer). */
export const FOCUS_WITHIN =
  "transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade focus-within:border-dusk-line focus-within:shadow-focus";

/**
 * Where a sheet label's first line meets what it labels: a boxed field's
 * first line, a 36px control, a line of switches, checkboxes or open text,
 * or a paragraph.
 */
const LABEL_ALIGN = {
  field: "tablet:pt-2.5",
  control: "tablet:pt-2",
  line: "tablet:pt-1.5",
  text: "tablet:pt-0.5",
} as const;

/**
 * The sheets' label grammar (character, persona, prompt and sampler preset,
 * memory): a semibold label in ink, above its field on phones and in the
 * margin beside it from tablet, set flush against the field like a speaker's
 * cue and level with its first line.
 */
export const sheetLabel = (align: keyof typeof LABEL_ALIGN = "field") =>
  `mb-2 block font-semibold text-ink text-ui tablet:mb-0 tablet:text-right ${LABEL_ALIGN[align]}`;

/** A sheet's help line, under the field it explains. */
export const HELP = "text-pretty text-note text-reed";

/** The sheets' grid: labels hang in a margin beside the fields, like speaker cues. */
export const SHEET_GRID = "tablet:grid tablet:grid-cols-[7rem_minmax(0,40rem)] tablet:gap-x-6";
/** The memory screen's: the same, with a margin wide enough on desktop for its longer labels on one line. */
export const NOTEBOOK_GRID = `${SHEET_GRID} desktop:grid-cols-[10.5rem_minmax(0,1fr)]`;
