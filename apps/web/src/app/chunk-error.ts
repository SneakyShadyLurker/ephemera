/**
 * A screen's code that did not arrive. The browser keeps a failed module
 * fetch for the life of the page (the HTML module map), so only a reload,
 * which ends the chat, can bring it back; the error says nothing else.
 */
export class ChunkLoadError extends Error {
  override name = "ChunkLoadError";
  constructor() {
    super("A code chunk did not load");
  }
}
