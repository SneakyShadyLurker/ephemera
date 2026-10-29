/**
 * Which e2e specs a change calls for (ARCHITECTURE.md § Affected tests). One
 * owner for both halves of the question: what part of the product a source
 * path belongs to, and which parts each spec exercises. A focused run takes
 * the specs that are the main test of an area a change touches.
 */
export const AREAS = [
  "chat",
  "characters",
  "creator",
  "rework",
  "lorebook",
  "events",
  "memory",
  "personas",
  "presets",
  "settings",
  "signin",
  // The frame of every page: the shell, the shared components, the stylesheet.
  "design",
] as const;
export type Area = (typeof AREAS)[number];

/**
 * The areas each spec is the main test of: its subject, not every area
 * its tests pass through, so a change runs the specs about it rather than
 * every spec that opens a chat. A guard (the retention matrix, hostile
 * input, autosave, how presets shape the prompt) is the main test of each
 * area it guards. A spec file without a row fails the unit test beside the
 * planner, so a new spec is placed when it is written.
 */
export const SPEC_AREAS: Record<string, readonly Area[]> = {
  "art-transport.spec.ts": ["creator", "chat"],
  "autosave.spec.ts": ["characters", "personas", "presets", "lorebook"],
  "cast-retention.spec.ts": ["chat", "characters"],
  "cast.spec.ts": ["chat", "settings"],
  "characters.spec.ts": ["characters"],
  "chat-features.spec.ts": ["chat", "presets"],
  "chat.spec.ts": ["chat"],
  "creator-retention.spec.ts": ["creator"],
  "creator.spec.ts": ["creator"],
  "design.spec.ts": ["design"],
  "events.spec.ts": ["events"],
  "follow-ups.spec.ts": ["chat"],
  "hostile-cards.spec.ts": ["characters", "chat", "lorebook"],
  "hostile-entities.spec.ts": ["personas", "presets", "chat"],
  "image-card-retention.spec.ts": ["creator", "characters"],
  "lorebook.spec.ts": ["lorebook"],
  "lorebooks.spec.ts": ["lorebook"],
  "prompt-behavior.spec.ts": ["chat", "presets"],
  "memory.spec.ts": ["memory"],
  "per-user.spec.ts": ["characters", "personas", "settings", "signin", "chat", "creator"],
  "personas.spec.ts": ["personas"],
  "preset-files.spec.ts": ["presets"],
  "presets.spec.ts": ["presets"],
  "prompt.spec.ts": ["chat", "presets", "personas"],
  "restart.spec.ts": ["chat"],
  "retention.spec.ts": ["chat", "lorebook", "events", "memory", "personas", "presets", "signin"],
  "rework-retention.spec.ts": ["rework"],
  "rework.spec.ts": ["rework"],
  "sampler-choice.spec.ts": ["presets"],
  "scene-retention.spec.ts": ["chat", "creator"],
  "scene.spec.ts": ["chat", "creator"],
  "settings.spec.ts": ["settings", "presets"],
  "sheet-art-retention.spec.ts": ["characters", "creator"],
  "sheet-art.spec.ts": ["characters", "creator"],
  "signin.spec.ts": ["signin"],
  "vast-lorebook.spec.ts": ["lorebook"],
  "workflows.spec.ts": ["settings", "creator"],
  "workflows-retention.spec.ts": ["settings", "creator"],
};

/** Specs every focused run includes: one test each, about the whole page. */
export const ALWAYS_SPECS: readonly string[] = ["csp.spec.ts"];

/**
 * Source paths by the area that owns them; the longest matching prefix
 * wins. A change also reaches the areas of the files that import the
 * changed one directly or transitively, stopping before composition and
 * shared hubs, which the planner reads from the import graph
 * (scripts/affected/graph.ts), so this table says only where a file lives
 * and what a server route serves. `all` marks shared source within an
 * owned folder. Source this table does not name also belongs to every
 * area (the API client, query cache, persistence, the server's boundary,
 * configuration), so the unknown case is the full suite, never a skipped
 * one.
 */
