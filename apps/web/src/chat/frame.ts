/**
 * The frame the thread, the composer, the notices above it and the chat
 * header's contents share: the chat column up to the portrait and prose's
 * natural maximum, then centred together on wider windows.
 * From tablet up the trailing padding also holds the turns' More buttons,
 * which hang just outside the story's edge. A module of its own, so the
 * root shell's sign-in slot reads it without the turn renderer.
 */
export const SCRIPT_FRAME =
  "mx-auto w-full max-w-(--container-script) px-5 tablet:pr-[4.75rem] tablet:pl-8 desktop:pr-(--inset-story-end) desktop:pl-(--inset-story-start)";
