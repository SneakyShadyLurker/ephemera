/** The placeholder as an owner may type it too: any case, spaces inside the braces, or `<user>`. */
export const USER_MACRO = /\{\{\s*user\s*\}\}|<user>/gi;

/** `text` with each placeholder as `name`; nothing else is filled. */
export const fillUserPlaceholder = (text: string, name: string): string =>
  text.replace(USER_MACRO, () => name);