export const SOURCE_AREAS: readonly (readonly [prefix: string, areas: readonly Area[] | "all"])[] =
  [
    // design.spec.ts visits every page, so it answers for the frame around them.
    ["apps/web/src/app/", ["design"]],
    // Shared query behavior affects every feature; traversal stops here as at other shared hubs.
    ["apps/web/src/app/query.ts", "all"],
    // What keeps an open chat when a chunk fails to load; signin.spec.ts proves it.
    ["apps/web/src/app/chunk-error.ts", ["design", "signin"]],
    ["apps/web/src/app/preload.ts", ["design", "signin"]],
    ["apps/web/src/app/router-package.ts", ["design", "signin"]],
    ["apps/web/src/components/", ["design"]],
    ["apps/web/src/styles.css", ["design"]],
    ["apps/web/src/chat/", ["chat"]],
    // The chat store carries which event fired where from reply to reply, and folds remembered turns.
    ["apps/web/src/chat/store.ts", ["chat", "events", "memory"]],
    // The seam and the mark: memory's place in the chat.
    ["apps/web/src/chat/MemorySeam.tsx", ["memory"]],
    ["apps/web/src/chat/MemoryMark.tsx", ["memory"]],
    // The thread folds remembered turns, a turn locks them, the inspector shows the memory
    // blocks, and the session follows the character's memory.
    ["apps/web/src/chat/Thread.tsx", ["chat", "memory"]],
    ["apps/web/src/chat/Turn.tsx", ["chat", "memory"]],
    ["apps/web/src/chat/Inspector.tsx", ["chat", "memory"]],
    ["apps/web/src/chat/session.ts", ["chat", "memory"]],
    // Clearing and switching chats offer to remember the ending first.
    ["apps/web/src/chat/RememberEnding.tsx", ["chat", "memory"]],
    ["apps/web/src/chat/ClearChat.tsx", ["chat", "memory"]],
    ["apps/web/src/chat/StartChat.tsx", ["chat", "memory"]],
    // Picture this scene: the chat's side of the creator's art, its stream, its plate and its button.
    ["apps/web/src/chat/scene-slice.ts", ["chat", "creator"]],
    ["apps/web/src/chat/scene-stream.ts", ["chat", "creator"]],
    ["apps/web/src/chat/Scene.tsx", ["chat", "creator"]],
    // The cast register: the chat's slice and its panel.
    ["apps/web/src/chat/cast-slice.ts", ["chat"]],
    ["apps/web/src/chat/Cast.tsx", ["chat"]],
    // The keeper's calls and the cast sheet: its queries and the character sheet's section.
    ["apps/web/src/cast/", ["chat", "characters"]],
    // The bounded model calls' answer protocol, shared by chat, the cast and memory.
    ["apps/web/src/model-call.ts", ["chat", "memory"]],
    ["apps/web/src/characters/", ["characters"]],
    ["apps/web/src/portraits/", ["characters", "personas", "creator"]],
    // Accepted rework edits save through the sheets' autosave.
    ["apps/web/src/sheet/", ["characters", "personas", "presets", "lorebook", "rework"]],
    ["apps/web/src/creator/", ["creator"]],
    // New art for a saved character: the creator's art on the character sheet.
    ["apps/web/src/sheet-art/", ["characters", "creator"]],
    ["apps/web/src/rework/", ["rework"]],
    ["apps/web/src/lorebook/", ["lorebook"]],
    // The library: its screens, their routes, its API and its store.
    ["apps/web/src/lorebooks/", ["lorebook"]],
    ["apps/web/src/routes/lorebooks.", ["lorebook"]],
    // Events: a section of the Lorebooks screen, with its queries and autosave.
    ["apps/web/src/events/", ["events"]],
    // A character's memory: its screen, the sheet's section, its queries.
    ["apps/web/src/memory/", ["memory"]],
    ["apps/web/src/routes/characters.$id_.memory", ["memory"]],
    ["apps/web/src/personas/", ["personas"]],
    ["apps/web/src/presets/", ["presets"]],
    ["apps/web/src/settings/", ["settings"]],
    // Custom palettes: their editor and queries, part of Settings > Appearance.
    ["apps/web/src/palettes/", ["settings"]],
    ["apps/web/src/signin/", ["signin"]],
    ["apps/server/src/creator.ts", ["creator", "rework"]],
    ["apps/server/src/comfyui/", ["creator"]],
    /*
     * Picture this scene: the chat's character painted through the creator's
     * ComfyUI. Creator only: the route imports creator.ts, so a chat area here
     * would send every creator and rework change to the chat specs.
     */
    ["apps/server/src/scene.ts", ["creator"]],
    // The cast keeper's route and the cast sheet job; the sheet persists as character data.
    ["apps/server/src/cast.ts", ["chat", "characters"]],
    ["apps/server/src/persistence/cast-sheets.ts", ["characters"]],
    // One structured model call: the cast keeper's and the memory call's.
    ["apps/server/src/object-call.ts", ["chat", "memory"]],
    // Generation rolls the events and injects the one that fires.
    ["apps/server/src/generation.ts", ["chat", "events"]],
    ["apps/server/src/reasoning.ts", ["chat", "settings"]],
    // Every model call: provider, efforts, cache keys, retries and error codes.
    ["apps/server/src/upstream.ts", ["chat", "creator", "rework", "memory"]],
    ["apps/server/src/tokens.ts", ["chat", "creator", "rework", "memory"]],
    // Every streamed answer and the instance it keeps in use: chat, creator, rework and memory.
    ["apps/server/src/streams.ts", ["chat", "creator", "rework", "memory"]],
    ["apps/server/src/characters.ts", ["characters", "creator", "rework"]],
    ["apps/server/src/cards.ts", ["characters", "creator", "rework"]],
    ["apps/server/src/images.ts", ["characters", "personas", "creator"]],
    ["apps/server/src/png.ts", ["characters", "personas", "creator"]],
    ["apps/server/src/lorebooks.ts", ["lorebook"]],
    ["apps/server/src/persistence/lorebooks.ts", ["lorebook"]],
    ["apps/server/src/events.ts", ["events"]],
    ["apps/server/src/persistence/events.ts", ["events"]],
    ["apps/server/src/memory.ts", ["memory"]],
    ["apps/server/src/persistence/memories.ts", ["memory"]],
    ["apps/server/src/personas.ts", ["personas"]],
    ["apps/server/src/presets.ts", ["presets"]],
    ["apps/server/src/settings.ts", ["settings", "chat"]],
    ["apps/server/src/catalog.ts", ["settings", "chat", "creator"]],
    ["packages/core/src/card/", ["characters", "lorebook", "creator", "rework"]],
    ["packages/core/src/creator/", ["creator", "rework"]],
    ["packages/core/src/creator/rework/", ["rework"]],
    ["packages/core/src/scene/", ["chat", "creator"]],
    ["packages/core/src/lorebook/", ["lorebook", "chat"]],
    ["packages/core/src/events/", ["events", "chat"]],
    // The memory call's prompts and schemas, recall and the memory blocks' placement.
    ["packages/core/src/memory/", ["memory", "chat"]],
    // The cast register, the keeper's and the sheet's prompts and schemas.
    ["packages/core/src/cast/", ["chat", "characters"]],
    ["packages/core/src/prompt/", ["chat"]],
    ["packages/core/src/preset/", ["presets", "chat"]],
    ["packages/core/src/chat.ts", ["chat"]],
    ["packages/core/src/chat-limits.ts", ["chat"]],
    // The JSON bodies server and web app share.
    [
      "packages/core/src/responses.ts",
      ["characters", "lorebook", "events", "settings", "chat", "memory"],
    ],
    // The cheap token estimate: history block boundaries and the memory recap's weight.
    ["packages/core/src/tokens.ts", ["chat", "memory"]],
    ["packages/core/src/models.ts", ["settings", "chat", "creator"]],
    ["packages/core/src/persona.ts", ["personas", "chat"]],
    ["packages/core/src/settings.ts", ["settings"]],
  ];

