/**
 * The frame the thread, the composer, the notices above it and the chat
 * header's contents share: the whole chat column with padding, so a wide
 * window gives the story its width instead of framing it in empty canvas.
 * From tablet up the trailing padding also holds the turns' More buttons,
 * which hang just outside the story's edge. A module of its own, so the
 * root shell's sign-in slot reads it without the turn renderer.
 */
export const SCRIPT_FRAME =
  "w-full px-5 tablet:pr-[4.75rem] tablet:pl-8 desktop:pr-[5.75rem] desktop:pl-12";
