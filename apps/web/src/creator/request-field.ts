/**
 * A request field's face for the owner's words to a model, the creator's
 * description, the rework's request and the art's direction alike; the
 * caller sets its heights. Kept apart from the screens so a surface can take
 * the look without loading their sessions.
 */
export const REQUEST_FIELD =
  "w-full resize-none rounded-lg border border-control-edge bg-surface px-4 py-3 text-[1.125rem] text-ink leading-7 transition-[border-color,box-shadow] duration-(--duration-quick) ease-fade [field-sizing:content] placeholder:text-reed focus:border-dusk-line focus:shadow-focus focus:outline-none";