/**
 * Files that compose the app rather than use what they import: the routes
 * and the entry, the chunk preloader, the server's assembly, the core
 * package's indexes. Traversal neither returns these hubs nor follows
 * their importers, which would tie every file to every area.
 */
export const COMPOSITION: readonly RegExp[] = [
  /^apps\/web\/src\/(routes\/|routeTree\.gen\.ts$|main\.tsx$|app\/preload\.ts$)/,
  /^apps\/server\/src\/(api|app|index|routes)\.ts$/,
  /^packages\/core\/src\/(.*\/)?index\.ts$/,
];

/**
 * Paths no browser flow depends on: prose, unit tests and their fixtures,
 * tooling and the deployment. A spec that imports one of them still runs,
 * through Playwright's own `--only-changed` (scripts/affected/run.ts). That
 * graph covers the test process only, so what the mock servers of
 * `e2e/support` import is left out of this list and takes the whole suite.
 */
export const NO_E2E: readonly RegExp[] = [
  /\.md$/,
  /^docs\//,
  /\.test\.tsx?$/,
  /^apps\/server\/test\/(?!fake-(upstream|comfyui)\.ts$)/,
  /^packages\/core\/test-fixtures\//,
  /^scripts\//,
  // Area tables select specs and validate their names, without changing browser behavior.
  /^e2e\/areas\.ts$/,
  /^infra\//,
  /^vitest\.config\.ts$/,
];
