export const SERVER_HOPS = ["S-data", "S-tmp", "S-log", "S-home", "S-repo"] as const;
export type ServerHop = (typeof SERVER_HOPS)[number];

/**
 * The rows of docs/ARCHITECTURE.md § Retention matrix, by canary label and
 * owning producer spec; a unit test keeps the two label sets equal. Restart
 * rows bring their own server, so the main check only scans the repository
 * for them.
 */
export const MATRIX_ROWS = {
  in: { row: "input", owner: "retention.spec.ts" },
  draft: { row: "draft", owner: "retention.spec.ts" },
  out: { row: "output", owner: "retention.spec.ts" },
  think: { row: "reasoning", owner: "retention.spec.ts" },
  cnote: { row: "Character's Note", owner: "retention.spec.ts" },
  prompt: { row: "inspector prompt", owner: "retention.spec.ts" },
  lore: { row: "lorebook activation", owner: "retention.spec.ts" },
  timed: { row: "lorebook timed effects", owner: "retention.spec.ts" },
  event: { row: "event state", owner: "retention.spec.ts" },
  macro: { row: "local and global macro variables", owner: "retention.spec.ts" },
  swipe: { row: "swipes", owner: "retention.spec.ts" },
  edit: { row: "edits", owner: "retention.spec.ts" },
  cont: { row: "continuations", owner: "retention.spec.ts" },
  imp: { row: "impersonated drafts", owner: "retention.spec.ts" },
  err: { row: "upstream error", owner: "retention.spec.ts" },
  stop: { row: "cancellation", owner: "retention.spec.ts" },
  clear: { row: "Clear during streaming", owner: "retention.spec.ts" },
  big: { row: "oversized chat", owner: "retention.spec.ts" },
  bf: { row: "back/forward", owner: "retention.spec.ts" },
  reload: { row: "reload", owner: "retention.spec.ts" },
  expiry: { row: "session expiry mid-send", owner: "retention.spec.ts" },
  bad: { row: "malformed requests", owner: "retention.spec.ts" },
  rst: {
    row: "server restart mid-stream",
    owner: "restart.spec.ts",
    serverHops: ["S-repo"],
  },
  mem: { row: "memory: the remembered span", owner: "retention.spec.ts" },
  memerr: { row: "memory: upstream error", owner: "retention.spec.ts" },
  memclear: { row: "memory: Clear mid-call", owner: "retention.spec.ts" },
  memfold: { row: "memory: a span folded in a request", owner: "retention.spec.ts" },
  cast: { row: "cast register: the keeper's answer", owner: "cast-retention.spec.ts" },
  casterr: { row: "cast register: keeper upstream error", owner: "cast-retention.spec.ts" },
  castclear: { row: "cast register: Clear mid-call", owner: "cast-retention.spec.ts" },
  castedit: { row: "cast register: an owner correction", owner: "cast-retention.spec.ts" },
  castsheet: { row: "cast sheet: character data", owner: "cast-retention.spec.ts" },
  memcast: { row: "memory cast: source and scene state", owner: "cast-retention.spec.ts" },
  crok: { row: "creation drafts: success before Keep", owner: "creator-retention.spec.ts" },
  crdiscard: { row: "creation drafts: Discard", owner: "creator-retention.spec.ts" },
  crrewrite: { row: "creation drafts: Rewrite", owner: "creator-retention.spec.ts" },
  crretry: { row: "creation drafts: automatic retry", owner: "creator-retention.spec.ts" },
  crstop: { row: "creation drafts: Stop mid-stream", owner: "creator-retention.spec.ts" },
  crerr: { row: "creation drafts: upstream error", owner: "creator-retention.spec.ts" },
  crcomfy: { row: "creation drafts: ComfyUI error", owner: "creator-retention.spec.ts" },
  crnav: { row: "creation drafts: navigation away", owner: "creator-retention.spec.ts" },
  crreload: { row: "creation drafts: reload", owner: "creator-retention.spec.ts" },
  crrst: {
    row: "creation drafts: server restart mid-generation",
    owner: "creator-retention.spec.ts",
    serverHops: ["S-repo"],
  },
  rwok: { row: "rework drafts: review before Apply", owner: "rework-retention.spec.ts" },
  rwdiscard: { row: "rework drafts: Discard", owner: "rework-retention.spec.ts" },
  rwstop: { row: "rework drafts: Stop mid-stream", owner: "rework-retention.spec.ts" },
  rwerr: { row: "rework drafts: upstream error", owner: "rework-retention.spec.ts" },
  rwnav: { row: "rework drafts: navigation away", owner: "rework-retention.spec.ts" },
  rwreload: { row: "rework drafts: reload", owner: "rework-retention.spec.ts" },
  rwapply: {
    row: "rework drafts: Apply with a rejected change",
    owner: "rework-retention.spec.ts",
  },
  icok: { row: "image card: kept", owner: "image-card-retention.spec.ts" },
  icerr: { row: "image card: upstream error", owner: "image-card-retention.spec.ts" },
  icinvalid: { row: "image card: unusable answer", owner: "image-card-retention.spec.ts" },
  icstop: { row: "image card: caller disconnect", owner: "image-card-retention.spec.ts" },
  saok: { row: "sheet art: candidates before Use", owner: "sheet-art-retention.spec.ts" },
  sause: { row: "sheet art: Use as portrait", owner: "sheet-art-retention.spec.ts" },
  scene: { row: "scene picture: painted", owner: "scene-retention.spec.ts" },
  sceneerr: { row: "scene picture: ComfyUI error", owner: "scene-retention.spec.ts" },
  scenestop: { row: "scene picture: Stop mid-paint", owner: "scene-retention.spec.ts" },
  sceneclear: { row: "scene picture: Clear mid-paint", owner: "scene-retention.spec.ts" },
} as const satisfies Record<
  string,
  { row: string; owner: string; serverHops?: readonly ServerHop[] }
>;

export type RowLabel = keyof typeof MATRIX_ROWS;

/** A missing marker fails unless its producer was excluded from a focused run. */
export function retentionRowPolicy(
  label: RowLabel,
  markers: readonly string[],
  focusedSpecs: readonly string[] | undefined,
): "scan" | "skip" {
  if (markers.includes(label)) return "scan";
  const row = MATRIX_ROWS[label];
  if (focusedSpecs !== undefined && !focusedSpecs.includes(row.owner)) return "skip";
  throw new Error(`row did not run: ${row.row}`);
}
