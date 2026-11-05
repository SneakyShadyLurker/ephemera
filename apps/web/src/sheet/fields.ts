import { cn } from "@/lib/cn";

/*
 * Every field's face, owned here: an edge and a ground, the placeholder in
 * reed, and focus turning the edge to dusk. The roles below differ only in
 * what genuinely differs: size, padding and type, and whether the field is
 * boxed at rest (a sheet field, a chat edit, a request to a model) or open
 * on the page until it is used (a title or a name).
 */
const FIELD_FACE =
  "rounded-md border bg-surface text-ink outline-none placeholder:text-reed focus:border-dusk-line focus:shadow-focus";

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

/**
 * A single-line field (a name, a short value): a sheet field's box at a
 * control's height, 36px, 44px on touch, so it lines up with the buttons
 * beside it.
 */
export const LINE_FIELD = cn(FIELD, "h-9 py-0 text-ui touch:h-11");

/**
 * A compact field for a number or a code (a position, a hex colour): a line
 * field's height with tighter padding and figures of one width. The caller
 * sets its width.
 */
export const COMPACT_FIELD = cn(LINE_FIELD, "px-2 tabular-nums");

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
  "-mx-1.5 border-transparent bg-transparent px-1.5 font-semibold transition-[border-color,background-color] duration-(--duration-tint) ease-fade hover:border-rush focus:bg-surface touch:min-h-11 touch:border-b-rush",
);

/**
 * Editable prose open on the page (the memory's notes, a cast record's
 * details): no box at rest and a hairline under it on touch, the field's
 * edge and a faint wash under a pointer, the field's face once focused.
 * Read-only, it stays open and still. The caller sets its type and ink.
 */
export const PROSE_FACE = cn(
  FIELD_FACE,
  "w-full cursor-text border-dotted border-transparent border-b-rush bg-transparent px-2 py-1 transition-[border-color,background-color,color,box-shadow] duration-(--duration-quick) ease-fade hover:border-rush hover:bg-surface-hover focus:border-solid focus:bg-surface focus:shadow-focus touch:min-h-11",
);

export const PROSE_FIELD = cn(
  PROSE_FACE,
  "resize-none [field-sizing:content] read-only:cursor-default read-only:border-transparent read-only:hover:border-transparent read-only:hover:bg-transparent",
);

/** The focus of a field made of several parts (tokens, a search box with its icon, the composer). */
export const FOCUS_WITHIN =
  "transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade focus-within:border-dusk-line focus-within:shadow-focus";

/**
 * Where a sheet label's first line meets what it labels: a boxed field's
 * first line, a 36px control, a line of switches, checkboxes or open text,
 * or a paragraph.
 */
export const SECTION_HEADING = "font-semibold text-ink text-lead";
export const DISPLAY_HEADING = cn(SECTION_HEADING, "text-title-phone tablet:text-title");
export const STORY_SECTION_HEADING = cn(SECTION_HEADING, "font-story text-heading");
export const STORY_DISPLAY_HEADING = cn(DISPLAY_HEADING, "font-[450] font-story");
export const FIELD_LABEL = "font-medium text-ink text-ui";
export const COMPACT_LABEL = "font-medium text-meta text-reed";
export const GROUP_HEADING = "font-semibold text-ink text-ui";

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
  `mb-2 block ${GROUP_HEADING} tablet:mb-0 tablet:text-right ${LABEL_ALIGN[align]}`;

/** A sheet's help line, under the field it explains. */
export const HELP = "text-pretty text-note text-reed";
/** Explanatory sentences in working panels, one step above a compact help line. */
export const EXPLANATION = HELP;

/** The sheets' grid: labels hang in a margin beside the fields, like speaker cues. */
export const SHEET_GRID = "tablet:grid tablet:grid-cols-[7rem_minmax(0,40rem)] tablet:gap-x-6";
/** The memory screen's: the same, with a margin wide enough on desktop for its longer labels on one line. */
export const NOTEBOOK_GRID = `${SHEET_GRID} desktop:grid-cols-[10.5rem_minmax(0,1fr)]`;
