# Architecture

## Topology

A reference topology; any proxy, upstream and ComfyUI that meet the
principles fit.

```
Browser (SPA, chat in memory)
  -> trusted authentication proxy, e.g. SWAG with Authelia (TLS, identity, proxy key)
  -> Ephemera container (Hono API + static SPA), published on the host's loopback
  -> OpenAI-compatible upstream, e.g. CLIProxyAPI
  -> model providers

Ephemera container, for AI card portraits and scene pictures only
  -> the ComfyUI address saved in Settings (a plain ComfyUI or Atelier's private worker)

Atelier's server, optional, for image-born cards only
  -> Ephemera's published port, with its own integration key
```

For one person on one computer, `./ephemera` runs the same server with the
local gateway in the proxy's place (§ Local gateway):

```
Browser on the same computer (http://localhost:8780)
  -> local gateway on 127.0.0.1 (identity, proxy key)
  -> Ephemera server on 127.0.0.1:8790
  -> OpenAI-compatible upstream
```

[Atelier](https://github.com/SneakyShadyLurker/atelier-studio) is an optional, separately deployed image service that Ephemera
supports: its hardened ComfyUI worker speaks a private worker protocol
(§ AI card creation and rework), and its server may ask for image-born
cards. Without it, Ephemera runs on a plain ComfyUI.

## Repository layout

Bun workspace, strict TypeScript, ESM.

| Path | Owns |
|---|---|
| `packages/core` | Pure domain logic with no I/O: card schemas and V2/V3 parsing, prompt assembly, macros, lorebook activation, token budgeting and the cheap token estimate (`src/tokens.ts`), AI card creation's and AI Rework's prompts, parsers and schemas, memory's schemas, prompts, answer repair, roll-up, recall and the memory blocks' placement (`src/memory/`), the cast register's schemas, the keeper's and the cast sheet's prompts, applying the keeper's changes and the narrator's cast texts (`src/cast/`), and the JSON response bodies server and web share (`src/responses.ts`). Shared by server and web |
| `apps/server` | Hono API: persistence, model list, generation streaming, AI card creation and rework and the creation's ComfyUI client, memory calls, the cast keeper and cast sheet calls, auth boundary. Serves the built SPA in production. `src/persistence/` is the only code that opens the database or touches the file system; `drizzle/` holds its migrations |
| `apps/web` | React SPA: screens, design system, in-memory chat store, which folds remembered turns |
| `infra/docker` | The `@ephemera/infra` workspace: Dockerfile, Compose file, healthcheck and the container contract check |
| `e2e` | Playwright flows and the retention matrix, against a synthetic mock upstream and a mock ComfyUI |
| `scripts` | Workspace checks, dependency persistence audit and in-memory native card checks |
| `scripts/ephemera` | The `./ephemera` command: setup wizard, server management, updates of installed copies and the local gateway; `ephemera.cmd` and `install.ps1` at the root start it on Windows |
| `packages/core/test-fixtures/imports` | Synthetic foreign card import corpus |
| `packages/core/test-fixtures/workflows` | ComfyUI workflow exports in both formats from a stock frontend, with their node definitions and expected outcomes |
| `docs` | Product, principles and architecture |
| `data/` | Local development data directory (`EPHEMERA_DATA_DIR`), Git-ignored |

## Stack

Major versions are architectural choices; exact versions live in
`package.json` and `bun.lock`.

| Layer | Choice | Purpose |
|---|---|---|
| Runtime | Bun 1.4 | Server runtime, package manager, scripts |
| Build | Vite 8, `@vitejs/plugin-react` 6 | Dev server with Fast Refresh, production build, native React Compiler (`oxc-transform-react`, marked experimental upstream) |
| UI | React 19 with React Compiler | Components, native View Transitions, automatic memoization |
| Routing | TanStack Router | Type-safe screens: chat, characters, personas, lorebooks, presets, settings. A lorebook's editor is one component for both of a book's sources, a character's card (`/characters/$id/lorebook`) and the library (`/lorebooks/$id`); its `entry` search parameter is the open entry's index in that book. Settings' `window` search parameter is a model ID (validated as one) whose window field Context scrolls to and focuses, then clears |
| Server data | TanStack Query 5 | Fetching and caching persisted entities; UI settings read once per tab before the first render and saved through one serialized mutation |
| Chat state | Zustand 5, no `persist` | In-memory chat tree with swipes. The thread subscribes to message ids; each turn reads its own message at its place in the thread, checked by id, so a store change costs a turn one lookup and a streaming reply re-renders only its turn |
| Styling | Tailwind CSS 4 | CSS-first design tokens and utilities. Each colour palette defines every colour token once as a `light-dark()` pair, so the theme picks the scheme and `data-palette` on `<html>` (or on a Settings swatch) only the colours; core's `PALETTES` lists them. The default, Tokyo Night (core's `DEFAULT_PALETTE`), needs no attribute: its block also carries `:root` and comes first, so every other palette overrides it by source order. Up to three custom palettes (`custom-1`..`custom-3`) are the same token set as hex pairs, which core's `customPaletteCss` writes as rules for both the server's `/api/palettes.css` and the browser's constructed stylesheet; the editor previews a draft the same way over the whole app, and core's `CONTRAST_FLOORS` are both the built-ins' test and the editor's warnings. Layout widths and container query thresholds are `--container-*` theme tokens; the three breakpoints (tablet, desktop, dock) are defined once in the theme, and the form-factor hook reads them from there. Above full HD the root font size scales with the window's width and height, whichever allows less, to a quarter larger at 4K, so type, spacing and icons grow together |
| Components | shadcn/ui on Base UI | Accessible primitives owned in the repo; the shadcn CLI runs on demand, not as a dependency. Menus scroll within the height their positioner finds. The AI Rework and New art phone sheets opt into Base UI's virtual keyboard handling, which keeps the focused field in view above a software keyboard. Every Find (the gallery, the lorebook library, a book's entries and the checklists) matches each word of the query anywhere in what it searches, ignoring case and accents, and every name order reads case and accents aside and numbers by value, in the reader's locale (`apps/web/src/lib/find.ts`) |
| Chat UI | AI Elements, Streamdown, remark-breaks, remark-smartypants, micromark-extension-directive | Thread scroll owner (Conversation); streaming Markdown rendered inert, a single newline a line break, straight quotes, dashes and ellipses set as typographic ones; word-level fade-in while streaming. Highlights are text directives (only the text form of the directive syntax is parsed) named by core's `HIGHLIGHT_TONES`, rendered as `<span data-tone>` (the sanitizer admits that attribute with those values only), so assistive technology reads the words alone, every other text directive restored as written, and `:thought[words]` (core's `THOUGHT_MARK`) rendered as `<span data-voice="thought">`; a remend handler closes an open highlight or thought while it streams and holds back a cue still arriving (core's `opensCue`); after sanitizing, a rehype plugin sets apart a story paragraph's cue (core's `splitCue`) and quoted speech and marks character lines for CSS |
| Motion | Native CSS and View Transitions; Motion 13 for gestures | Spring curves, `@starting-style`, route and theme transitions; Motion's drag (loaded lazily through `LazyMotion`) swipes a reply on touch and slides alternates, and its layout animation glides reordered greetings and prompt blocks (reorders apply at once, never inside a transition), never in `AnimatePresence`'s `popLayout` mode or its view helpers, which inject `<style>` elements. Streamdown's animate plugin tags newly streamed words with CSS variables and Ephemera's own keyframes fade them in; while a reply is in flight the lamp halo's playback rate changes through the Web Animations API, so its loop never restarts, and the portrait's glow starts at the lamp's phase |
| Extras | Own icon set, Geist, Marcellus, Atkinson Hyperlegible Next | Icons drawn for Ephemera, variable typeface, inscriptional capitals for the wordmark only, Atkinson Hyperlegible Next, a variable reading sans drawn for legibility with a true italic, for the character's prose only; notices are inline or float over the content column, never toasts. The mark (a crescent and its amber lamp) is plain SVG in `apps/web/brand`; the favicon in `apps/web/public` is a heavier small-size cut whose own `prefers-color-scheme` rule switches it to the dark palette (the interface draws the same cut as `MarkIcon`, and the brand's full cut where the mark is shown large), with ICO and touch icon fallbacks. Portrait tint: the chat character's thumb drawn to a 24 by 36 canvas in the browser, a chroma-weighted OKLab hue from its colourful mid-light pixels (none when under 8 % are), and the surface tokens mixed in OKLCH toward that hue at their own lightness by a registered `--tint-mix` (at most 10 % light, 14 % dark, then scaled by the square of how much the pixels' hues agree) that fades in and out on the root; held in component state, nothing persisted or sent |
| Tracked changes | jsdiff (`diff`) 8 | AI Rework's word diffs in the browser: `diffWordsWithSpace` per change, whitespace kept, memoized and cleared with the review |
| Dates | dayjs with `utc`, `timezone`, `duration` and `relativeTime` | Date macros, UTC offsets and relative differences in `packages/core`; naive dates use the browser's zone, including DST. It reaches the browser in the shared API chunk |
| API | Hono 4 with `@hono/bun`, Zod 4 | Validated routes, streaming, typed RPC client, static SPA |
| LLM | AI SDK 7, `@ai-sdk/openai-compatible` | Streaming, abort, reasoning parts, provider quirks |
| Storage | `bun:sqlite`, Drizzle ORM, `node:crypto` | One SQLite database per user, in memory while in use and encrypted at rest (§ Users and storage): characters, personas and their character bindings, prompt presets with their Author's Note (a nullable column; a row without one reads as the default) and sampler presets, library lorebooks (`lorebooks`: a name and the whole book in the embedded book's schema and limits, its compact JSON within the card limit, the book's own `name` mirroring the row's, and the counts the library lists, written with the book and brought up to date when the database opens, so listing never parses a book) and their links to characters (`character_lorebooks`: at most `LOREBOOK_LINKS`, 8, per character, each at a position; a link is appended after the last in one transaction, linking again changes nothing, unlinking leaves the others' positions, deleting either side removes the link, and duplicating a character copies its links), events (`events`: at most `EVENT_LIMITS.events`, 200, each a one-line text, a chance, a cooldown in replies, an on/off flag and a scope of all cards or chosen character ids and tags, the ids held without a reference so an unknown one matches nothing; definitions only, with no column for which event fired where), a character's memory (`memory_notebooks`: one row per character, keyed by it, with the on/off flag, the situation, relationships, facts and threads, and `opening`, the next chat's opening (at most `MEMORY_LIMITS.opening`, 600 characters, empty when there is none); a PATCH carries the notebook whole, and one without the notebook or the opening keeps the stored one; `memories`: at most `MEMORY_LIMITS.episodes`, 2,000, per character, each an episode or a chapter with a per-character `seq`, a title, a summary, cues, how many turns it covered, the chapter that absorbed it and a pinned flag; both cascade with their character, and neither has a column for the turns, the chat or the span a memory came from), characters' cast sheets (`cast_sheets`: one row per character, keyed by it and cascading with it, holding the card fingerprint it was read at, its entries' fixed records without any state, at most `CAST_LIMITS.sheetEntries`, 8, and a `revision` each write increments; a chat's register has no column), up to three custom palettes (`custom_palettes`: by slot 1 to 3, a name, the palette it started from, its colours and the base's by scheme, the roles set by hand; deleting the chosen one returns the setting to its built-in base, or Tokyo Night, the default, in the same transaction), the user's imported ComfyUI workflows (`workflows`: at most `WORKFLOW_LIMITS.workflows`, 24, each a name unique regardless of ASCII case, an image model family, the finalized API template with `{{prompt}}` in the prompt's place, its node count and a `revision`; deleting the one the settings choose returns them to the default workflow in the same transaction), one row of UI settings (theme, colour palette, model, image prompt model (null leaves each image prompt on its surface's default), chosen character and persona, default persona, chosen presets, context windows the owner set for models the provider reports none for, the owner's context limit per model, the ComfyUI address and workflow for card portraits, memory's model, effort and sizes, the cast calls' model and effort (null follows memory's), and `memoryOpening`, whether a new chat opens on the memory's opening, a column with SQL default true; references clear themselves when their target is deleted), and portraits of characters and personas in one table (each row belongs to exactly one owner and holds its dimensions, version and WebP thumbnail, and names the encrypted file under the user's folder that holds its PNG), so an entity and its portrait row change in one transaction, and a portrait's file is durable before any database image that names it. One store per entity, each parsing its core schema on every write. Characters, personas, presets, lorebooks, events, notebooks, memories and workflows carry a `revision` that each update increments; a PATCH names the revision its sheet loaded, and a stale one is refused with 409 and the current revision, checked and written in one transaction, so a tab behind another never overwrites it unasked (the sheet offers Reload or Keep mine, which saves the tab's whole version). A stale PATCH that would change nothing, such as a retry after a lost answer, is answered as saved and writes nothing; after a save whose answer was lost, the sheet sends it again alone, as it was, before newer edits, so it learns the revision instead of meeting a false conflict. drizzle-kit runs on demand (`bun run db:generate`, from outside the workspace) to generate migrations; the server applies them when a user's database opens, with foreign keys off (Drizzle runs them in one transaction, where a migration's own `PRAGMA foreign_keys=OFF` does nothing, so a table rebuild would cascade), checks the result with `PRAGMA foreign_key_check` and only then turns enforcement on. A migration therefore never relies on a cascade. At start the server verifies migrations and the native data upgrade, then durably encrypts every changed database before listening; failure refuses startup. The deploy's pre-migration snapshot is the way back |
| Cards | Own PNG chunk walker, own Zod schemas | Native character JSON uses a strict versioned envelope. Native PNG reads and writes one base64 `ephemera` text chunk. Import-only readers accept foreign V2/V3 `ccv3` then `chara` chunks. Native data takes precedence; duplicates, unsupported versions, mixed shapes and malformed native markers fail closed. Recognized foreign fields become typed camelCase data and unknown metadata is dropped with an import report. Import fits lorebook keywords, names and tags to their limits. Compact serialization and UTF-8 limits live in `packages/core`. The bounded PNG walker strips compressed text before portrait decoding and validates at most one ICC profile within a 1 MiB inflation limit; portrait output strips metadata |
| Images | sharp | Portraits: only the PNG, JPEG and WebP loaders unblocked, header-checked pixel cap, re-encoded to PNG plus a WebP thumbnail, metadata stripped; a JPEG vision copy for model calls; prebuilt for linux-arm64 |
| Lorebook keys | re2js, `Intl.Segmenter` | A character book's regex keys run only on re2js, a linear-time RE2 port, never on the native `RegExp` (card patterns are untrusted; JavaScriptCore's backtracking limit answers "no match" instead of failing). Plain keys match with `includes`; whole words by `Intl.Segmenter` boundaries or punctuation beside the key, so scripts without spaces and possessives work. Every assembly's scan has a deterministic work bound, and entry text is filled and counted only up to the budget's cutoff, within a per-assembly allowance; entries past either are reported, not scanned. A request assembles at most `MEMORY_LIMITS.held` plus three times (Memory, step 9), each attempt with its own bounds so a fold never changes which entries activate. Secondary keys match on the same rules; recursive passes test each key against each chat or entry text once, charged to the same bound, and entries a bound kept a pass from reaching are reported unscanned. An entry's sparse native settings are read and written through one core owner (`entrySettings` and `withEntrySettings` in `lorebook/settings.ts`), and timed effects by another (`lorebook/timed.ts`), whose per-chat state names entries by their library book (absent for the book in the card), their index inside it and a digest of the entry (`Bun.hash`, injected by the server) so an edited entry loses its effect and an effect never moves to another book. re2js reaches the browser only in the lorebook editor's chunks, where the editor flags keys that never match |
| Tokens | gpt-tokenizer (server only) | Budget estimates against the context in use: each model's window as the upstream catalog reports it (or as the owner set it for a model it reports none for), capped by the owner's limit for that model (131,072 tokens unless set; `effectiveWindow` in `packages/core` is the one place the two meet), less the reply length and no margin, calibrated per model from streamed usage. History is trimmed in blocks, whose boundaries a byte estimate places (four UTF-8 bytes a token), so history left out is never tokenized; selection counts native messages and the reply primer. The final wire estimate counts each message's role and text, plus the global primer; the tokenizer's merge cache is off, and a request's fit attempts reuse counts by text only within that request, so no counted text outlives it |
| Quality | TypeScript 7, Biome 2, Vitest 5, Playwright | Types, lint and format, unit tests, browser flows and the retention test matrix |

## Generation flow

1. The web app sends one request with the chat so far, the selected
   character, persona and presets, the generation mode (a reply, a
   continuation of the last reply, or the user's next message for the
   composer; a swipe or a regenerate is a reply over the history before the
   alternate it writes), the chat's timed
   lorebook state (which entries are sticky or cooling down, and since
   which message; each named by its library book, or none for the card's
   own, and its place in that book), the chat's events state (for its
   character, which event fired at which history length), for a character
   with memory on the ids of this chat's memories (§ Memory), both macro variable namespaces, a distinct generation
   type for prompt triggers, transient runtime macro inputs, the browser's
   clock and timezone for `{{time}}` and `{{date}}`, and the chat's cache
   affinity id (`cacheKey`, a UUID; previews carry none).
   Model limits come from the upstream's model catalog. The server asks
   `/v1/models?client_version=&detailed=true` first (CLIProxyAPI reads
   `client_version` and answers its rich catalog, `{models:[{slug}]}`;
   providers that read `detailed=true` add each model's limits; other
   providers ignore both), and on a 4xx or a body that is no catalog asks
   the plain `/v1/models` once within the same 8-second budget. Core's
   `modelsFromCatalog` reads three envelopes, `{models:[...]}`,
   `{data:[...]}` and a bare array, preferring `models` when a body has
   both, and is the one place that knows each provider's field names. Each
   value is read only when well formed, first field first: the context
   window from `context_window`, `max_model_len`, `context_length`,
   `max_context_length`, `top_provider.context_length` or
   `metadata.context_length` (never llama.cpp's `meta.n_ctx_train`, the
   training context rather than the serving limit); the output limit from
   `max_completion_tokens`, `top_provider.max_completion_tokens` or
   `max_output_tokens`; image input from
   `input_modalities`, `architecture.input_modalities`,
   `capabilities.vision` or a `vision` tag in `metadata.tags`; reasoning
   levels from `supported_reasoning_levels`, `effort.supported_levels`,
   `reasoning.supported_efforts` or `capabilities.reasoning_effort`, with
   `capabilities.reasoning: false` meaning none. Anything else reads as not
   reported, and a body that is no catalog is invalid. Both requests log
   operational fields only (`upstream.models` with status or error class)
   and carry no `Authorization` header when no key is configured. The
   server keeps the last catalog for a minute, and requests arriving
   together share one refresh; it is model metadata, not chat content. A
   request whose client left while the catalog loaded is not assembled.
   For a model CLIProxyAPI has no registry metadata for, its catalog clones
   a template entry (v8.0.32: a 272k window, image input and efforts low to
   xhigh) and overwrites only what the model's config gives, so that
   window, image input and those efforts are not measured
   values; the owner's per-model context limit below is what caps the
   window. A model with no reported window uses
   the one the owner set in Settings, else nothing is sent to it.
   `effectiveWindow` in `packages/core` caps that window by the owner's
   limit for the model (`DEFAULT_CONTEXT_LIMIT`, 131,072, unless set), and
   every reader of the window (budget, reply reserve, lorebook budget,
   runtime macros, meter, inspector) uses the result.
2. The server loads the persisted entities and calls `packages/core` to
   assemble the prompt: macros, lorebook activation, block order, depth
   injections and history selection (newest turns first, with examples only
   when all history fits). System blocks can sit between turns, so
   the AI SDK call allows system messages; chat turns themselves are only
   user or assistant. Each native example passage is a self-contained system
   block with speaker labels and ordinary prose. No protocol `name` is sent.
   Earlier user turns retain attribution when their speaker differs from the
   current persona. Single-message provider processing labels history once,
   using request-local metadata that never reaches the inspector or wire.
   The preset's Author's Note, while on, goes in at its depth among the in-chat blocks,
   or right after the main prompt's place, when its frequency is due. Its
   every-N cadence counts live user turns and the chat's `foldedUsers`,
   so a memory fold preserves both the note and its lorebook entries' eligibility. At
   one depth, in-chat messages go deepest first, then by the block's `order`, then
   the assistant's, the user's and system; those of one depth, order and
   role are sent as one message. Continue and Write for me append their native
   action instruction last when nonempty. Continue sends the existing reply
   after post-history instructions, then joins the new text through core's
   `joinContinuation`. Provider role constraints still apply: a model that
   refuses later system messages needs the configured per-model role processing.
   The character's lorebooks are the
   book embedded in its card and the library books linked to it, which the
   server loads from the requester's store in link order; they are activated
   together as one list, the card's own first, under one shared budget (the
   largest any of them allows). Entries are read against the last turns
   (their book's scan depth or an entry's own, each turn as `Name: text`),
   using the turn's original speaker, or the current persona or character
   name for an unnamed turn, in generation and memory canon alike;
   primary and secondary keys under the entry's logic, then, for the books
   that turn recursion on, again against the text of the entries sent so
   far until a pass brings in nothing. Timed effects
   decide first: sticky entries go in without their keys, entries cooling
   down or delayed stay out. Entries are fitted within a budget of at most
   a quarter of the context in use, counted with the same calibrated
   estimate: sticky entries first, then direct matches before recursed
   ones, higher insertion orders first. They go where their placement
   says: the preset's two lorebook blocks before and after the character,
   example blocks around the card's examples, the Author's Note's message
   around its text, or the in-chat messages at their depth and role after
   the notes of that depth. Activation is provisional until core assembly
   and token fitting know which entries contributed text to the selected
   messages. Example speaker lines and continuations retain entry provenance
   through parsing, so partially retained example groups count only their
   contributing entries; wrapper-only examples count none. Missing placement
   hosts, omitted text and examples dropped by fitting start no timed effect.
   Earlier valid timed records keep their start even when their entry is
   omitted, and fitting retries resolve independent results from the same
   activation snapshot. Which entries went in, and why, travels in the
   prompt part as chat content, with the next timed state.
   Events (`packages/core/src/events/`) roll only for a reply that is sent,
   first send, swipe or regenerate, and only with a character: the server
   reads the requester's events and keeps those that are on and whose
   scope takes in the character (all cards, its id, or any tag its card
   carries, matched exactly). The carried state is read against the
   request's history: a record of another character, a deleted event or one
   out of scope is dropped, a record whose turn in the history is not an
   assistant reply (the reply it fired on is being regenerated, was
   deleted, or failed or came back empty and so was never sent on) is
   dropped, and an event stays out while fewer than its cooldown of assistant replies follow
   the one it fired on. A negative start names a firing reply inside folded
   memory; its optional `foldedReplies` counts replies after it and before
   the live history, and every live assistant reply counts after it too.
   Unfolding the firing reply removes that count and restores ordinary
   regeneration and deletion handling. Each remaining event draws its chance once from the
   request's random source; of the hits, one drawn uniformly goes in, its
   text filled by the macros and wrapped as "[Direction for your next reply:
   ...]" in a system message with the prompt source `event`, after every
   other depth-0 message, or last when the preset sends no history.
   Assembly never merges it with another message and it is never trimmed; the model's post-processing (merge,
   semi-strict, strict, single) then treats it as any late system message,
   so it may be merged into a neighbour or have its role changed, and the
   inspector then shows it among that message's merged sources. The next state keeps
   the standing records and adds one for the event only when the assembled
   prompt carries it, at the request's history length; it travels in the
   prompt part beside the timed lorebook state, left out when it holds no
   record, which the store reads as no state. Continue and impersonate
   roll nothing and return the carried state as it came; a preview draws no
   random number for events and returns it unchanged too; a reply without
   a character carries none. A request refused before its prompt is
   delivered commits nothing.
   History that does not fit is left
   out a block at a time: a block holds an eighth of the prompt budget
   (`HISTORY_BLOCK_SHARE`), sized once per request so post-processing
   retries never move it. Boundaries run from the chat's start and are
   placed by a byte estimate of the older turns alone (role, name and
   content, four UTF-8 bytes a token), so a growing fixed block, a
   calibration change, the draft or reasoning dropping off a newer reply
   moves none of them. The block size follows the prompt budget, so a new
   reply length in the sampler preset or a new context limit resizes the
   blocks and moves the boundaries once. The fit keeps the longest suffix
   that starts at a boundary, so the first turn sent stays put while the
   chat grows, moving about once per block of new chat and losing about one
   block (a large append can skip several). Boundaries hold while the text
   of older turns is unchanged; an edit or a deletion in a turn left out
   can move them once, and a variable macro such as `{{random}}` or
   `{{time}}` there, expanded again for every request, can move them on
   every request while it stays in the older history. The fit is
   stateless: the same assembled input, budget and calibration select the
   same turns, so a preview and its send agree, and a lorebook block whose
   size swings around the slack can drop and restore one block on
   alternate turns. When even the newest block does not fit, trimming falls
   back to per message within it. Post-processing keeps the original budget
   and reduces explicit selection caps, examples before history. A few
   proportional hints followed by geometric reduction and binary refinement
   bound candidate trials by the logarithms of the example and turn counts.
   Identical selections are processed once and unchanged plain message
   counts are reused within the request. Post-processing can cost more with
   fewer turns (a Strict placeholder), so an unsuccessful block fit falls
   back to per message. Before refusal, the actual minimum and Strict's
   shortest user-opening suffix are processed even if plain selection costs
   would refuse them. The chosen candidate supplies its own counts and
   lorebook delivery state. This bounded search does not prove feasibility
   for every intermediate selection under arbitrary nonmonotonic token
   counters. The inspected prompt's `trimming` says which happened
   (`exact`, `blocks`, `blocks-fallback`).
3. AI SDK `streamText` calls the upstream through `upstream.ts`, the one
   owner of every model call (the provider, call settings, effort, cache
   key, retries, error logging and codes), with streamed usage enabled
   (`includeUsage`) and the chosen sampler preset's set values as call
   settings; values left at the model default are not sent, and every
   effort, `max` included, goes as the SDK's `reasoning` setting. Without
   a configured key no `Authorization` header is sent, for a local server
   that needs none.
   CLIProxyAPI v8.0.32's Codex translator drops `temperature`, `top_p` and
   `max_tokens` and sends `reasoning.effort` medium when none is given, so
   on the GPT (Codex) models behind it the sampler preset's values have no
   effect and only an effort does. A request
   with a `cacheKey` sends it as body `prompt_cache_key` (an option the
   OpenAI-compatible provider spreads into the body) and header
   `x-session-affinity`, held only for the request. CLIProxyAPI forwards
   both: its Fireworks provider has `support-prompt-cache-key: true`, and
   in v8.0.32 `X-Session-Affinity` is a general session-affinity input to
   its credential selection, ahead of `prompt_cache_key`. Every model call
   sends one: the creator's per request, memory's per character. A
   provider that refuses the field (a 400 or 422 whose error body names
   `prompt_cache_key`, read in memory up to 64 KiB and never logged) gets
   the call once more without the field and the header; once such a retry
   succeeds, the upstream sends neither again until the server restarts,
   and logs `upstream.cache_extensions_off` once. The same fallback covers
   two more fields. A refusal naming `max_tokens` or
   `max_completion_tokens` gets the call once more without the cap, which
   the next call sends again. A refusal naming `stream_options` or
   `include_usage` gets it once more without `stream_options`; once that
   succeeds, the provider's `transformRequestBody` leaves the field out
   until the server restarts, the upstream logs
   `upstream.stream_usage_off` once, and streamed calls report no usage.
   One call drops each field at most once. An error that names none of
   the fields the call sent is not retried. `EPHEMERA_UPSTREAM_SESSION_CACHE`
   (`on` unless set to `off`) switches both off from the start; the key is
   then left out of every call (`Upstream.settings`). A call
   the provider answers with 408, 409, 429 or 5xx before any output is
   retried twice by the AI SDK, after the provider's `Retry-After` (up to
   60 s) or a backoff of 2 s then 4 s; the request's deadline ends any
   wait. A provider still answering 429 or 503 after the retries ends the
   stream with the error text `upstream_busy`, every other failure with
   `generation_failed`, and the reply says the model is busy. The AI SDK's
   warnings are logged as `ai.warning` with the model, the warning's type
   and its feature or setting, never its message or details. The finish
   part's metadata carries the counts the provider reported, read by
   `reportedUsage` in `usage.ts` as every call's are: the model's
   `inputTokens`, and its `cachedTokens`, `outputTokens` and
   `reasoningTokens` when the provider gives them; a reply without
   `inputTokens` carries none and calibrates nothing. The response is an AI SDK UI message stream whose first
   part carries the exact assembled prompt, its mode and the preset's
   continue postfix; reasoning streams as its own parts. The server aborts upstream when
   the client disconnects and releases all request data when the stream
   ends. While the stream is open the AI SDK writes an SSE comment frame
   (`: keep-alive`, no content) after every 20 s without a part
   (`keepAliveMs`), because Cloudflare ends a response after 125 s without
   bytes and a model can reason silently for longer; the client's
   event-stream parser skips comments. A frame is skipped while the client
   is not reading, and the request's deadline errors the stream, releasing
   what it queued (`keepalive.ts`).
4. The web app reads the stream into the Zustand chat store, accepting parts
   only for the current session epoch. The store owns alternate replies,
   each with its reasoning, which is shown. A request carries only the
   reasoning the prompt preset's Add to Prompts sends back, for its latest
   replies (every reply's while the preset is not yet known), and the server
   adds exactly that to the prompt. `useChat` is not used because regenerate
   would replace swipes. A continuation is
   joined to its reply with the postfix from step 3; an impersonation fills
   the composer's draft. The inspector's "last sent" view shows the prompt
   from step 3, so it is exact, with the model's count and `cachedTokens`
   once the reply finishes, and what it wrote and how much of that was
   reasoning, as given; a reasoning share of 0, which most providers
   report for none, is left out. The store keeps the timed lorebook state and
   the events state from a generation's prompt part beside the session
   epoch, alongside local/global macro state; a preview never changes any
   of them, and Clear, a reload and `pagehide` empty them with the chat.
   Deleting one message drops the record of an event that fired on it and
   moves later records down by one; deleting a message and everything after
   it drops the records from there on.
   Provider finish reasons `length` and `content-filter` remain on the reply
   for its footer, including reasoning-only endings. Continue clears the old
   reason and takes its own finish reason; a partial continuation invalidates
   the cast snapshot until a complete reply can be processed.
5. The store requests a dry-run preview of the next request after a pause
   whenever the chat, the draft or the selection changes (never while a
   reply streams). The context meter and the inspector's preview read it; random macros, lorebook trigger chances,
   event pool draws and edits made in between can make it differ from what
   is later sent, and it never rolls events, so the UI labels it a preview.
   For the same model, the inspector compares the preview with the last
   prompt sent on render, message by message on role, name and content,
   and marks the first difference with a rule; the tokens shared before
   it, prorated within the differing message, are an estimate of the most
   the provider's prompt cache could serve. Nothing of it is kept.
   A card's greetings are filled with the same core macros in the browser
   when a chat opens on them. Candidate greetings evaluate independently
   from the same state; each keeps its key and written text through blank
   filtering, and only the selected greeting's state is committed. The
   candidates are core `greetingCandidates`: with the `memoryOpening`
   setting on, memory on for the character and a non-empty opening, the
   memory's opening first (key `memory`), then the card's first message
   and alternate greetings (keys `card:<i>`, `i` indexing
   `[firstMessage, ...alternateGreetings]`). The opening is filled on a
   macro work budget of its own and left out alone when its macros pass a
   bound. A refill keeps the shown greeting by its key, and the shown
   reply's key tells whether the opening is in play. The card is never
   written.
   Required character, persona and preset loads must finish before filling;
   a failure leaves the greeting unfilled with Try again, which refetches
   failed reads. An older fill cannot replace a newer greeting or survive Clear.

The server holds chat content only for the duration of one request.

`MacroInput` is the shared greeting, user-text and model-display input:
loaded character/persona, selected preset and preference flags, history,
state, resolved model/window/reserve and browser clock. Before an action fills macros, the browser waits for selected entity
and catalog reads, then rechecks their cache values and relevant settings.
A changed selection or read refuses the action. Regenerate, Continue and
new-alternate actions also pin the reply they started from; an edit, swipe
or deletion while loading prevents them from overwriting another reply.
`fillChatText` clones its input state and returns filled text and a
working state. `MacroState` bounds both string-record namespaces together
and never enters persisted entity schemas. Core assembly prepares cached
card sources against a blind field context, then fills enabled
main/custom/post-history text in prompt order.
Metadata lookups evaluate the raw field at the point used; persona source
text reads prepared fields after that text pass. Each source block's optional
template frames its nonempty text at `{{content}}`; the shared core schema
requires that literal placeholder when the template is nonempty.

Filled greetings and user turns remain literal history. Generated assistant
turns carry raw text with the optional `macroEligible` marker, validated for
assistant turns only. An optional `macroPrefixLength` marks a literal edited
prefix before a raw generated continuation; it never exceeds the content's
length and requires the eligibility marker. Assembly fills generated text
after prompt text, before budgeting, with reasoning in its normal position.
Each turn evaluates on a cloned state and commits only on success. A per-turn
macro limit keeps that raw turn literal and discards its partial variable
effects; aggregate limits and other failures still refuse the request.
If filling newly received model text fails, the browser keeps it literal,
shows a notice and discards that fill's variable effects. The reply is sent
as shown thereafter.
When filled generated output differs from its raw content, the tab sends
`scanText` alongside it for lorebook scanning. Only macro-eligible generated
assistant turns may carry that field. `scanTextOf` falls back to `content`
for legacy turns and removes highlight and thought markup; recursive
lorebook entry scanning uses the same normalization, so keys match the words
rather than directive names.
Unmarked legacy turns stay literal. Token fitting and retries
reuse the filled assembly and never repeat macro effects. Each expansion is
bounded, with separate 32 Mi-character aggregate macro-output and history
bounds. One foreground action also shares a 32 Mi-unit macro-work bound
across field preparation, prompt assembly, entry bodies and generated history,
including intermediate indexed JSON and a weighted charge per variable each
time a substitution or card field recounts the macro state. Lorebook key
scanning and entry bodies have separate finite work allowances, so key
exhaustion preserves candidates already found while body exhaustion leaves
remaining candidates unscanned.
Both also charge the action's shared bound. A greeting batch expands the
example dialogue once, shares that bound across isolated candidates, keeps
completed choices and stops on exhaustion. Background prompt recounts are
intentionally absent (PRODUCT.md § Prompt and lorebook behavior).

Token selection counts native blocks and history before provider role processing.
In-chat placement changes order, not those separate costs. The final wire cost is
checked independently because joins can increase token counts. Both passes reuse
request-local counts and preserve inspector provenance.

## Memory

A character with memory on remembers its story across chats
(`PRODUCT.md` § Memory). Memory is on by default: one core rule
(`memoryIsOn`) reads a character without a notebook row as on, and
`memoryStateOf` gives it an empty notebook at revision 0. The first write
that needs the row (turning memory off, a notebook edit, a memory written)
creates it in its transaction, at revision 1 as the first edit of a row at
revision 0 would, so a first edit racing a first memory resolves as any
two edits do. Forget everything deletes the episodes and empties the
notebook and the opening but keeps `enabled`; its route answers with the memory as it left
it (the notebook row at its new revision, or null without one, and the
episodes), which the screen takes into its cache and starts the notebook's
editor over on. The web reads memory as on only once the
character's memory query has loaded (`memoryOnIn`, one owner for the
chat, its mark and the ending offer): before that, and for a character
deleted elsewhere (its refetch fails `not_found`), the chat sends no
`memoryState`, starts no memory call and shows no mark. The domain lives in `packages/core/src/memory/`:
schemas and limits (`MEMORY_LIMITS`), the two calls' prompts, reading
their answers (`answer.ts`), roll-up and recall; the token estimate is
core's (`tokens.ts`); the server's routes and calls in
`apps/server/src/memory.ts`, its store in
`apps/server/src/persistence/memories.ts`; the screen, the sheet's section
and the queries in `apps/web/src/memory/`, the seam and the mark beside the
thread.

The notebook's Cast list stores at most 32 JSON strings of 1,200 characters
each. Core derives their schema from `castAnchorSchema`: name and gender are
required, the existing fixed anchor fields optional, and ids and scene state
forbidden. Owner lines that do not parse remain editable and do not seed.
New or changed model lines must validate; clamping never cuts their JSON.
Untouched lines stay word for word. The `memory_notebooks.cast` JSON column
defaults to `[]`, including migrated rows. A notebook PATCH carries cast with
the rest of the notebook, and every notebook answer and remembered-answer
replay carries it.

1. **Trigger.** After a reply or continuation settles for the current
   epoch, the chat store takes the unremembered messages (from where the
   remembered ones end, held or folded) but the newest
   `memoryKeepTurns` and estimates their shown text with `estimateTokens`
   (four UTF-8 bytes a token, the estimate block trimming uses). At
   `memorySpanTokens` or more, and at least two turns with text, it calls
   once; Remember now skips the size. A new span (`spanToRemember`, for the
   call and the screen alike) ends at its last turn with text: trailing
   messages no turn comes from (a blank slot waiting for a sign-in, a
   failed or empty reply) stay outside it and open; a lost answer's span
   goes again as it was. One call runs at a time, beside any
   generation. The store records the span's end as a message index
   (`boundary`) and, while the call runs or its answer is lost, refuses
   edit, delete, swipe, regenerate and continue below it (`lockedBefore`),
   so the answer holds exactly what was sent. The same lock covers every
   remembered turn, held or folded. It is checked again where a reply is
   written (`generateReply`, `continueLast`), so an action or a sign-in
   resume whose reply locked while its subject loaded writes nothing;
   a resume refused so returns at once (a renewal never waits on an
   unconfirmed memory) and keeps its generation waiting, which goes on its
   own, once, when the lock ends (a refusal, a reset or a Forget), from a
   store subscription after the change is whole, while it is still the one
   waiting in the same chat, nothing else runs or loads, and the session is
   back with its saves ended. A reply a memory holds stays as it was. An
   open message edit in the span (`editHolds` over
   `spanToRemember`, a lost answer's own span on a retry) holds the call
   before anything locks or goes out, so an unsaved correction is never
   remembered as it was nor locked away: Remember now says why it waits,
   and an automatic call held so is asked for again, from the same
   subscription, whenever the open edit closes or changes (saved,
   cancelled, deleted, ended by a swipe, Replace or Continue, or another
   opened); another edit in the span holds it again, and once a reply is
   streaming its settling asks instead. The ending (`rememberEnding`, offered by Clear's dialog and the
   start-chat dialog while memory is on and a turn or more is
   unremembered) is the same call with no turn kept out, no size and a
   single turn enough (the remember route takes one turn or more). It
   first lets a reply still streaming settle whole, then waits for a
   memory call or a Forget under way, and calls again while turns remain
   after a written one. It resolves done once no unremembered turn is
   left, failed with the reason (no model chosen among them), editing
   while an open message edit is among its turns (nothing written, and
   the dialog asks to save or cancel it first), or cancelled when the
   chat was cleared or memory reset meanwhile. The
   dialog clears or switches only on done, for the run it started and
   the chat it started on, and leaves the chat as it was on failure. A
   lost ending is no exception to the lock: its attempt and span are kept
   in the tab and its turns stay read-only, dialog or not, while Keep
   chatting, the composer and the turns after them stay open. The next
   call over the same span (Try again, Remember now, the next reply's, one
   turn if that is the span) sends the same attempt and the same turns,
   so a memory the server wrote is answered for the text it was written
   from, never written twice nor held over a correction; its answer, or a
   refusal, or Clear, ends the lock. The server keeps no span between
   requests, so the tab's lock is what holds them alike.
2. **The remember route.** `POST /api/memory/remember` is bounded as
   `/chat` is (body limit, request lifetime, abort on disconnect) and
   carries the character, persona, model, effort, the span as turns
   in their shown text (reasoning left out, macros already filled), this
   chat's folded episode ids in order (`episodes`), the ids of the
   memories it holds (`held`) and an attempt id. The effort goes as the model offers it
   (`effortFor`, as every creator call narrows it), the model default otherwise,
   to both calls. Every reader of a chat's episode ids (this route, its
   replay and prompt assembly) reconciles them with the book by one core
   rule (`reconcileRecap`): ids that still exist, a member a chapter
   absorbed replaced by its outermost chapter, in order, each once. Before
   any call it refuses `memory_off` when memory is off for the character or when
   memory was forgotten or turned off since the request entered its
   character's queue, `context_window_unknown` as `/chat` does,
   `too_many_memories` when the book is full, `too_many_chat_memories`
   when the reconciled folded and held lists already hold 200 episodes
   together, and
   `prompt_too_long` when the input's
   calibrated estimate leaves less than `MEMORY_LIMITS.replyReserve`
   (8,192) tokens of the window. A queued request answers 200 with
   `application/json` at once, before waiting for the preceding write and
   running these checks; its refusals arrive as `{ error }` in that body.
   An unqueued request keeps the checks' HTTP refusal statuses and, past
   them, answers 200 at once (`streamedResponse`, `streams.ts`, which the
   creator's streams use too). Blank lines keep
   the connection open through Cloudflare (`keepalive.ts`), a JSON parser
   skips them, and one JSON text ends the body, the memory or `{ error }`
   for a refusal decided after the call.
3. **The call.** `generateText` for plain text, with helper input counted as
   framed system/user/assistant messages plus the global primer
   (`helperInputTokens`), multiplied by the model's calibration ratio.
   `roomFor` refuses through core's `answerRoom` when less than 8,192 tokens remain. Every
   `object-call.ts` caller shares `CREATOR_LIMITS.maxOutputTokens`, 100,000,
   capped by the remaining window and the model's reported output limit. The current call's raw reported input usage
   updates per-model calibration under chat's admission rule (`calibrate` in
   `generation.ts`: `MIN_CALIBRATION_SAMPLE`, `MAX_CALIBRATED_MODELS`),
   independently of accounting's record bound.
   Missing counters stay unknown; reported zero stays zero. The call uses
   the reasoning middleware, the request's deadline, the character's cache
   key (a keyed hash of the character id under a random salt the instance
   holds in memory only) and the AI SDK's retries of a busy or failing
   provider. No `response_format` is sent, since some providers (GLM
   Flash, muapi) refuse any, so the instructions (Ephemera's own
   text) describe the object key by key and ask for dense, event-first
   prose, a summary of about one word per fifteen of the span (60 to 400)
   that opens with the in-story time when the span gives it and tells what
   happened without restating what the current notebook holds (what the
   span established is still told as events), cues of one to three words
   without an article, and the notebook's changes only: the situation
   rewritten whole, giving the in-story time when the span does, and for
   relationships (one line per pair, both names first, changed as it
   changes, at most 16), facts (one per line, never a relationship, at
   most 40), threads (at most 12) and cast (at most 32) the lines changed and dropped, by
   their number in the message, and the lines added, each as short as its
   content allows. Core `applyMemoryAnswer` applies them to the notebook
   the message showed: every line not named stays word for word, a line
   both changed and dropped goes, a copy of a kept line is not added, and
   a full list takes no line past its bound. The answer's last key,
   `opening`, is the next chat's opening: a Location line, an empty line
   and one placing sentence in the present tense, composed from the
   creator's shared opening rules (`LOCATION_OPENING`,
   `OPENING_RESTRAINT`). The clamp sets its Location line with
   `formatLocationLine`, then cuts it to `MEMORY_LIMITS.opening`; a
   missing or blank one is stored empty, replacing the old one, and
   never fails the call. When a full notebook would
   take more than half the memory blocks' share of the call's window
   (`notebookRoom`), the instructions give its room in characters and the
   message its current size. They name the story as one in which the user
   plays opposite a card of any kind (one character, several, or a
   scenario and its cast) and its reader as the model that tells the
   story. The message carries canon, the current
   notebook with each list's lines numbered and counted against its bound,
   the last three of this chat's reconciled memories, folded then held, as
   context only (the latest three of the book's story, in story order, when
   the chat has none),
   and the span as `Name: text` lines, each section in its own tag
   (`<canon>`, `<notebook>`, `<earlier_memories>`, `<span>`), and ends with
   one line restating the task. Canon (core `memoryCanon`) is what
   every reply already sends: the card's description, personality and
   scenario and the persona's description (`Persona (name):`) with
   `{{char}}` and `{{user}}` filled as names, and the entries
   of the card's book and its linked books that are constant or whose keys
   the whole span matches, found by the lorebook's own activation with
   chance and timed effects set aside and bounded by the lorebook budget
   for the call's window less the card fields. The instructions forbid
   recording it; it is chat content, built for the call and never stored,
   kept or logged. The optional `castContext` comes only from the newest
   valid snapshot at or before the remembered span's boundary, or is omitted.
   It carries effective anchors and voice/goals/knowledge continuity, without
   scene ids, aliases, roles or volatile state. The archivist reads it as
   context that may lag, never as a direct persistence write. Only the
   validated memory answer can change the notebook. The answer is read by core's
   `repairObject`: the last
   balanced `{ … }` block that parses and validates, so a draft before the
   final object or a stray brace in prose costs nothing (blocks inside one
   that parsed are not candidates), each brought within `MEMORY_LIMITS` by
   core's clamp (strings cut at a word break, lists sliced, blank lines
   and unknown keys dropped) before the strict parse. An answer that ends
   at its output limit (`length`) is unusable even when it parses; an
   unusable answer runs the call a second time, then answers
   `memory_failed`. A failed call is
   not repeated: past the retries it answers `upstream_busy` (with
   `retryAfterS` when the provider said) for a provider still busy, else
   `memory_failed`. The chapter call
   follows the same protocol with its own instructions, schema and clamp;
   its message carries canon matched against the members, the notebook as
   already kept, and the members, a chapter among them marked as such, in
   `<canon>`, `<notebook>` and `<memories>`. A chapter's summary has its
   own bound (core `chapterRoom`): a quarter of the recap budget it lives
   in, four characters a token, within an episode's 4,000 characters and
   `MEMORY_LIMITS.chapterSummary`, and its instructions state it.
   A summary past it is not cut: the second call, when the window holds
   it, follows the answer with a correction asking for the same object
   compressed to the bound. Only a correction that overshoots too, or one
   the window has no room for, is cut at a word break; a correction that
   is unusable or fails keeps the first answer, cut so. A cut that leaves
   no valid chapter writes none, and the episode stays the answer.
4. **The writes.** One character's calls run one at a time: the instance
   queues them per character, so a call reads the notebook only once the
   one before it wrote, and a call waiting its turn still ends at its
   deadline. One transaction writes the episode at the next `seq`
   and the notebook with the model's edits applied. Memory turned off or
   forgotten meanwhile writes nothing and answers `memory_off`, even when
   it is on again: the instance counts, per character, how often memory
   went off or was forgotten, and a call that saw another count writes
   nothing. A notebook the owner edited
   meanwhile (its revision moved) keeps the edit, and the answer carries
   the stored one. Every write parses a core schema first.
5. **Roll-up.** When this chat's folded episodes weigh more than the
   recap budget by `estimateTokens`, or number more than 40, the
   oldest half (never the newest two, and only when that is two or more)
   merges into a chapter by a second call, written in its own transaction
   with the members' `chapterId` set. The transaction refuses (`stale`) when
   a member is gone, was edited or joined a chapter since it was read. A
   chapter call that fails or is refused, or an exception anywhere in optional
   roll-up after the episode and notebook commit, is logged by class and leaves
   that committed success with its call accounting. Replaying the attempt returns
   that success without writing another episode; the next memory may try roll-up
   again. Memory forgotten or turned
   off during the chapter call writes no chapter, and the episode already
   written is still the answer. The recap budget (core `recapBudget`) is
   the memory blocks' 12% of the call's window, less the notebook's
   estimate and a quarter left to recall, never under 1,000 tokens;
   Settings' `memoryRecapTokens`, null (Automatic) by default, caps it.
   Held memories, the new one among them, are never members: their turns
   are still sent, and a fold brings them into the recap first, so roll-up
   lags the folds by one call while the story block's share keeps it
   bounded. A call that rolls up no recap rolls up the book's story before
   the chat instead, by the same rule and budget: the episodes and chapters
   no chapter holds, in story order (core `bookStory`), but the chat's own
   (its folded and held ones and the new one), so a long story told across
   many chats keeps fitting, its oldest part merged again and again.
   Members whose chapter call would leave less than the reply's reserve
   are halved, oldest kept, two at least, until it fits, so a long book
   in a small window still condenses a part on every call. The server
   knows only the requesting chat's memories, so a book roll-up may take
   another open chat's; that chat then tells the chapter in their place.
   One call writes at most one chapter. The answer carries the episode, the
   notebook, the chat's folded list (`recapAfter`: the reconciled list, a
   recap's chapter first in place of its members, never the book's,
   without the new episode, which joins the held spans) and the chapter,
   if any. A request without `held`, from a tab
   built before held memories, folds its span at once, so its list ends
   with the new episode.
6. **Idempotent attempts.** The instance reserves each attempt id when
   its call starts and keeps the last 16 settled outcomes in memory, never
   evicting a running one: a repeat while the call runs awaits it, a repeat
   after it gets the kept answer, and a refused attempt is dropped so a
   retry calls again. The call ends only once every request awaiting it
   has ended, so a repeat outlives the lost connection that started it. An outcome holds the memory and the chapter only,
   with the character; it is answered, the first time or kept, while its
   episode still exists, without a chapter deleted since, whatever memory
   did meanwhile; once the episode is gone (Forget, a delete) it is
   dropped and answers `memory_off`. So `memory_off` always means nothing
   of the attempt stands, and the tab's retry under a new attempt never
   writes the span twice. Each answer builds the chat's episode list from its own
   request and the book as it is then, so a chapter written since stands
   in place of its members. The
   tab sends the same attempt again after a lost answer, and a new one
   after a refusal or once the remembered end moved (a fold moves only
   the horizon, so it keeps the attempt); so a lost answer says the
   outcome is unconfirmed, that its turns stay read-only until confirmed
   and that Try again recovers it, and only a
   refusal says the memory was not written. A retry after the kept
   answers are gone (evicted, an idle instance flushed, a restart) writes
   a second memory of the span, which the owner can delete.
7. **The hold and the fold.** On success for the current epoch the store
   holds the span (`held`, message indices `[from, to)`, oldest first,
   contiguous from the horizon) and takes the folded list; nothing folds
   yet. Requests and previews send the messages after the horizon, held
   turns first, with `memoryState: { recap, folded, held }`, each held
   span as its id and the turns it covers as the request sends them. The
   server assembles with nothing folded; only while the fit trims history
   does it fold the oldest held spans (step 9), and the prompt reports
   `memoryFold: { spans, turns }`. A send's fold is applied by the tab when
   its horizon and held spans are still those the request was built at:
   the horizon moves to the last folded span's end and their ids join the
   recap. Otherwise (a Forget, reset or deletion meanwhile) nothing is
   applied and the next request folds again. The prompt's lorebook and
   events states are relative to the history it kept; the tab moves them
   by what its horizon moved since the request less the turns the prompt
   folded, which is zero once applied, so no fold shifts them twice. Only
   a horizon move shifts the states; holding a span never does. A
   preview's fold is only shown: the trim point and the draft's index
   start after its turns. `folded` (the sent turns the horizon holds,
   bounded by `MAX_FOLDED_TURNS`, far past one request's turns) keeps
   lorebook delay counting the whole chat. Unfolded history can reach the
   request bounds (`MAX_CHAT_TURNS`, `MAX_CHAT_BODY_BYTES`, both in core):
   past either, or past `MEMORY_LIMITS.held` (40) memories held, a send or
   preview folds the oldest held span in the tab and builds the request
   again; with none held it goes as before, for the server to refuse. The
   held bound lets roll-up, which takes folded memories only, keep a
   chat's memories far below `RECAP_IDS` when its window never fills. Clear aborts the call, and a late
   answer for an older epoch is dropped while the server's write stands.
   Forget on the seam deletes the latest memory: a held one's turns stay
   sent and are remembered again by the next call; a folded one moves the
   horizon back. Turning memory off, Forget everything or another
   character unfolds the chat and empties both lists. An episode the
   server no longer has, once the memory query reloads, leaves the lists:
   the latest frees or unfolds its turns, an older held one's turns join
   the next held span, an older folded one only leaves the recap.
8. **Recall and placement.** For a character with memory on, in a request
   that carries `memoryState` (one without gets no memory),
   `generation.prepare` passes core assembly the notebook, the request's
   folded episodes and the held ones this prompt folds, reconciled with the
   book (`reconcileRecap`), and every other episode as a recall candidate
   but the held ones and any chapter that took one since: a held memory's
   turns are in the history, or its memory is in the story block, so it
   is never recalled. Every request
   also gets the story before the chat: the book's story but the chat's
   own folded and held memories (`bookStory`), its newest whose estimate
   fits the memory blocks' share (`latestWithin`), computed per request and
   never stored; those the story block tells are no recall candidates, and
   those left out of it for room join the candidates, as the recap's do.
   The story block, "The story so far" with "Where things stand",
   "Relationships", "What holds true" and "Open threads" from the
   notebook, then "Before this chat" and this chat's "Earlier in this
   chat", goes as a system message right before the history, after every
   preset block before it, so it changes only when a memory lands and the
   provider's cache keeps it. In a chat with no memory of its own (recap,
   held spans and folded turns all empty) a line under the heading says it
   is a new scene set some time later, in which everyone keeps what they
   remember and an opening that reads as a first meeting of people who
   know each other is a reunion, and the situation is headed "Where the
   last scene ended". When the request's `memoryState.continued` is true,
   which the tab sends while the greeting in play is the memory's
   opening, that line is core `CONTINUED_SCENE` instead: the chat opens on
   the day after the last scene ended, its opening message being that day
   as the ending left it, and the block goes in even when the notebook and the book are empty.
   `continued` is chat state, defaults to false, and counts only in a
   chat with no memory of its own. Recalled episodes go in-chat at
   depth 4 as one user message (CLIProxyAPI hoists a mid-chat system
   message into Claude's system prompt, which would change the stable
   prefix), ranked by `rankRecall` against the last
   four turns: whole words in any case, a plural's "s" set aside; a cue's
   words in a row, function words such as "the" at its edges left out;
   the last word of a longer cue that did not match, and title words that
   are not function words, of three or more letters, at half weight; one
   cue or two half words the least that recalls,
   pinned ones first, ties by recency, an episode tied with a chapter that
   holds it ahead of that chapter; `fitRecall` takes every pinned one and
   up to four others, each while it fits, skipping any that a chosen
   chapter holds or that holds a chosen one (members of a chapter in the
   story block stay recallable). The chosen ones, and the story before the
   chat, are told in story order (core `storyOrder`): an episode by
   `seq`, a chapter by the lowest `seq` among the episodes it holds,
   directly or through chapters, its own when none is known. With no room for the recalled block's
   heading nothing is ranked. A preset
   without a history block gets the story block where the history would
   be and the recalled block right after it. Memory
   text is literal, never macro-filled.
9. **Budget.** The notebook always goes in, within its own field bounds;
   then this chat's episodes newest first and recall in rank order go in
   while both blocks together fit 12% of the context in use, counted with
   the request's calibrated estimate (the story before the chat fits after
   this chat's episodes, newest first; an episode left out joins the
   recall candidates; a recalled one that does not fit is skipped, not the
   end of the scan). The story block's fit is found by a binary search
   over how many of the newest episodes go in, each try counted exactly. Held spans fold
   first (core `foldToFit`): the prompt is assembled with nothing folded;
   a fit that trims history folds the fewest oldest held spans whose turns
   cover what it trimmed, and is assembled again, until it fits whole or
   every span is folded; one that does not fit at all folds one more.
   Spans past the newest `MEMORY_LIMITS.held` (40) fold from the start, as
   the tab folds them, so that is at most 41 assemblies however many spans
   a request holds, two in the common case, and with the two fallbacks
   below at most 43 per request. Each attempt assembles and scans afresh
   within its own bounds; within the request, token counts are reused by
   text. Each fold drops its turns from the history, moves the lorebook's
   timed state down by them and adds them to the delay count. Negative
   starts preserve sticky and cooldown effects begun inside the fold.
   Folded user turns count toward the Author's Note, and every fit attempt
   recalculates that count from the original history. The request's
   `memoryState.foldedUsers`, bounded by `folded`, carries the folded turns'
   count, and timed records may start inside them; a request without
   `memoryState` keeps only records that start in its live turns. All this
   state is chat content, held only by the tab and the request. Events roll
   once, before any assembly, on the unfolded turns, and their state moves
   down by the chosen fold. Memory off, or a request without
   `memoryState`, folds nothing. A prompt that still does not fit the
   window with every held span folded is assembled again without
   recall (core's `recall: false`, the recap's left-out episodes
   included), then without this chat's episodes and the story before it
   (the notebook alone), and
   refused only when that does not fit either; an attempt that would only
   repeat the one before (nothing recalled, or neither recap nor recall)
   is skipped. Every attempt reads the
   first one's random draws (`replayableRandom`), so macros and lorebook
   chances come out the same.
   The assembly reports the ids that went in, the story before the chat
   apart from this chat's recap.
10. **The inspector.** Each memory message carries the source `memory`
    with its part: `story`, whether the notebook is in, how many of this
    chat's episodes and how many told before it, shown together as
    "Memory: the story so far (n memories)"; `recalled`,
    shown as "Memory: recalled (n memories)". A prompt that folded held
    memories says "n memories folded for this prompt (t turns)", a preview
    "would fold". After a memory lands, is
    edited or forgotten the store asks for a new preview, whose note marks
    where the next prompt first differs from the last one sent.
11. **Regenerating the opening.** `POST
    /api/memory/characters/:id/opening` writes a new opening for the
    memory screen's Regenerate and stores nothing. It carries the persona,
    the memory model and its effort (core `openingRequestSchema`), and
    reads only character data: canon (`memoryCanon` with no turns, so its
    lorebook entries are the constant ones of the card's and the linked
    books, within the same budget; keyed entries need turns), the
    notebook and the newest of the book's story that the memory blocks'
    share holds (`bookStory`, `latestWithin`), as a new chat's "Before this
    chat" is chosen. Before any call it refuses `memory_off`,
    `nothing_to_remember` (no notebook content and no memory),
    `context_window_unknown` and `prompt_too_long` as the remember route
    does; then it answers 200 with `application/json` at once and sends
    `{ opening }` or `{ error }` once the call settles. The call is the
    remember route's (`objectCall`) with its own instructions
    (`openingInstructions`), which take the opening's rule from the same
    core function as the memory call's (`openingRule`); the answer is
    clamped as a memory call's opening is and its persona's name becomes
    `{{user}}`. A Forget or memory off during the call answers
    `memory_off`. The screen puts the answer in the field through the
    notebook's own edit, so autosave saves it, and keeps the previous text
    in component state for Undo.

Logs carry `memory.remember`, `memory.chapter`, `memory.opening`, their
`.error` and `.abort` events and `memory.refused`, with model, duration,
finish reason, attempt, error class and status only.

## Cast register

The chat keeps a register of the people in the story (`PRODUCT.md` §
Cast) so the narrator copies their details instead of describing them
again. The domain lives in `packages/core/src/cast/`: the schemas and
`CAST_LIMITS` (`register.ts`, `limits.ts`), the keeper's and the sheet's
prompts (`prompt.ts`), name matching (`key.ts`), applying changes and the
sheet overlay (`apply.ts`), the narrator's and the scene picture's texts
(`text.ts`) and the request bodies (`api.ts`); the server's routes in
`apps/server/src/cast.ts`, its store in
`apps/server/src/persistence/cast-sheets.ts`; the chat's side in
`apps/web/src/chat/cast-slice.ts`, the panel in
`apps/web/src/chat/Cast.tsx` and `cast-ui.ts`, the character sheet's
section and the queries in `apps/web/src/cast/`. The register, its
snapshots, the owner's corrections, the acknowledged sheet and every
keeper request and answer are chat content.

1. **Entries.** An entry has an id assigned once by an injected id
   function, a role (`principal` or `minor`), a fixed anchor (the name,
   gender and the record's fields), earlier names (`aka`, at most four),
   optional durable `developments`, short `continuity` cues (`voice`, `goals`,
   `knowledge`) and a volatile state (`present` and the scene's fields). The
   baseline anchor stays fixed. `effectiveCastAnchor` overlays developments,
   then owner corrections, including explicit clearing. Chat entries also carry
   `introduced` and per-field `discovered` values (`seen`, `told` or
   `demonstrated`, with evidence): the complete canonical profile stays intact,
   while the in-chat panel reads a projection containing only introduced people
   and discovered or owner-corrected fields. The narrator, scene and memory keep
   canonical context. Identity recovery strips discoveries, developments and
   continuity so future-scene facts and knowledge cannot leak back. A register
   holds at most `CAST_LIMITS.entries`, 40, in introduction order. Names
   match by `castKey` (compatibility-decomposed, marks stripped, lower
   case, whitespace collapsed), never as ids.
2. **The chain.** The slice keeps a snapshot per reply id, greetings and
   alternates included, each the register a keeper call left after that
   reply with its usage. The register before a message is the newest
   snapshot before it, with the acknowledged sheet laid over it
   (`withSheet`: a sheet entry matched by id, else by name or `aka`, takes
   the sheet's gender and every anchor field the sheet set, keeping the
   chat's name; an unmatched one is added away), then the owner's state
   corrections, then the anchor corrections; removed entries are left
   out (`registerAt`, `currentRegister`). A snapshot never holds an anchor
   correction: a keeper answer that kept a corrected field records the
   value before it, so Revert shows that value. A state correction yields
   to the first snapshot of a call built after it; an anchor correction
   and a removal hold for the chat. Editing or deleting history takes every
   dependent branch's snapshots out (a deletion's Undo puts them back),
   and editing the newest reply, a Continue or a greeting refilled to new
   text raises the reply's `castVersion`, so a keeper answer for the old
   text is dropped.
   When an edit or stopped Continue leaves a gap, `withKnownIdentities`
   recovers only identities held by the invalidated snapshots from the chat
   index into the keeper input before optional notebook admission and corrections,
   with empty absent state. The keeper sees the corrected fields it may
   supersede. Only state corrections actually sent and unchanged since the
   call began yield; later corrections and removals hold. Successful catch-up
   consumes those recovery memberships; deletion removes them and Undo restores them.
3. **The keeper.** After a reply or a continuation ends complete, the
   slice sends `POST /api/cast/update` with the character and persona,
   the cast model and effort (`castModelOf`, `castReasoningOf`: the cast
   setting, else memory's, else the reply's model), the mode (`seed` for
   a greeting, `update` otherwise), the fingerprint of the sheet the chat
   acknowledged, the register with every correction and without removed
   entries, and every shown turn since the last
   valid snapshot in chronological batches of at most `CAST_LIMITS.turns`, 12.
   Each batch feeds its updated register into the next. Completed batches form
   a private checkpoint until the full gap succeeds; a retry resumes at the first
   unfinished batch, including when unchanged history has grown. The checkpoint
   requires the same epoch, character, persona, model, effort, player name, sheet
   object, notebook seed entries and player, corrections object, and exact source
   message objects at their original indices. A changed guard discards the prefix.
   Without a model no call goes. One call runs at a time; an unchanged prefix
   keeps running while appended replies queue the newest target. A replacement
   start aborts the old call. Pending starts are reserved synchronously before
   notebook readiness, so concurrent source completions coalesce.
   A changed helper context hands the newest source-valid active, queued or pending
   target to one coalesced fresh run under the current context. Source edits,
   branch changes, Clear and changed character or persona cancel that authority.
   Corrections and sheet landing retain single-call merge and Revert behavior;
   if a refusal turns that call into multiple batches, context is checked again
   before dispatching the smaller batch. Context changes discard incompatible
   checkpoints without starting work when no target is active or queued, retaining
   any failure and its Try again action. A provider failure never retries itself.
   Targets are complete, non-empty shown replies without a partial finish reason;
   later empty, failed or unfinished replies do not hide them. Retry and the
   keeper failure control apply only to an uncovered eligible target, preserving
   hidden branch failures. Explicit retries join valid reserved, queued or running
   work and reload a failed sheet alone. Every start uses the same serialization:
   retry queues a reselected target behind a valid older prefix. The reserved target
   carries its explicit sheet wait through queueing and context replacement, before
   replacement can dispatch; notebook readiness cannot bypass a later joined wait.
   Without existing authority, retry reserves uncovered keeper work while awaiting
   that reload. A covered target never reruns
   its keeper. A reload failure or semantically unchanged sheet (same fingerprint
   and structural entries, including null to null) preserves the acknowledged sheet
   object and private progress; changed canon retains the context fence above.
   A refusal as `prompt_too_long` halves the current batch until it fits or
   a single turn is refused, without skipping its prefix. The answer is
   applied only while the epoch, the call, the character and the reply's
   shown variant and `castVersion` are the ones it was built for; then
   `applyCastChanges` writes it over the register sent and the snapshot
   lands. Failures in a row are counted for the panel, which offers Try
   again.
4. **The route.** Before any call it answers 404 for a character that is
   gone, 422 for `prompt_too_long` and 409 for `context_window_unknown`;
   then 200 with `application/json` at once, keepalives, and
   `{ changes, usage }` or `{ error }` once the call settles. The call is
   memory's (`objectCall` in `object-call.ts`) with the keeper's static
   instructions, so the provider's prefix cache covers them, and a message
   of canon, the player, the register as compact JSON (ids and empty
   fields left out) and the turns. Canon (the card's description,
   personality and scenario and the persona's description) goes in unless
   the request names the stored sheet's fingerprint, that sheet still
   matches the card and it names someone; an empty sheet, as a Scenario
   card's, sends canon. The answer is changes only (`castChangesSchema`: by
   full name, fields to set, a `was` for a fuller name; `absent` names),
   clamped to the limits (`clampCastChanges`) before it is validated; an introduction or discovery item it cannot use is dropped without losing the rest of the change. Its
   cache key is the instance's `cast:<characterId>`. Development, continuity,
   introduction and discovery fields each require a nonempty value and a literal
   short quote found in a shown turn (`groundedCastChanges`). This grounds the
   update, not its semantic correctness. Discovery values may be less exact than
   canon and refine as the player learns more; canon alone never reveals them.
   Keeper and sheet instructions forbid inventing gaps except for a newly
   introduced Scenario NPC, whose complete hidden canonical profile is created
   once while its public discoveries remain evidence-led. The keeper receives
   the card kind and can promote a minor Scenario NPC as their narrative role
   emerges.
5. **Applying changes.** `applyCastChanges` resolves each change by name
   or `aka`, then by `was`, then by a single first-name match, else adds
   an entry while there is room. It drops the player's names, never
   rewrites a set baseline anchor field, applies grounded developments and
   continuity without overriding owner corrections, merges grounded discoveries
   monotonically within the branch, writes the state as given and marks every
   entry named present unless the change says otherwise, and marks the
   `absent` names away. A change that resolves to a removed entry leaves
   it as it was, so the keeper cannot add it back.
6. **The cast sheet.** A character's sheet is character data derived from
   the card alone: the people its card names, by its kind, with their
   anchors and no state, at most eight. Its fingerprint is sha256 of the
   card's name, description, personality, scenario and kind
   (`castFingerprintInput`); a greeting is not part of it. `GET
   /api/cast/sheets/:characterId` answers `{ sheet, current }` and never
   reads the card through a model. `POST` with the cast model, its effort
   and `force` answers the stored sheet at once when it is current and
   not forced; otherwise it joins the character's running job or starts
   one, then answers 200 at once, keepalives, and the sheet or the
   refusal. The job reads the card by id, never a request body, runs
   under its own lifetime rather than any caller's, keeps the instance in
   use until it settles and stores the clamped answer with ids and the
   fingerprint read before the call (nothing when the character was
   deleted meanwhile), flushed before it answers; a caller that leaves
   only stops waiting. The sheet is never part of a card export, and its
   row cascades with the character.
7. **The chat's sheet.** The slice asks for the sheet once per chat and
   character: at a chat's start, and before a request or a keeper call
   when the chat's character changed. Once it lands for the same epoch
   and character, a greeting that is the newest reply and has no snapshot
   gets a seed call. Without a usable cast model (none chosen, or one whose
   context window is not known yet, as the server requires;
   `usableCastModel`, `apps/web/src/chat/session.ts`) the sheet waits
   instead of failing, and is asked for as soon as one becomes usable. A sheet register starts with every entry away
   (`registerFromSheet`). Saving a card or applying a rework refreshes
   the character sheet's view of the stored sheet, which then shows it as
   stale; its Cast section reads it now or regenerates it (`force`), and
   the next chat's request reads it again.
   The existing memory query supplies notebook seeds through the session
   seam, with one load per chat and character and retry after failure.
   The opening keeper awaits both sources when available, in either completion
   order. Generation awaits only the saved notebook query; the model-derived
   sheet loads in the background and overlays every base when it lands.
   Memory off or unavailable lends no seeds. Stop releases a generation's wait
   immediately without cancelling the shared notebook query.
   Sheet entries take admission priority, then remembered lines in notebook
   order, using the same resolver and 40-entry no-eviction rule. Remembered
   entries have fresh chat ids, minor roles and empty absent state, and never
   name the player. Persona placeholders fill only after JSON parsing and
   follow the selected persona without another memory load. Sheet anchors
   win and overlays preserve scene state.
   Snapshots identify unused seed-only entries, which are recomposed around
   established people, exact catch-up identities and card admissions before
   remembered lines fill the remaining slots. Card adoption and explicit owner
   corrections establish identities as current-chat data, retaining their ids
   and state through omitted keeper changes and memory invalidation;
   established people are never evicted.
   Memory updates fence older loads. Changes to cast entries, the player or
   memory availability replace the acknowledged overlay and fence keeper inputs
   but never stop narration or scene painting already in progress. The keeper
   interrupted by an overlay change is replaced once for the same currently
   shown complete reply, coalescing changes before it starts. Epoch, character
   and reply-version fences reject superseded starts; failures await a later
   reply or explicit Try again. Unrelated revision advances preserve calls and snapshots.
   Deleted seed-only entries leave snapshots and the identity index;
   established current-chat identities remain. Epoch and character checks
   reject late completions. The narrator receives cast
   only through the corrected register, excluding cast lines from the story
   memory block; archivist and opening prompts read the full notebook.
8. **Placements.** Assembly takes the register as `cast` on the
   generation request and adds nothing for an empty one. Its anchors go
   in as one system message, `<cast>` and a line per entry in register
   order, present and away alike, at the preset's optional `castAnchors`
   block (labelled "Cast"), which the default preset holds after the
   scenario. A preset without the block gets it after the scenario when
   that is on, else after the later of the description and personality,
   else before the lorebook's after block, else before the chat history
   (`castAnchorsPlace`); the preset editor adds it back at the same place. The state goes in as a user
   message, `[Cast now: ...]` with current durable overrides, continuity cues,
   a line per present entry and the away
   ones by name, at depth 1, one order past the in-chat notes', so it
   follows the Author's Note at that depth; it is user, not system,
   because CLIProxyAPI hoists a mid-chat system message into Claude's
   system prompt. A preset without a history sends it after the memory
   blocks. A scene picture's source carries the present entries' looks,
   outfit and clothing state, and how they stand as `<people>`
   (`castPeopleNotes`). The scene metaprompt sizes a covered chest as its
   clothing shapes it, a binder or push-up included, and the anchor's true
   size only where the excerpt bares it. When the source is too
   long, static card notes are cut first, then present people's notes;
   the excerpt keeps priority.
9. **The inspector.** The Cast block and the "Cast state, depth 1" line
   show by their source. Stable baseline anchors stay in the Cast block;
   developments and continuity stay in the dynamic tail. Usage associates
   keeper batches and narration with the generation that triggered them,
   alongside the tab's session totals (see below).

Logs carry `cast.update` and `cast.sheet`, their `.error` and `.abort`
events and `cast.refused`, with model, duration, finish reason, attempt,
error class and status only.

## Usage accounting

Chat, scene, memory and cast calls always answer with bounded attempt receipts. Core's
`CallAccounting` schema is shared by server and browser. Middleware in
`apps/server/src/usage.ts` records actual provider attempts, including SDK
retries and helper repair calls, with purpose, model, status, duration,
finish reason and numeric reported counters only. Narration carries a
`data-usage` stream part; memory/chapter, opening and cast update/sheet
responses carry `accounting`, and scene prompt text carries it on SSE events.
Image generation is excluded. Shared sheet jobs and memory retries reuse
their receipt ids so the tab can deduplicate them.

The inspector's Usage section shows attempts for This request and totals by
purpose for This session. `reportedUsage` uses raw numeric presence: omitted
cache reads are unknown, an explicit zero is zero, and the Cached column
appears only when a receipt reports it. Failed or aborted attempts may have
used tokens. Without a receipt, the tab records a placeholder with unknown
usage; it cannot infer how many provider attempts ran. No counter estimates a price.
The server caps each request/job at 128 attempt records and the tab caps its
ledger at 512, with explicit truncation notices. Records stay in request/job
memory and the tab only, never entities, logs or browser storage. Clear,
reload and `pagehide` drop the tab's ledger with the chat.

## AI card creation and rework

"Create with AI" writes a card with a chosen model and paints its portraits
through the owner's ComfyUI; "AI Rework" asks a chosen model for changes to
a saved character. Their creation drafts (PRINCIPLES.md 1) take chat
content's path: the tab's memory and one request in the server.

- **Core.** `packages/core/src/creator/` owns the three kinds and their bounds
  (`limits.ts`: the description's length, one `maxOutputTokens` of 100,000
  for every creator call, lowered to the model's reported output limit by
  `creatorOutputTokens`, 5,500 estimated tokens per subject
  block and 10,000 per scenario description, a batch of four 1024 x 1536
  portraits, how many subject blocks each character kind holds), the
  prompts (a card system prompt per kind and an art metaprompt per kind for
  each image model, Krea 2 and MOSS Image, the
  look catalogue (`looks.ts`: each capture look's id, when Auto picks it
  on a cover and in a scene, its wording per image model, its undated
  wording and any framing that replaces the camera position, rendered into
  every character and scene metaprompt; each look keeps step 4's available
  light), the card prompts built on the two card layouts, the card style
  (`CARD_STYLE`), the opening's shape and the naming rules Rework shares), the
  request and event schemas, and one tolerant tag parser (`parse.ts`). It reads the model's tagged plain-text answer while
  it streams, each section absent, incomplete or complete, and validates
  the finished card: one subject block for a Subject, two or three for
  Multiple Subjects (`group`), each with `<backgroundstory>`,
  `<appearance>`, `<personality>` and `<vocabulary>` in order, or exactly
  `<Roleplay>`, `<Setting>`, `<People>` and `<Tone>` (`SCENARIO_BLOCKS`)
  with no character block in them, since a Scenario holds no fixed
  characters; a name and an opening.
  Sections the format does not ask for, tags included, are ignored.
  `artSource` takes from a card only what the art needs (each subject's
  appearance, the first sentence of its background, which the layout opens
  with age, origin, home, work and the era when not the present day, and
  up to 12,000 characters of its personality for expression and posing;
  for a Scenario its title,
  which the cover letters like a movie poster, its premise, the first
  sentences of Setting and Tone, for era, place, genre and mood, and
  People whole, for the looks of the people a cover or scene shows), and `toSheetFields` maps a card onto card fields with
  the kind's one tag (`CREATOR_TAGS`: Subject, Multiple Subjects or
  Scenario). For the brainstorm, `limits.ts` adds the ten ideas of a list
  (`brainstormOptions`) and the three earlier lists a round carries
  (`brainstormRounds`), the prompts a classifier prompt and one brainstorm
  prompt per kind, the schemas its request and events, and `brainstorm.ts`
  the readers: the classifier's one word (`parseBrainstormKind`) and one
  idea per answer line (`brainstormReader`, which `parseBrainstormAnswer`
  reuses so live and final lists agree), skipping a repeated pitch and
  refusing, never cutting, a pitch or brief past `descriptionLength`.
  `brainstormMessages` in `message.ts` rebuilds the conversation from the
  request and the earlier lists with what followed each.
- **`POST /api/creator/card`** (`apps/server/src/creator.ts`): a
  `streamText` call with the kind's system prompt and the description as
  the user message. When the catalog or the owner gives the model a context
  window, a system prompt and description that leave the answer less than
  `MEMORY_LIMITS.replyReserve` are refused first (`too_large`), counted and
  calibrated as object calls are (`promptRoom` in `object-call.ts`, the one
  fit rule); an unknown window refuses nothing. When the request names a persona (the current one when
  Create was pressed), the server reads it as chat does and core's
  `cardPrompt` puts its name and description ahead of the description, so
  the model knows who `{{user}}` is; the card still calls them `{{user}}`.
  A reasoning effort the request names goes upstream as a sampler preset's
  does (`upstreamSettings`), narrowed on the server to what the catalog
  says the model offers (`effortFor`, as for rework, art and memory): one
  it lacks goes as the model's default. The picker offers only those
  levels, and none means the model's default. Each request's calls, its
  retry included, share one random cache key. A provider still busy (429
  or 503) after the AI SDK's retries ends the run with `upstream_busy`,
  with `retryAfterS` when the provider said; card, image card, rework and
  art alike.
  Tagged plain text needs no structured-output support, so every model
  behind the upstream can write cards. Card and rework calls go through
  chat's Auto-Parse middleware (`reasoning.ts`) with the `think` tag, so a
  leading think block reaches the stream as reasoning, never as answer
  text the parser reads. While reasoning arrives, the stream says
  `thinking`, at most once a second and without its text. The text streams
  to the browser as NDJSON, then one result: the validation, and estimated
  tokens per subject block (or for the scenario description) from the
  token module's `countText` (`tokens.ts`). A block over its cap is reported, never
  cut. The finish reason decides what is checked: the output ceiling ends
  the run with `cut` and the provider's content filter with `filtered`,
  both unchecked; an in-stream error aborts the upstream call and ends the
  run at once. An answer that finished normally and fails validation is
  written once more in the same request, when the request with that answer
  sent back still fits a known window: the stream says `retry` with the
  problems, and a second call carries the system prompt, the description,
  the first answer as the assistant turn and core's `cardRetryPrompt`
  listing what was wrong. The second answer gets the same checks; if it is
  also invalid, the result says so. Both answers live in the request's
  memory only; the log carries the finish reason and which attempt ended.
  The answer has no byte bound, and `maxOutputTokens` is the shared 100,000
  or the model's lower output limit (sent because a provider's default
  when it is omitted can be far lower);
  the request has chat's lifetime.
- **`POST /api/creator/brainstorm`**: a request with no kind is classified
  first, a call of its own with the classifier prompt and the request
  alone; no kind word in the answer ends the run with `kind_unclear`, else
  the stream says `kind`. The list call takes the kind's prompt and the
  rebuilt conversation, refused first as `too_large` when it leaves too
  little room in a known window, and streams NDJSON: `thinking`, each idea
  as `option` once its line completes, then one `result`. An answer short
  of ten is written once more in the same request (`retry`, the first
  answer and `brainstormRetryPrompt` sent back) when that still fits; the
  result is the better attempt, never fewer ideas than the first gave, and
  no idea at all is `unusable`. Both calls share one cache key, the card's
  `maxOutputTokens` and its error codes. The server keeps nothing between
  rounds: the browser sends the request and the earlier lists each time,
  and the log carries operational fields only.
- **`POST /api/creator/art`**: the browser sends back the art source from
  the card it holds, the image prompt's model and reasoning effort (the
  card's unless others are chosen under New art, the model being the
  Settings image prompt model when one is set; core's `imagePromptModelOf`
  orders the three; the server sends an
  effort the model does not offer as none) and the workflow the tab shows (absent, the saved
  one; one without a graph is refused with 400 rather than painted as
  another), with the owner's direction when one is typed (trimmed, within
  core's `artDirectionLength`). Subject alone sends `composition`, either
  `regular` (one frame, also the server default when absent) or `diptych`
  (front and rear). Core's typed `artMetaprompt` selector ignores composition
  for other kinds. An explicit Look sends `look`, one id of core's
  catalogue; Auto sends none and the model chooses from the catalogue the
  metaprompt lists, and the server drops `look` for a Scenario, whose
  poster takes its era in the metaprompt alone. The look rides in the user
  message, after any reference note and before any direction, as core's
  `artPrompt` look note and the id in `<look>` tags, so the system
  metaprompt stays one per model, kind and composition. The log carries no
  look field. Each subject's own personality guides visible posing;
  a scene's explicit current pose and action always take priority.
  One `generateText` call with the metaprompt of the kind, composition and workflow's image model
  writes the image prompt at that effort; the
  user message is the art source, followed, with a direction, by core's
  `artPrompt` note and the direction in `<direction>` tags. The note ranks
  the direction above the notes and the metaprompt's open choices and
  below its framing, order, word limit and rules, so the approved
  metaprompt is sent unchanged either way. A sheet's new art may add
  `reference: { characterId }`: the server looks the character up in the
  requester's own instance (none found: error `not_found`, nothing sent),
  and unless the catalog says the model reads text only, sends the stored
  portrait's vision copy (`toVisionImage`, as rework does) as a file part
  before the text, which then carries `artPrompt`'s reference note between
  the source and any direction. A portrait removed since paints without
  one; a failure preparing it is error `reference`. The log adds only
  `reference` and `referenceGraph` (always false here) as booleans. The
  art and scene routes share one run (`paint` in `creator.ts`). The
  ComfyUI client then runs the chosen
  workflow with a random seed. The server answers with
  `application/vnd.ephemera.art-stream.v1`: each atomic frame has a
  one-byte kind and four-byte big-endian payload length. Kind 0 is an empty keepalive, kind 1 a validated JSON
  control event within 64 KiB, and kind 2 an image index followed by raw PNG
  bytes. Core owns framing, arbitrary-fragment parsing and the 8 MiB image
  and 24 MiB batch bounds. The browser holds PNG byte arrays directly.
  Decoding and output-node progress have their own phases; sampler steps
  come only from sampler nodes.
  The batch is all or nothing: exactly
  four 1024 x 1536 PNGs,
  8-bit RGB or RGBA without interlacing, palette, transparency key, ICC
  profile or compressed text, with distinct indices, within per-image and
  batch byte caps. Each one's image data is inflated in memory, stopping at
  its exact scanline size, so no candidate can expand past its pixels in the
  tab that decodes it. The request has its own 10-minute deadline. The
  server never writes the images or keeps their pixels.
- **`GET /api/creator/art/status?workflow=`**: off without an address;
  otherwise ComfyUI's `/object_info` says whether the instance answers and
  which node classes and model files the named workflow lacks (absent, the
  saved one; one without a graph is refused with 400). Settings asks it
  for every workflow it lists and the describe screen for the tab's
  workflow, one answer per workflow, so a choice made while an earlier
  check runs gets its own.
- **`GET /api/creator/art/workflows`**: the request's workflow catalog,
  the user's own first, then the server's files, each by id and name with
  its family and `scope` (`user` or `server`); no call to ComfyUI.
- **`/api/workflows`** (`apps/server/src/workflows.ts`): the user's
  imported workflows, JSON only. `GET /` lists their summaries, never a
  graph; `POST /` creates one under a client-chosen id from an API-format
  graph and the tab's choices of output, latent and prompt encoders;
  `PATCH /:id` changes the name and family only, at a revision (a `graph`
  key is 400); `PUT /:id/graph` replaces the graph at a revision; `DELETE
  /:id` answers the settings, back on the default workflow when they named
  it. Create and replace bound the body at 2 MiB and its nesting depth,
  refuse `__proto__`, `constructor` and `prototype` as keys at every level
  and drop each node's `_meta`. They then run core's pipeline:
  `normalizeWorkflow` (one image saver, else one preview, becomes
  `SaveImageWebsocket`; output nodes nothing consumes are dropped), `detectWorkflow` (the prompt encoders
  traced to the sampler's positive input, the empty latent, every seed, the
  family guess) and `finalizeWorkflow` with the tab's choices, which keeps
  the chosen output as `SaveImageWebsocket` and drops the others with the
  nodes only they used (an output another node consumes stays), writes the five placeholders,
  drops a text node that supplied the prompt (code `linked_prompt` when
  that node takes links, feeds anything else or is itself a chosen place),
  inserts a Lanczos `ImageScale` to exactly the requested size before the
  saver unless one already gives it, and refuses any other placeholder text
  (422 `invalid_workflow` with its code). The allowlist in its import
  context and then the live ComfyUI's output nodes judge the finalized
  template whole, the graph that runs (422 `blocked_nodes` with the
  classes), so a class only a left-out output used is no refusal; when
  finalization refuses, they judge the normalized graph instead, and its
  blocked classes answer before the refusal. Then come the dry fill and
  the template bounds, 200 nodes and 256 KiB. The answer
  carries `checked: false` when ComfyUI did not answer or no address is
  saved. `POST /inspect` takes a file in either ComfyUI format and a file
  name and answers what the import screen shows, storing nothing: a saved
  (UI-format) workflow is converted to API format by core's
  `convertWorkflow` against the live `/object_info` (widget order, links,
  reroutes, primitive nodes, muted and bypassed nodes, subgraphs and
  growing inputs, a list widget value wrapped as `{"__value__": [...]}`;
  at most 400 nodes before flattening and 200 after, else
  `too_many_nodes`, four subgraph levels, else `too_deep`, and a bound on
  conversion work, else `too_large`; 409
  `comfyui_required` when ComfyUI does not answer),
  then the same pipeline gives the normalized graph, the node titles, the
  detection with its candidates, what conversion and normalization changed
  and left out (the tab runs core's `finalizeWorkflow` on these with its
  choices for the full report), the blocked classes with their reasons,
  the live status of a save with the default choices and a name suggestion. One inspection runs at a time per user (429 `busy`). A user keeps at most 24
  workflows (413 `full`), with names unique regardless of ASCII case (409
  `name_taken`). The log carries `workflows.list`, `workflows.create`,
  `workflows.update`, `workflows.replace`, `workflows.delete` and
  `workflows.inspect` (with the file's format) with the status, duration,
  node count, `checked` and the refusal class; never a name, file name,
  node title or class, model file or text. Settings > Pictures lists the
  workflows and hosts the import panel (`apps/web/src/workflows/`), which
  holds the file, the inspection and the choices in component state and
  sends graphs through plain request functions, so no query cache holds
  one.
- **`POST /api/scene`** (`apps/server/src/scene.ts`): Picture this scene.
  The tab sends the model (Settings' image prompt model, else the chat's,
  taken at the press; no effort), the workflow, the character's
  id, the kind it read and the scene source core's `sceneSource` built
  (the card's art source from `savedCardArtSource`, the names, and
  `sceneExcerpt`'s newest shown turns within `SCENE_LIMITS`: 6,000
  estimated tokens and 40 turns, a newest turn too long alone keeping its
  tail). The server looks the character up in the requester's own instance
  (none found: `not_found`) and takes the kind from the stored card's tags,
  whatever the tab sent. For a Subject or Group card with a stored
  portrait, a model the catalog does not mark text only gets its vision
  copy as a file part before the text, which then ends with core's
  `SCENE_REFERENCE_NOTE`; a Scenario card sends none. One `generateText`
  call with `SCENE_METAPROMPTS[model][kind]` for the workflow's image model
  writes the image prompt (the scene request carries no look: the
  metaprompt picks the capture from the catalogue by the era the notes and
  the excerpt give, the selfie only when the excerpt has one), and the ComfyUI client paints one picture
  (`count: 1`), with the portrait's top third as the reference graph's
  input where it runs (below). The stream is the art route's framed format with
  one image at index 0, under the same deadline and body bound. The log
  carries `scene.end` with the model, `reference` and `referenceGraph` as
  booleans and the duration, `scene.abort`, `scene.error` and
  `scene.comfyui` by error class; never the source, the prompt or the
  picture.
- **ComfyUI client** (`apps/server/src/comfyui/`): the standard API
  (`/object_info`, `/prompt`, `/ws`) through the app's one outbound fetch and
  Bun's WebSocket, with the requested workflow filled by JSON-safe
  substitution. The workflows are API-format graphs from two sets, merged
  for each request into one catalog (`comfyui/catalog.ts`): the user's
  own, stored in their instance and named `user-<uuid>`, then the
  server's files. Nothing of a user's graph outlives the request, so a
  replaced or deleted graph is never served stale. The bundled files in
  `comfyui/workflows/` derive from Atelier's graphs: a file's name is its
  id and gives its name on screen (`krea2-gonzalomo` is "Krea 2
  Gonzalomo"), and the `user-` prefix is reserved. A file may carry a
  reserved top-level `ephemera` key, `{ family?, name? }`, which never
  reaches the graph and sets the family and the name on screen. Otherwise
  the id's first word names the family whose metaprompts write the image
  prompt: `krea2` or `moss`, and General for any other word, which the
  `startup.workflows` log reports with the file name. Adding a workflow is
  adding a file, up to 64 server workflows in all.
  **Workflows directory.** `EPHEMERA_WORKFLOWS_DIR` names an optional
  directory of more graphs, read with the bundled ones once at startup in
  `persistence/workflow-files.ts`, the only server code that touches the
  file system; `index.ts` builds the one registry (`loadWorkflowRegistry`)
  and passes it to every route that paints. A file that is not readable
  JSON or not a valid template (one save node, every placeholder
  `fillWorkflow` needs and no other), a name with the reserved prefix, an
  id two files share, or a default without a graph stops the start, and
  the `startup.workflows` log names the file, never its content. A node class
  outside the allowlist (`comfyui/allowlist.ts`: the curated in-memory
  classes plus the operator's `EPHEMERA_COMFYUI_EXTRA_NODES`) stops it the
  same way. No node may write to disk: save and preview classes (a refused
  list and the `Save` and `Preview` name pattern, `SaveImageWebsocket`
  excepted) are refused everywhere, and naming one in the env list stops
  the start, so a `SaveImage` or `PreviewImage` node, whose PNG would carry
  the prompt into ComfyUI's output folder, never reaches ComfyUI. An
  imported graph meets the same allowlist, with `LoadImage` refused since
  it paints from text only; a stored graph whose class later leaves the
  list stays listed, reads `missing` and never runs. An
  external `<id>.reference.json` may pair with a bundled `<id>.json`, but
  no file replaces another. The effective default is
  `EPHEMERA_DEFAULT_WORKFLOW` when set, else core's `krea2-gonzalomo`; it
  seeds every new user's settings row, and a stored id without a graph,
  the SQL column's legacy default `krea2-intorealism` included, reads as
  it. Saving an unknown id is refused with 422.
  A graph keeps its sampler, scheduler, steps and CFG fixed; Ephemera
  supplies only the prompt, the seed, the 1024 x 1536 base dimensions and the count,
  four for portraits or one for scenes. A MOSS-family graph gets the MOSS
  Image metaprompts, a Krea 2 graph the Krea 2 ones and any other the
  General ones. The PNG decoder requires exactly the requested
  dimensions: an imported graph gets its `ImageScale` from finalization,
  and a server file with a hires pass must scale its final decode back to
  the requested size itself (such as an `ImageScale` before
  `SaveImageWebsocket`). Model dependencies follow one rule in `comfyui/workflow.ts`
  for server files and user workflows alike: with a live `/object_info`,
  any string input whose spec is a combo and whose name ends in `_name` or
  `_path`, with core's `MODEL_INPUT_EXCEPTIONS`; without one (server files
  at start), the `_name` inputs of loader classes ending in `Loader` and of
  `LoraLoaderModelOnly`. The reference graphs' ReID LoRA counts too. The
  status check compares the selected text graph's dependencies with a
  fresh `/object_info` read and, in private mode, the worker's submission
  allowlist; a missing node class, model or LoRA, or a class the live
  ComfyUI reports as an output node other than `SaveImageWebsocket`, makes
  it `missing`, so portrait and scene consumers skip generation before
  sending the image prompt.
  A file `<id>.reference.json` is the reference graph of workflow `<id>`
  (the registry's `referenceOf`), derived from Atelier's graphs like the text graph and never a
  workflow of its own; one without its `<id>.json`, or without the
  `{{referenceImage}}` placeholder, stops the start. A workflow may ship a
  companion reference graph; the bundled Krea 2 workflow has one. The reference graph runs only on Atelier's private
  worker, and only when `/object_info` lists every node class and model
  it needs and the handshake's allowlist permits the transformed graph.
  Otherwise the text graph runs and `comfyui.reference` logs the reason.
  The client uploads the image under
  the job's lease with `PUT /atelier/v1/jobs/<lease>/inputs/<asset>` as
  `application/octet-stream`, fills the placeholder with `<lease>:<asset>`
  and renames each `LoadImage` node `AtelierLoadImage`, which reads the
  input from the worker's memory; the lease's release removes it. A plain
  ComfyUI never receives the image, since its `/upload/image` writes to
  disk, and always runs the text graph. A failed upload fails the run as
  `comfyui` with reason `upload`. Each run asks for its own count of
  images, four for card art and one for a scene, and the batch must hold
  exactly that many. The address comes only
  from settings, redirects are refused, and failures carry a reason, never
  ComfyUI's text. Only concurrent `/object_info` reads for the same base URL
  share a request within one client and its credentials. Each caller can
  cancel its own wait; the last caller cancels the upstream read. The read
  has an eight-second cap, including its body, and is discarded when it ends.
  Handshakes, readiness results, prompts and portraits are never cached.
  It opens the WebSocket first, submits under a prompt id it chose.
  Native output collects the `SaveImageWebsocket` node's ordered
  frames and finishes on either `execution_success` or `executing` with
  a null node, failing incomplete output immediately. UI-only `executed`
  events are unnecessary. Metadata PNG frames must name this prompt and
  its output node; sampler previews never become final images. The private
  handshake, `GET /atelier/v1/privacy`, must return ready with protocol 2, all seven
  capabilities (`job_status`, `image_outputs`, `preview_control`,
  `lease_renewal`, `job_admission`, `execution_budget`, `residency_tracking`),
  a SHA-256 `worker_build`, `allowed_nodes` and integer `limits`:
  `max_jobs`, `max_payload_bytes`, `max_image_bytes`,
  `max_images`, `pre_submit_seconds`, `terminal_idle_seconds`,
  `terminal_max_seconds` and `max_execution_seconds`. A missing or malformed
  field fails as `not_ready`;
  an older private worker cannot select native mode. Only a handshake 404
  selects plain native ComfyUI. A run whose handshake gets no answer, or a
  valid private answer with `ready: false`, says `starting` progress once and
  asks again every second for up to 60 seconds, then fails as `unreachable`
  or `not_ready`; any other answered failure fails at once. The readiness
  check does not wait. Private mode takes a job lease under that id
  and releases it after every run. The worker expires terminal and
  unsubmitted leases. Active work is released after 120 seconds without a
  successful scoped status observation; validated submission starts a fresh
  observation window. Released work still running 60 seconds later, or work
  reaching its immutable admitted execution budget, restarts the worker.
  Ephemera retries failed releases; a successful release is authoritative.
  It creates that lease with `imageOutputs: true` and
  `previews: false`, plus `executionTimeoutSeconds`: the art routes' shared
  ten-minute `ART_TIMEOUT_MS` deadline rounded up to seconds, independent of
  the general request timeout. An invalid budget or one above the fresh
  worker's `max_execution_seconds` fails readiness and generation before lease allocation. Admission and
  preparation never extend the original request deadline. It replaces the output
  node with `AtelierSaveImages`, carrying the same images input and the lease's
  `job_id`.
  A private-worker contract change deploys the worker and every consumer
  together in a maintenance window. Rollback restores the worker and matching
  consumer revisions together; there is no private-protocol compatibility window.
  Lease creation retries only an HTTP 429 with `{error:"worker_busy"}`.
  Numeric `Retry-After` seconds are clamped to 100 milliseconds through five
  seconds; missing, date or malformed values use one second. Every busy
  POST reuses the same lease id, which holds the run's place in the worker's
  first-come waiting list. Waiting emits `busy` progress, carrying the
  optional `Atelier-Queue-Position` header (a positive integer, 1 next in
  line; anything else counts as unknown) and said again whenever that
  place changes. It stops on caller cancellation or server shutdown.
  Admission has its own 300-second limit inside the original request
  deadline; a run still busy when it ends fails with `comfyui_busy`. Waiting consumes that request's remaining lifetime and grants
  no fresh render or retention budget. A duplicate identity (409), other
  errors and an unanswered lease POST are never retried. The fresh worker
  limits can reject an incompatible output count before admission and
  tighten payload, image and terminal retrieval bounds; they cannot widen
  Ephemera's own bounds.
  The sink retains ordered PNGs only in the worker's bounded memory store.
  The client polls its own `GET /atelier/v1/jobs/<lease>` at one-second
  intervals, reconciling immediately on socket loss or a terminal signal.
  The lease's `queued` and `running` states drive queued and loading
  progress, so progress moves without the socket: ComfyUI can silently
  unregister a reconnected socket that reuses its client id. Unreachable
  status reads fail the run once they persist for 30 seconds since the last
  answered read, below the worker's 120-second owner-silence bound. Other status
  errors fail at once.
  Submission acknowledgement has a separate eight-second total deadline,
  including its body. A network failure, timeout or HTTP 408, 429 or 5xx
  can hide an accepted POST: private mode reconciles that original lease,
  including while it remains leased before native admission, without ever
  submitting the graph again.
  Definitive rejections, malformed acknowledgements and mismatched identities
  fail; caller cancellation takes precedence over recovery.
  Only authoritative `completed` status allows downloads from that lease's
  `/outputs/<asset>` endpoints; count, ids, byte limits and PNG shape are
  validated before delivery. Failed, released or missing leases fail the run.
  The socket enhances live progress; up to three reconnects and bounded
  download retries never submit or render again. Status calls and socket
  connections have eight-second deadlines; each download attempt has sixty
  seconds, including its body. At most four downloads run concurrently, with
  ordered delivery and unchanged per-image and aggregate byte limits. One
  failed download aborts its siblings. Downloads retry network failures,
  timeouts and HTTP 408, 429 or 5xx at most three times. The client first
  awaits a bodyless
  `POST /atelier/v1/jobs/<lease>/renew` returning `{ok:true}`, then renews every
  thirty seconds during retrieval. Each renewal attempt has four seconds and
  at most three transient attempts; missing leases cannot be recreated.
  The worker retains terminal outputs for 120 idle seconds, renewed only up
  to 600 seconds from its terminal snapshot, or tighter advertised limits.
  Total retrieval starts from the last known nonterminal observation, or
  submission when none exists, so elapsed acknowledgement ambiguity counts
  against it. It remains within the original art request's ten-minute
  lifetime. Renewal stops and is awaited with all
  downloads before lease release on success, failure or cancellation.
  Reference uploads and inventory reads share the art request's lifetime.
  Native `progress_state` snapshots validate both prompt and graph-node
  attribution, map known node classes to the existing loading, running,
  decoding and sending phases, and deduplicate repeated legacy/native values.
  Native node state never substitutes for authoritative lease completion.
  Cancellation stops polling, downloads and reconnects before release.
  Plain native mode uses the WebSocket and cannot recover lost image delivery.
  Ephemera and Atelier remain independently deployable: the private-worker
  protocol is optional, with no shared package, peer-service call, coordinator
  or host and hardware assumption.
  A plain instance must support atomic `POST /api/jobs/<id>/cancel`.
  After validated normal completion, Ephemera first waits within the existing
  four-second cleanup poll for native `task_done` to retire the job, preferring
  its own `/history/<id>` entry as evidence of atomic retirement. This avoids
  cancellation or cache release before normal retirement when it can be
  observed. If queue reads fail, exceed their size cap or stall past the
  bounded wait, history deletion and `/free` are still attempted with their
  own deadlines. Success, failure and abort cleanup all use own history as
  retirement evidence. Bounded follow-up repeats scoped history deletion
  independently of queue availability, catching history inserted after an
  earlier delete. A successful instance-wide cache release is reused across
  these polls; only an earlier release failure or later observed retirement
  calls for another release. A job still present after the initial phase moves
  to follow-up cancellation. On abort or failure, Ephemera repeats safe
  cancellation of its own id at one-second cleanup polls until that job leaves
  pending and running state. HTTP 200, even with
  `cancelled: true`, does not settle cleanup while the queue still lists the
  job. The follow-up uses the same rule. Observed retirement allows final
  history deletion and `POST /free` with
  `{"unload_models": false, "free_memory": true}`, which drops the
  instance-wide executor cache (ComfyUI unloads the models with it).
  Cleanup runs detached from the run, so the stream reports a failure or
  the deadline at once and releases the request's memory; it holds ids
  only. It never runs on the aborted request's signal: the queue poll has
  its own 4-second deadline, and every later request a fresh one. A lease
  release, history delete or `/free` that fails is tried three times. A
  follow-up tied to no request takes what the poll could not settle,
  checking every second: a prompt still running, until it has left the
  queue or five minutes pass; a submit without an answer, which ComfyUI may
  still admit, or a queue that could not be read, for a minute, looking in
  the queue and in `GET /history/<id>`. Wherever the prompt appears it is
  removed, its history entry deleted and the cache freed. A cleanup that
  ends unresolved logs `comfyui.cleanup.unresolved` with a reason code
  only. On SIGTERM or SIGINT, or the `stop` message on an IPC channel
  (how `./ephemera` stops it, Windows having no SIGTERM), the server stops
  accepting requests, aborts
  creator runs and waits up to eight seconds for their cleanup, follow-ups
  making a last check at once, before it closes the database and exits. A
  process killed mid-job cleans up nothing (principle 1's residual risk).
  There is no startup sweep: it could not tell its own leftovers from
  another client's. WebSocket frames are capped as they arrive: a text
  frame at 64 KiB, a binary frame at the per-image cap plus 64 KiB, and the
  frames not yet read at the batch cap plus 64 KiB; past any of them the
  run fails as oversized and the socket closes.
- **Browser** (`apps/web/src/creator/`): the route `/characters/create` and
  one Zustand store without `persist` for the description, the streamed
  answer, the batch and the choice, with a session epoch as in chat: Stop,
  Rewrite, Discard and leaving abort what is in flight and drop late
  results. Leaving the route drops the card and its art and keeps the
  description and Subject composition for a visit to Settings. Composition
  also survives Rewrite and Discard or back to Describe; choosing another
  kind resets it to regular. The Look choice (`artLook`, Auto or a
  catalogue id) sits beside it in the shared art slice and survives the
  same steps and a change between Subject and Group; Scenario resets it to
  Auto. The sheet-art store holds its own, session-only. A reload, `pagehide`, Keep and a
  closed tab empty everything, canvases and decoded bitmaps included.
  Portraits are decoded from their bytes in memory with WebCodecs'
  `ImageDecoder`, never through a Blob the browser could page to disk, and
  drawn on canvas, so the policy keeps `img-src 'self'` with no object URL
  and no `blob:` or `data:` source. Until a batch is on show, Keep reads "Keep without portrait". Card text renders as plain text or through the tightened renderer.
  A request an expired sign-in refused is sent once more after renewal.
  The brainstorm slice (`brainstorm-slice.ts`) holds the request, the list
  on show, the round being written, the earlier lists, the pick with the
  player's edits per idea, and the unsent Ask and feedback text; each round
  carries its own token beside the epoch, so a stopped or replaced round's
  late events change nothing. A pick sets the kind and copies the brief
  (or its remembered edit) into the description, which then follows the
  description's lifetime. Change stops a running round and keeps the
  session for the tile to reopen; Discard and Rewrite keep it too. Leaving
  the route drops it, so it cannot reappear on return, and a reload,
  `pagehide` or a closed tab empty it with the rest.
- **Keep** has no route of its own: the existing `POST /api/characters`
  under a client-chosen id, then the existing portrait upload with the
  chosen PNG through the portrait pipeline. The card's fields and id come
  from one snapshot taken on the first Keep, so a retry never duplicates
  the card; the portrait is the one chosen when Keep or its retry is
  pressed. Keep and saved-sheet art share the 60-second portrait upload
  deadline (`portraits/limits.ts`). A session drop aborts Keep's upload and
  rejects its late result; thrown saves become failures. When only the
  portrait fails or times out, the card stays kept and the upload can be
  retried alone. While Keep saves, leaving the screen waits for it: the
  leave dialog says the card is being kept, and the way out opens once it
  is.
- **Shared art session** (`apps/web/src/creator/art-slice.ts`,
  `art-session.tsx`): the art run (status check, effort, request, the
  all-or-nothing batch, the choice, Stop, sign-in renewal) is one Zustand
  slice that each host composes with what it paints from: the creator from
  its complete card, the sheet from the saved card. Its regions (frame,
  alternates, controls, status) read the host's store through a context, so
  the showcase and the sheet's studio share one implementation. The
  provider and its regions are keyed by the store's epoch, so a drop
  (Clear, `pagehide`) remounts them and no component state or ref keeps a
  decoded batch, a candidate or the hue lean of the session left.
- **Scene pictures** (`apps/web/src/chat/scene-slice.ts`, `Scene.tsx`):
  a slice of the chat store holds `scenes` beside `messages`, each item
  anchored to the newest message when it was asked for, with its run, its
  request snapshot for Paint it again and, once painted, its PNG bytes.
  The history, previews, the inspector and memory calls read `messages`
  only, so a picture reaches no model by construction. One runs at a time,
  never while a reply streams; its controller joins the store's in-flight
  set, so Stop, Clear and `pagehide` abort it as they abort a generation,
  and every write checks the epoch. Deleting a message drops the pictures
  anchored to it or, deleting from it onward, to any later one, and Undo
  does not bring them back. The thread renders each item after its anchor,
  under the anchor's own fold: a 2:3 plate whose canvas `role="img"` is
  named "Scene with {name}", decoded with `decodePng` only while it is
  within a viewport of view and closed when it leaves. The button under the
  portrait (`Presence.tsx`) is absent without a saved ComfyUI address. A
  request a sign-in refused waits and runs once after renewal.
- **Sheet art** (`apps/web/src/sheet-art/`): a second store without
  `persist`, bound to the open sheet on each opening, with the kind, the
  Match choice and the Use run. Core's `savedCardArtSource` builds the
  source: `artSource` for a description wholly in a creator format, else
  the card's prose (`packages/core/src/creator/saved-art-source.ts`). Use
  as portrait is the only place a candidate becomes a `File`, uploaded
  through the existing portrait route under a 60-second deadline, after
  which the sheet's one portrait-update path refreshes its caches. Leaving
  the sheet, `pagehide` and a successful Use clear it, and a clear closes
  the studio; Close stops a run and keeps the batch.
- **`POST /api/creator/card/from-image`**: Atelier's server asks for a
  card of one kind from one of its images; no tab calls it. Multipart: the
  image (PNG, JPEG or WebP within the upload caps), a caller-chosen UUID,
  an optional `kind` (`subject`, `group` or `scenario`; `subject` when
  absent, and any other value is a 400 before image or model work),
  optional notes (the image's prompt, at most the description's length) and
  an optional direction (the owner's steer for the card, at most
  core's `imageCardDirectionLength`); blank notes or a blank direction
  count as absent.
  The integration key opens this route only, under the username,
  bound-user, Origin and content-type rules the proxy key meets: `Remote-User`
  must be a valid username, and the card lands in that user's own instance,
  like every other route's data. At most two run at once across all users
  (`IMAGE_CARD_MAX_IN_FLIGHT`); a third gets 429 `busy` with `Retry-After:
  10` before its body is read. An id that names a kept character in the
  requester's instance is a retry after a lost result: the stream answers
  at once with that character's `result`, with no image or model work; the
  same id from another user finds nothing of it. Otherwise the portrait
  pipeline re-encodes the image
  first (415, 413 or 422 when it refuses). The PNG is what a Keep stores;
  the model gets its vision copy as rework does, beside core's
  `imageCardPrompt`: the kind's request, then the notes in `<notes>` tags under a
  note that the image wins on looks, then the direction in `<direction>`
  tags under a note that ranks it above the notes and the image's open
  choices, never above the image on looks or the system prompt's format.
  The saved reply model writes with the kind's system prompt at its default
  effort, the creators' one `maxOutputTokens` and chat's lifetime. Before
  the call the run ends with `no_model`, `text_only_model`,
  `context_window_unknown` or `too_large` (the system prompt, the message
  and the portrait's 1,600 tokens against the window, by `promptRoom`). The call, its
  think-block reading, its finish reasons and its one retry are the card
  route's: a refusal (the content filter, `filtered` there) ends with
  `upstream`, and an answer the output ceiling cut (`cut` there) with
  `invalid_card`, neither checked nor retried. An answer that finished
  normally is unusable when the validator reports problems or core's
  `incompleteForAutomaticKeep` finds empty creator notes, an empty inner
  block of a subject, or, on a Scenario, an empty Roleplay, Setting,
  People or Tone. It is written once more (`rewriting`) when the request with that
  answer sent back still fits the window: the second call carries the
  first answer and core's `cardRetryPrompt`, which lists the validator's
  problems and the empty parts. A second unusable answer, or a first with
  no room for the retry, ends with `invalid_card`; `upstream`,
  `upstream_busy` and `timeout` get no retry. A
  usable card maps as `POST /api/characters` maps it, with its kind's tag,
  and is saved with its
  portrait in one transaction under the caller's id, so the later of two
  concurrent first requests with one id saves nothing, and the result names the character
  read back from the row, once its portrait file and the user's database
  are flushed. A failed save, read-back or flush ends with
  `save_failed`; when only the read-back or the flush failed, the card is
  kept in memory and a retry flushes it before naming it. Any other unexpected fault, such as a failed settings read,
  ends with `internal`. The NDJSON
  stream carries phases (`writing`, `rewriting`, `saving`), then one
  `result` with the id and name or one content-free `error`; no deltas, so
  no card text leaves the server before it is kept. A disconnect after the
  transaction leaves a kept card the caller was not told about. Logs are
  `creator.image_card.end`, `.abort` and `.error` with the model, duration,
  status, finish reason, attempt and error class only.

Card creation differs from chat in four ways: nothing is assembled from
persisted entities and no context budget applies beyond the window check; the model writes tagged plain text
that the browser parses as it arrives, not an AI SDK UI message stream; the
stream is NDJSON whose keepalive frame is a blank line (`keepalive.ts`),
not an SSE comment; and the art request reaches a second upstream, ComfyUI.

The settings row holds `comfyuiBaseUrl` (empty, or an http or https address
without credentials, query or fragment) and `comfyuiWorkflow` (the id of a
server workflow or one of the user's own, chosen in the describe screen beside the model or in the
showcase under New art, whose picker lists the user's own under Yours
before the server's, and kept for the next card). A save naming an id without a graph is refused with
422 `unknown_reference`, as one naming a deleted preset is, and a saved id
whose file is gone reads as the default. The server environment holds `COMFYUI_ALLOWED_ORIGINS`, the
comma-separated origins users may choose (empty or unset turns ComfyUI off
for everyone); `COMFYUI_API_KEY`, a bearer token sent only to an allowed
origin and only over https; and `COMFYUI_CA_FILE`, a PEM CA certificate the
instance's TLS certificate must chain to, read once at start. A settings
save naming another origin is refused with 422
`comfyui_origin_not_allowed`, and a saved address whose origin is no longer
allowed makes no request at all. Neither the key nor the certificate
reaches the database or the browser.

AI Rework:

- **Core.** `packages/core/src/creator/rework/` owns the bounds
  (`limits.ts`: a request of 20,000 characters, the portrait counted as
  1,600 tokens; the answer has the creator's `maxOutputTokens` and no
  other bound), the
  request and event schemas (`schema.ts`: the card the browser sends,
  without nickname, creator or version, and an optional reasoning effort
  as Create's, which the composer leaves to the model's default), the
  field keys (`fields.ts`: text fields, `character_note` as the note's
  prompt, `tags`, `alternate_greeting_N`, `alternate_greeting_new`,
  `entry_N`, `entry_N_name`, `entry_N_keys` and `entry_new_K` with its
  parts), the system prompt (`prompt.ts`, which embeds the creator's
  card layouts, `SUBJECT_LAYOUT` and `SCENARIO_LAYOUT`, the card style
  `CARD_STYLE`, the opening's
  `SUBJECT_OPENING_SHAPE` and `SCENARIO_OPENING_SHAPE` and the naming rules `ONE_SUBJECT_NAMING`,
  `CAST_NAMING` and `SCENARIO_NAMING`, so Rework brings every card into
  them and turns a scenario card's fixed characters into roles) and the user message (`message.ts`: the persona, every field between its key's tags, the
  lorebook with its settings and each entry's flags and applying secondary
  keywords as read-only context, the request), the parser
  (`parse.ts`: `<change>` blocks with `<field>`, `<why>`, `<find>` and
  `<replace>`, then `<summary>`; `readChanges` reads only past the last
  closed block, so a stream is not rescanned), anchor placement
  (`anchor.ts`: a find must match once, exactly or else with whitespace
  runs collapsed on both sides, a find spanning the field counting as
  whole; offsets point into the card as sent, and a change that names no
  field, misses, matches twice, overlaps an earlier one, would empty a
  field that must keep its text, would clear the personality or scenario
  field with no conversion (a whole new description) placed before it, or
  would pass a card limit is unplaced; `isConversion` and `isClearing`
  name the pair) and application (`apply.ts`: accepted changes only, later
  offsets first; an empty whole replace removes an alternate greeting or
  an entry and clears a personality or scenario field, and new entries
  take `newEntry`'s defaults). Partial keyword edits preserve original literal
  commas, newlines, whitespace and keyword boundaries outside accepted
  passages; placement limits and Apply share the resulting-list helper.
  Whole-field and new-entry keyword lists use the model's comma-list format.
- **`POST /api/creator/rework`**: chat's lifetime and a body cap of the
  card JSON limit plus 64 KiB (`MAX_REWORK_BODY_BYTES`), since the body
  carries the sheet's fields and the whole lorebook. The character must
  exist and the model must have a window from `effectiveWindow`; the
  system prompt, the user message, the portrait's 1,600 tokens
  must leave the answer its room (`promptRoom`), or the run ends with `not_found`,
  `context_window_unknown` or `too_large` before the model is called. With
  the switch on and a model that does not read text only, the stored full
  PNG's vision copy goes as AI SDK 7's user file part (`image/jpeg`), which
  `@ai-sdk/openai-compatible` sends as an `image_url` data URL. The vision
  copy (`toVisionImage`) is a JPEG at quality 80 within 1024 px on the long
  edge, metadata stripped: under 800 KB even for full-size noise, where the
  PNG can exceed an upstream request-body limit (a 4.5 MB limit answers
  413 for a full-size noise PNG). One
  `streamText` call; the answer streams as NDJSON `delta` events, then one
  `result` with the answer's problems (`incomplete`, `no_summary`) or one
  content-free `error` (`upstream`, `timeout` and the refusals). Logs are `creator.rework.end`, `.abort`
  and `.error` with the model, duration, status and error class only.
- **Catalog.** `modelsFromCatalog` reads `input_modalities` into each
  model's `images`: true when it lists `image`, false when it does not,
  null when the catalog does not say. The composer's "Include portrait"
  switch follows it.
- **Browser** (`apps/web/src/rework/`): one Zustand store without
  `persist`, bound to one character's sheet, holds the request, the model
  and portrait choice, the card as sent, the answer, the changes placed
  with core's `placeChanges` as they close, the decisions (a conversion
  and the fields it clears decided together) and, after
  Apply, the Undo snapshot; a session epoch as in the creator drops late
  events. Discard and closing the composer keep the request; Apply keeps
  only the Undo snapshot until Done, another rework or leaving; leaving
  the sheet, a reload and `pagehide` empty it all, the word diff memo
  included. While a run works or is under review the sheet's `edit()`
  ignores every call and the fields are read-only. Tracked views
  (`tracked.ts`) cut each field's original text at its changes, fold
  unchanged runs over 60 words to the sentences beside a change, show a
  change whose find and replacement pass 80 words and keep under 40 % of
  the find as one inserted passage (a removal stays struck inline), and stand each reason row at the end of the sentence
  holding its change; everything renders as text nodes. Apply writes the
  accepted changes into the sheet's draft (the lorebook included) and the
  autosave saves them; Undo restores the fields Apply wrote, skipping any
  typed in since.

## Users and storage

**Identity.** The trusted authentication proxy injects the proxy key and
`Remote-User`. The boundary
(`apps/server/src/boundary.ts`) admits a request only with the key and a
`Remote-User` that matches `^[a-z0-9][a-z0-9._-]{0,63}$` (`usernameSchema`
in `apps/server/src/identity.ts`); anything else is 403 with the same body
for every refusal, and creates nothing. Who is admitted is the live
access rule's decision, outside this repository: it must name every
intended user. `GET /api/health` needs the proxy key alone and touches no
user's data; it is the container's health probe.

**Instances.** `withUser` (`apps/server/src/user.ts`) gives every route the
requester's instance from the registry
(`apps/server/src/persistence/instances.ts`) through the Hono context, so a
route reaches only that user's stores. A user's first admitted request
creates `<dataDir>/users/<username>/` (0700, and `users/` itself when it is
the first user), asserted a direct child of `users/`, and seeds what a fresh
install gets. A new settings row starts with `EPHEMERA_DEFAULT_MODEL` as its
reply model when set; an existing row keeps its own. A database created that way also gets the starter character,
the native card PNG in `apps/server/src/starter/`, which `index.ts` reads
once at startup through the import reader (`starter.ts`); a database that
already exists never does, so a deleted starter stays deleted.
`EPHEMERA_STARTER_CHARACTER=off` leaves new libraries empty, as e2e does
for its per-test users. Generation calibration ratios live on the instance, so they
are per user; nothing else in server memory is addressable by user. An
instance idle for ten minutes is flushed and dropped from memory; one with
a request or stream in flight never is. A route marks a streamed response
(`markStreaming`, `streams.ts`) with the work it answers, and `withUser`
keeps the instance in use until the stream ends and that work settled.

**Creation retries.** Library New and Copy, prompt and sampler preset New,
and New lorebook on a character's LinkedBooks hold a client-chosen id and
payload snapshot per intent in the owning screen's memory
(`apps/web/src/sheet/creation.ts`). An unacknowledged attempt sends the same
id and payload again, and an attempt already in flight suppresses another.
A library create the server refused as invalid or too large (400, 413)
stored nothing, so it releases its snapshot and the retry reads the source
again under a new id; a thrown request, a sign-in or any other status stays
uncertain and keeps it. LinkedBooks holds them until both creation and
linking are acknowledged, so retrying a failed link never creates a second
book; once the owner has linked the held book from the picker, that intent
is complete and the next New releases it for a new book. None survives the
screen unmounting.

**Encryption at rest.** A user's database is an in-memory `bun:sqlite`
database, stored as `<dataDir>/users/<username>/ephemera.sqlite.enc` (0600):
its serialized image under AES-256-GCM
(`apps/server/src/persistence/encrypted-file.ts`, the one module that writes
files). Each portrait's re-encoded PNG is a file of the same format beside
it, `users/<username>/portraits/<id>.enc` (0600 in a 0700 folder), named by
a UUID the server assigns and the portrait row holds
(`apps/server/src/persistence/portrait-files.ts`). Every write derives its key with HKDF-SHA256 from
`EPHEMERA_DATA_KEY` (32 random bytes as 64 hex characters), a fresh salt and
an info that binds the format and the username, and uses a fresh nonce; the
header and the username are authenticated as additional data, and a
portrait file's id (`portrait:<id>`) as well, so a file copied into another
user's folder, renamed to another portrait, presented as the other kind, or
altered, does not open. The
ciphertext goes to a temp file in the same folder, which is synced and
renamed into place, and the folder is synced. Windows cannot sync a folder
(NTFS journals the rename itself) and refuses a rename while a scanner
briefly holds the target, so there the folder sync is skipped and a refused
rename is retried for about two seconds. Plaintext database and image
bytes never touch the disk. Every SQLite connection, including startup
verification copies, sets `PRAGMA temp_store = MEMORY` before queries
or migrations, so temporary tables and sort results stay in memory too.
Large sorts consume memory within the container's limit. A file that cannot
be decrypted or read answers that user's requests with 500 and a class-only
log and is never replaced. Losing
`EPHEMERA_DATA_KEY` loses every user's data for good; backing it up is the
owner's job. Logs carry no username and nothing about the key.

**Durability.** The writes a request causes are flushed, encrypted, before
its response completes; a stream's are flushed at its end, or, when the
client goes away, once the work it answers settled. The image card stream flushes before its `result`, so
the result it names is on disk. Flushes for one user are serialized and coalesced.
A new portrait's PNG waits in memory until the flush, which first writes
every waiting file a row names, then the database image, which therefore
names only written files. Only once that image is durable does it delete
every portrait file the image does not name and no write is waiting for or
writing, so a replaced or removed portrait, or a deleted owner's, keeps its
file until then. A crash leaves at most files no image names, which the
next collection deletes; deleting a file needs no folder sync for the same
reason. An
orderly stop waits for in-flight responses within the drain deadline, then
flushes and closes every instance.

**Startup.** Before serving, `persistence/verification.ts` decrypts each user's
file in memory, applies generated SQL migrations and the synchronous native-data
upgrade, checks references, and atomically replaces every changed encrypted
snapshot through the existing writer. The application data version is SQLite
`user_version` (native version 1); even a version-only change is dirty. Conversion
failure rolls back every row and version change. A failed encrypted write refuses
startup. Earlier users already written may remain upgraded if a later user fails;
the deployment snapshot is the downgrade recovery, and retry recognizes upgraded
files without rewriting them. Portrait presence is checked; missing files are
counted, not fatal. On open, files no row names are collected; a missing full image
answers 404 while its stored thumbnail remains available.

Legacy conversion preserves ids, links, settings references, sampler values,
portraits, notes and timestamps, advancing revisions only for changed entities.
It normalizes retired macro aliases only in fields evaluated by the macro engine.
Wider saved text uses distinct stored-read schemas and stays visible for reduction;
public writes, file imports and native exports keep their bounds. Oversized exports
answer 413. A no-op event that becomes blank retains its identity and settings but
is disabled; public writes still require instructions.

**Caching.** Every response is `no-store, no-transform` except a current
portrait, `GET /api/{characters|personas}/:id/portrait/image?size=…&v=…`,
which is `private, no-cache, no-transform` with an `ETag` derived from the
username, entity, version and size: the browser revalidates it on every use
and gets a 304 only for its own user's copy, while another user's request
for the same address passes the boundary and gets a 404.

## Sign-in expiry

Every API request, the chat stream included, goes through one fetch owner
(`apiFetch` in `apps/web/src/api.ts`, the Hono client's `fetch`) with
`redirect: "manual"`. The proxy answers an expired session with a 302 to
the portal on every request (with SWAG and Authelia, Authelia's
`auth-request` 401 turned into a redirect by SWAG's include), which a manual-redirect fetch sees as an
`opaqueredirect`; that, or a 401, marks the tab signed out. Ephemera's API
never answers either. The sign-in owner (`apps/web/src/signin/`) holds the
phase in tab memory, listens on a `BroadcastChannel` only while signed out,
and opens `/auth/renewed` with `noopener` when the owner chooses Sign in.
The portal returns that window to `/auth/renewed`, a second Vite entry served
by the server behind the boundary, whose same-origin script posts a fixed
`{ type: "renewed" }` and closes the window. Only Ephemera's own answer
(a success or its JSON) to a request sent while signed out also proves the
session. On renewal each owner resumes once, within a bounded pass in two
stages: first autosave flushes the edits it held, failed settings saves are
resent (queued together, plain fields and each reference apart) and failed
queries refetch; then the chat store runs its one pending generation in
place, found by the id of the alternate it was for (a generation refused
before its stream started; nothing is generated while signed out), and only
once those saves have ended. Without a model it waits until one is chosen;
a send made before it runs leaves its reply as not sent, with a failed
reply's actions. Only a refusal of a request sent since the last
renewal began counts; an older one is stale and simply retried. Signed in
again, the preview and portraits load again. Every code chunk loads in the
first idle moment after the first paint. A chunk that still fails stays
failed for the page's life (the browser's module map keeps it), so the
router's lazy route component, which would reload the tab, is replaced
(`src/app/router-package.ts`) by one that shows a calm error saying a
reload ends the chat. Exports confirm the session with a request Ephemera
must answer before they download, because Chromium follows a redirected
download as a navigation.

A sign-in may come back as another user. The server writes the requester's
username on the app shell's `<html>` as `data-user`; the tab reads it once
(`apps/web/src/signin/identity.ts`) and `apiFetch` sends it with every API
request as `X-Ephemera-User`. The boundary refuses a request whose bound
user differs from `Remote-User` with 412 `identity_mismatch` before any
route runs, so nothing of the previous user is read or written. The header
is required on every unsafe request under the proxy key, so a tab that
names no user never writes; it stays optional on safe methods, which
navigation and images cannot bind, and on Atelier's integration route. The tab
then drops its state, hides the page and reloads as the new user; unload
guards stay quiet, and no request goes out after that. The renewal window
posts its own `data-user`, and a renewal naming another user takes the same
path.

## UI settings

The root route loads the settings before the first render. The chat store
reads the model, sampler preset and persona from them when sending, and the
creator, the studio and Picture this scene read the image prompt model when
a batch or picture starts; each
user turn keeps the persona it was sent as, in memory. Session, Settings and
the theme switch change them through one mutation, applied in the tab at
once and saved in order. A save that fails or is refused is said inline on
Settings and, wherever else the choice was made, in a notice over the
content column. A change made before the settings first loaded is laid over
them once they do. The server sets the saved theme and palette on the app
shell's `<html>` (`data-theme`, `data-palette`) with Bun's `HTMLRewriter`,
and links the requester's custom palettes as `/api/palettes.css` when there
are any (the policy allows no inline style), so a reload paints them before
any script runs; nothing of the settings is kept in the browser. A user's settings are
shared by every tab of theirs, so in e2e every test signs in as a fresh
user of its own (`e2e/support/test.ts`): its page, its API client and
every context it opens carry that user's headers unless it names others,
and its instance, settings included, starts from the seeded baseline that
no other test touches. The specs, settings included, therefore run side by
side, test by test. The M10 acceptance chat runs one test at a time
against an app server of its own, since the mock upstream keeps one queue
of scripted replies; the 5,000-entry lorebook spec runs on that server
once the rest is done, since its card would starve whatever ran beside it.

## Development

The API always requires the proxy key and a valid username. In development
the Vite dev server proxies `/api` to the Hono server and injects the key
and `Remote-User` from the ignored root `.env` (see `.env.example`),
standing in for the authentication proxy, so the browser origin is `http://localhost:5173`. The
username is `EPHEMERA_DEV_USER`, `dev` unless set. Vite serves the page
itself, without `data-user`, so a development tab is unbound and the
proxy sets `X-Ephemera-User` to the same username. The client bundle receives no environment
variables but one: the build revision (below). E2E tests run the built app against a synthetic mock upstream and
a mock ComfyUI (`e2e/support/mock-comfyui.ts`: the server tests' fake in
both modes behind a real port, a scope per test, recording its queue,
history and leases) and inject the headers through Playwright. Their ports derive from the checkout's
path, so e2e runs in separate worktrees almost always use their own ports.

The Hono server sends the Content Security Policy of principle 2 on every
response, with Trusted Types enforced; the SPA therefore runs Zod without
code generation (`jitless`, set by a module every `zod` import is aliased
to, so it holds before any schema is created) and bundles micromark's
table-based entity decoder instead of its `innerHTML` browser build. The Vite dev server needs an inline React
Refresh script, so the policy applies to the built app only; e2e tests fail
on any policy violation but one: an image, script, stylesheet or font the
simulated sign-in redirect sent to the portal, which the policy refuses as
it should. Errors the runtime catches outside the app are
answered through the same headers. The one response without them is Bun's
own refusal of a body past its `maxRequestBodySize` backstop, sent before
the app sees the request: a bare 413 with no body. Every route's own limit
sits below that backstop.

A tab keeps running the build it loaded, and core's strict response schemas
refuse a field a later deploy adds, so a tab from before a deploy would fail
to read its own data. The image therefore builds the SPA and runs the server
with the same `EPHEMERA_BUILD_REVISION`, the deployed commit: the server
names it in `X-Ephemera-Build` on every response (`apps/server/src/build.ts`),
`apiFetch` compares every answer's with the revision the bundle was built
with (`apps/web/src/app/build.ts`), and once they differ the shell shows a
notice offering a reload, which meets the chat's own leave guard. Outside
the image the server names no build and no tab is asked to reload.

### Roleplay comparison

`bun scripts/roleplay/compare.ts --model <id>` compares the current and
concise behavioral reminders and two authored lorebook placements on synthetic
fixtures. It defaults to offline prompt and prefix estimates, with no model
calls. `--live` explicitly enables calls and requires
`EPHEMERA_UPSTREAM_BASE_URL` and `EPHEMERA_UPSTREAM_API_KEY` in the environment.
The default matrix is capped at 20 calls; repetitions, output, per-request time
and the overall run have bounds. Scores are bounded heuristic checks, never
proof of immersion, and local prefix estimates are not provider cache evidence.
The runner prints numeric diagnostics and outcomes, writes no artifacts and
does not print raw model output. `scripts/roleplay/stdin.ts` is the explicit
entry for an in-memory bundle piped to `bun - --model <id>`;
bundling with `write: false` keeps the executable in memory too. Neither entry
changes saved settings or prompt defaults.

### Affected tests

One gate before a merge: `bun run check` runs the typechecks (the four
projects side by side), lint, unit tests and the persistence audit, one
after another, because the type-aware lint
and the type checker would otherwise compete with the unit tests' time
bounds. `bun run test:e2e` runs the whole browser suite on request and is
not part of that gate. `bun run test:affected` runs `bun run check` whole,
then the e2e specs a change calls for, where the change is whatever
differs from the merge base with `origin/main` (or `--base <ref>`):
commits, staged and unstaged edits and new files. Its check is the merge
gate, so a change that passed it needs no second check unless a file
changed since, prose included. `--dry-run` prints the plan only.

For shared-host contention, `bun run test:affected --workers 2` forwards
Playwright's native `--workers=2` to `bun run test:e2e` for both whole and
focused runs. Playwright validates the value; omitting it preserves the
default worker behavior. The check stage, spec selection and retention
dependencies stay the same.

The e2e choice takes the specs that are the main test of an area the
change serves, the specs Playwright's `--only-changed` finds importing a
changed file, and the retention scans.

`e2e/areas.ts` owns the e2e choice: the product areas, the areas each spec
is the main test of (`SPEC_AREAS`) and the area that owns each source path
(`SOURCE_AREAS`, longest prefix first). A spec's areas are its subject,
not every area its tests pass through, so a chat change does not run the
lorebook spec because that spec opens a chat; a guard (the retention
matrix, hostile input, autosave) is the main test of each area it guards.
The design area holds the shell, the shared components and the
stylesheet, and its spec visits every page. A change reaches its own areas
and those of the files that import it directly or transitively:
`scripts/affected/graph.ts` reads the import graph of the three source
trees with Bun's transpiler, without type-only imports, completes a path
without an extension as the bundler does, and follows an import from
`@ephemera/core` through the package's indexes to the module
that defines each name, so a core module is tied to the code that uses it.
Traversal stops before importers that say nothing about where a change
lands, neither returning them nor following their importers: the
files that compose the app (`COMPOSITION`: routes, the entry, the server's
assembly, the indexes) and shared source owned by `all`, which nearly every
module reaches. Cycles terminate without returning the changed file, and
the reached paths are deduplicated and sorted. The shared query client
(`apps/web/src/app/query.ts`) has an explicit `all` owner within the design
folder: changing it takes the whole suite, while traversal from another
source stops there. Unplaced source also belongs to `all`. A change to
such shared source (the API client, query cache, persistence, the server's
boundary, e2e support, what the mock servers import), a removed
spec and any change to dependencies, compiler or Playwright configuration
take the whole suite, as does a graph that cannot be built: an unplaced path is
never a skipped test. A unit test fails when a spec file has no row, an area has no spec,
or a listed path is gone.

A focused e2e run names its spec files in `EPHEMERA_E2E_SPECS`, which
is validated against `SPEC_AREAS` and `ALWAYS_SPECS` in `e2e/areas.ts`
before any browser or server starts. Any unknown filename fails the run,
including one alongside valid names; an unset or empty value takes the
whole suite. `playwright.config.ts` applies the selection to each browser
project's `testMatch`. A command line filter would not do: the retention scans depend on the
browser projects, and Playwright runs a dependency whole. The scans then
run as always, over what the chosen specs wrote: `server-writes.check.ts`
checks every matrix row that ran and requires each selected producer spec's
row markers. A missing marker fails; only an absent row whose producer was
excluded is skipped by name. Its proofs that every server served a chat
wait for the whole suite.

## Native files

`packages/core` owns strict `{ format, version: 1, data }` envelopes for characters,
lorebooks, prompt presets and sampler presets. Foreign SillyTavern Character Card
V2/V3, World Info and Chat Completion files convert at import only. Numeric codecs,
legacy aliases and wrapper conversion live in boundary adapters. Native stores and
generation consume typed data, without opaque extensions. Source templates apply
to every source block, including lorebooks, examples and cast anchors. Native
presets keep 128 custom blocks, Author's Notes, reasoning policy and separate
Continue/Write for me actions. Prompt and sampler exports are independent at
`GET /api/presets/prompt/:id/export` and `/sampler/:id/export`; imports validate
the shared response union and create only their native kind, or a foreign pair
atomically. Native imports need no provider catalog.

The import corpus is `packages/core/test-fixtures/imports`. Core and server tests
cover conversion, files, prompt behavior and durable upgrade; e2e uses direct
native behavior assertions in `prompt-behavior.spec.ts` and the file/editor specs.
`bun run cards:check <folder>` imports real PNG/JSON files, reads both native
exports back and assembles replies against a fake upstream, all in memory. It
prints counts and fixed codes only, never filenames, card text or error messages.
Private card folders stay outside the repository or in ignored `.cache/`.

## Retention enforcement

Principle 1 in `PRINCIPLES.md` owns the rules; this maps them to mechanisms.

| Hop | Mechanism |
|---|---|
| Browser | In-memory store with session epoch, `pagehide` clear, abort on Clear, chat metadata (pick seed, cache affinity id) renewed on Clear and held only in the store, `no-store, no-transform` overwrite on every response (which also keeps the page out of the back/forward cache and stops Cloudflare's script injection), no service worker, dependency audit, leave confirmation, expiry recovery without navigating |
| Authentication proxy (SWAG in the reference topology) | Request and response buffering off, tmpfs body spill, no proxy cache, content-free access log, no error log, long stream timeouts |
| Container | Streaming handler without writes, schema-restricted persistence (one module, audited, whose writes parse character, persona, preset, lorebook, event, memory, cast sheet, workflow and settings schemas), operational-only logger, read-only root, tmpfs `/tmp`, no swap, logging driver `none` |
| Upstream (CLIProxyAPI in the reference topology) | Commercial mode, request/debug logging and error dumps off, a canary after upgrades (§ Deployment checks) |
| ComfyUI | Receives the image prompt only; portraits return over the WebSocket from a node that saves nothing; the job removed after every run (lease release on Atelier's private worker; queue and history deletion and the cache release through `/free` on a plain instance); no prompt-bearing logs, disk output or retained history as deployment prerequisites |
| Evidence | Retention test matrix across hops (browser storage, URL and history, back/forward, clipboard, profile directory; the server's data, temp and home directories, logs and the repository; the mock ComfyUI's queue, history and leases), content classes and failure paths, each row proving its content existed; uninspectable hops reported as unverified. Outside the matrix, `e2e/retention.spec.ts` › "the cache affinity id stays in the tab and the request" checks the id by value: one id for every request of a chat, a new one after Clear, none in previews, browser storage, URLs, the closed profile directory, the server's data directory or its log |

### Retention matrix

The evidence row above in detail: rows are content classes and failure paths,
each with its canary label (`zqcanary7w-<label>-<id>`, assembled at runtime);
columns are the hops the tests can inspect locally. Each row first proves its
content existed; a cell that cannot be inspected fails as unverified. Every
scan looks for a canary as UTF-8, as UTF-16LE and as the base64 of its bytes
at each of the three offsets a byte can take in a base64 group: a candidate
portrait carries its mark as raw bytes in a PNG text chunk and reaches the
tab as base64. The positive control is `e2e/server-writes.check.ts` › "the
scan finds a candidate portrait's marker as raw bytes and as base64".

Hops:

- **B-store** every storage surface: localStorage, sessionStorage,
  IndexedDB, cookies, Cache Storage, OPFS, service workers, `window.name`.
- **B-url** URL, `history.state`, `navigation.entries()` URLs.
- **B-bf** back/forward: after leaving and returning, nothing restored.
  Chromium 153 never keeps the app's document in the back/forward cache,
  because it is served `no-store`; the cell requires either a return from
  the cache (then `pagehide` must have emptied it) or Chromium's
  `notRestoredReasons` naming `response-cache-control-no-store`, so it never
  passes without evidence. The `pagehide` clear itself is pinned by
  `chat.spec.ts` › "pagehide empties the chat, DOM included, before the page is hidden".
- **B-clip** clipboard: a sentinel written before the row is still there
  after it.
- **B-disk** the persistent profile directory after the browser closes.
- **S-data** data directory: its raw bytes, and every user database
  (`users/<name>/ephemera.sqlite.enc`) and portrait file
  (`users/<name>/portraits/<id>.enc`), an unfinished write's temp file
  included, decrypted for its user, and a portrait file for its id, with
  the test key and scanned as plaintext (`dataDirContaining` in
  `e2e/support/scan.ts`). A file that does not decrypt leaves the hop
  unverified, and a positive control checks that a canary inside a
  database or portrait file is found only by the decrypting scan.
- **S-tmp** the server's `TMPDIR`.
- **S-log** stdout and stderr.
- **S-home** the server's `HOME`.
- **S-repo** files changed in the repository during the run.

Locally S-data, S-tmp, S-log and S-home cover every e2e app server, the
parallel specs' and the serial specs', and S-data every user folder on
each, one per test.

| Row (class or failure path) | Label | B-store | B-url | B-bf | B-clip | B-disk | S-data | S-tmp | S-log | S-home | S-repo |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Input (sent message) | `in` | M | M | M | M | M | S | S | S | S | S |
| Draft | `draft` | M | M | M | M | M | S | S | S | S | S |
| Output | `out` | M | M | M | M | M | S | S | S | S | S |
| Reasoning | `think` | M | M | M | M | M | S | S | S | S | S |
| Character's Note, and the chat sent beside it | `cnote` | M | M | M | M | M | S | S | S | S | S |
| Inspector prompt (last sent, preview) | `prompt` | M | M | M | M | M | S | S | S | S | S |
| Lorebook activation, matched text, from the card's book and a linked library book | `lore` | M | M | M | M | M | S | S | S | S | S |
| Lorebook timed effects (sticky and cooldown state) | `timed` | M | M | M | M | M | S | S | S | S | S |
| Event state, and an event's text as filled for a request | `event` | M | M | M | M | M | S | S | S | S | S |
| Local and global macro variables | `macro` | M | M | M | M | M | S | S | S | S | S |
| Swipes | `swipe` | M | M | M | M | M | S | S | S | S | S |
| Edits | `edit` | M | M | M | M | M | S | S | S | S | S |
| Continuations | `cont` | M | M | M | M | M | S | S | S | S | S |
| Impersonated drafts | `imp` | M | M | M | M | M | S | S | S | S | S |
| Upstream error | `err` | M | M | M | M | M | S | S | S | S | S |
| Cancellation (Stop) | `stop` | M | M | M | M | M | S | S | S | S | S |
| Clear during streaming | `clear` | M | M | M | M | M | S | S | S | S | S |
| Oversized chat (413, and a prompt past the window) | `big` | M | M | M | M | M | S | S | S | S | S |
| Back/forward | `bf` | M | M | M | n/a | M | S | S | S | S | S |
| Reload | `reload` | M | M | n/a | M | M | S | S | S | S | S |
| Session expiry mid-send (D2) | `expiry` | M | M | M | M | M | S | S | S | S | S |
| Server restart mid-stream | `rst` | R | R | R | R | R | R | R | R | R | S |
| Malformed requests | `bad` | n/a | n/a | n/a | n/a | n/a | S | S | S | S | S |
| Memory: the remembered span | `mem` | M | M | M | M | M | S | S | S | S | S |
| Memory: upstream error | `memerr` | M | M | M | M | M | S | S | S | S | S |
| Memory: Clear mid-call | `memclear` | M | M | M | M | M | S | S | S | S | S |
| Memory: a span folded in a request | `memfold` | M | M | M | M | M | S | S | S | S | S |
| Memory cast: source turns and scene state | `memcast` | CA | CA | CA | CA | CA | S | S | S | S | S |
| Cast register: the keeper's answer | `cast` | CA | CA | CA | CA | CA | S | S | S | S | S |
| Cast register: keeper upstream error | `casterr` | CA | CA | CA | CA | CA | S | S | S | S | S |
| Cast register: Clear mid-call | `castclear` | CA | CA | CA | CA | CA | S | S | S | S | S |
| Cast register: an owner correction | `castedit` | CA | CA | CA | CA | CA | S | S | S | S | S |
| Cast sheet: character data | `castsheet` | CA | CA | CA | CA | CA | S | S | S | S | S |
| Creation drafts: success before Keep | `crok` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: Discard | `crdiscard` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: Rewrite | `crrewrite` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: automatic retry | `crretry` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: Stop mid-stream | `crstop` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: upstream error | `crerr` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: ComfyUI error | `crcomfy` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: navigation away | `crnav` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: brainstorm | `crbrain` | C | C | C | C | C | S | S | S | S | S |
| Creation drafts: reload | `crreload` | C | C | n/a | C | C | S | S | S | S | S |
| Creation drafts: server restart mid-generation | `crrst` | CR | CR | CR | CR | CR | CR | CR | CR | CR | S |
| Rework drafts: review before Apply | `rwok` | W | W | W | W | W | S | S | S | S | S |
| Rework drafts: Discard | `rwdiscard` | W | W | W | W | W | S | S | S | S | S |
| Rework drafts: Stop mid-stream | `rwstop` | W | W | W | W | W | S | S | S | S | S |
| Rework drafts: upstream error | `rwerr` | W | W | W | W | W | S | S | S | S | S |
| Rework drafts: navigation away | `rwnav` | W | W | W | W | W | S | S | S | S | S |
| Rework drafts: reload | `rwreload` | W | W | n/a | W | W | S | S | S | S | S |
| Rework drafts: Apply with a rejected change | `rwapply` | W | W | W | W | W | S | S | S | S | S |
| Sheet art: candidates before Use | `saok` | SA | SA | SA | SA | SA | S | S | S | S | S |
| Sheet art: Use as portrait | `sause` | SA | SA | SA | SA | SA | S | S | S | S | S |
| Scene picture: painted | `scene` | P | P | P | P | P | S | S | S | S | S |
| Scene picture: ComfyUI error | `sceneerr` | P | P | P | P | P | S | S | S | S | S |
| Scene picture: Stop mid-paint | `scenestop` | P | P | P | P | P | S | S | S | S | S |
| Scene picture: Clear mid-paint | `sceneclear` | P | P | P | P | P | S | S | S | S | S |
| Imported workflow: the prompt place's text | `wf` | WF | WF | WF | WF | WF | S | S | S | S | S |
| Image card: kept | `icok` | n/a | n/a | n/a | n/a | n/a | I | I | I | I | I |
| Image card: upstream error | `icerr` | n/a | n/a | n/a | n/a | n/a | I | I | I | I | I |
| Image card: unusable answer | `icinvalid` | n/a | n/a | n/a | n/a | n/a | I | I | I | I | I |
| Image card: caller disconnect | `icstop` | n/a | n/a | n/a | n/a | n/a | I | I | I | I | I |

The timed state is numbers, not text, so the `timed` row also proves it gone by behavior: after Clear, a reload and `pagehide`, a message without the canary no longer brings its sticky entry in, at the mock upstream or in the inspector, though it is sent on the card greeting at a message count still inside the sticky span had the state survived. A sticky entry of a linked library book is checked beside the card's in every step, and a preview must not commit either.

The event state is ids and numbers, so the `event` row proves it by
behavior too: an event at 100% for the row's character, resting for 1,000
replies after it fires, is absent from the reply after one it fired on, and
fires again on the next reply after Clear, a reload and `pagehide`. The
draft's preview carries no event and the send that follows it fires, so a
preview neither rolls nor commits. The event's text, persisted as the
template `Keep {{lastUserMessage}} in mind`, expands to the canary the chat
sent; the row finds the expanded direction at the mock upstream and in the
inspector, and the browser and server cells find it nowhere.

The `macro` row sets synthetic local/global values through chat text and
proves both reached the upstream prompt. A preview setter must not alter
the next send; Clear, reload and `pagehide` must leave both namespaces empty.
Only generic variable-reading templates are persisted, never their values.

The memory rows chat with a character whose memory is on and carry the
canary in the first line, which with the four newest messages kept out is
the span Remember now sends; each proves the canary at the mock upstream's
memory call. The mock answers with fixed synthetic prose holding no canary
and a ledger number of its own. `mem` writes the memory and finds its
summary in S-data and in no other server hop, the positive control that
persisted memory is scanned; the mock's answer carries an opening, which
is stored with `{{user}}` as written and found in S-data only. The chat
is then cleared without remembering and opens on that opening, filled
for the persona in play, and a message is sent on it: the filled
sentence reaches the upstream and is found in no server hop, nor in
browser storage, URLs or the profile on disk. `memerr` fails both attempts with the mock's
error body, which echoes the span, and writes nothing. `memclear` holds
the mock's answer, clears the chat while the call runs, and finds the call
aborted at the mock, never answered, and nothing written. `memfold` chats on
`mock-fold`, whose window is small enough to trim, holds the remembered
span, then chats until a request folds it: the canary reached the upstream
while held, and the request that folds it carries the mock's memory in the
story block and the canary nowhere. The held memory's id is found in
S-data only, where its episode lives.

The rows, labels and producer spec filenames have one owner, `MATRIX_ROWS`
in `e2e/retention-matrix.ts`, re-exported by `e2e/support/retention.ts`.
Each row that ran leaves an empty file named by its label in `.e2e/classes/`.
The shared row policy requires that marker for every selected producer,
and for every row in a full run.

- **M** `e2e/retention.spec.ts` › "retention matrix: <row>", one test per
  row in its own persistent profile: the step "<label>: the content exists"
  proves the canary was on the page or at the mock upstream, then one step
  per browser cell, named `B-store`, `B-url`, `B-bf`, `B-clip` and `B-disk`.
  Every browser row of **M**, **CA**, **C**, **W**, **SA** and **P** runs
  through one harness, `matrixRow` in `e2e/support/retention.ts`, so each
  gets the same cells.
  The expiry row routes the app through `e2e/support/signin.ts`, shared with
  `e2e/signin.spec.ts`.
- **S** `e2e/server-writes.check.ts` › "<hop> holds no <label> canary", one
  test per server cell, failing as "row did not run" when the label is not in
  the manifest and as unverified when the hop cannot be read; beside them
  "<hop> holds no canary of any class" and the positive controls "the
  <server> server's data directory was scanned and its log recorded replies"
  and "the main server's log recorded errors".
- **R** `e2e/restart.spec.ts` › "retention matrix: server restart
  mid-stream", its own server process (own port, data, temp and home
  directories and captured output under `.e2e/restart/`), killed mid-stream
  in the steps "rst: SIGKILL mid-stream, then a restart" and "rst: SIGTERM
  mid-stream, then a restart"; then the steps `B-store`, `B-url`, `B-bf`,
  `B-clip`, `B-disk`, `S-data`, `S-tmp`, `S-log` and `S-home`. Its S-repo
  cell is "S-repo holds no rst canary".
- **CA** `e2e/cast-retention.spec.ts` › "retention matrix: cast register:
  <path>", "retention matrix: cast sheet: character data" and "retention
  matrix: memory cast: source and scene state", one test per
  row in its own persistent profile. The mock keeper names a woman after the
  newest turn's canary, `-in-` turned to `-cast-`. The step "<label>: the
  content exists" proves the canary at the mock upstream's keeper call:
  `cast` finds her in the panel, in the next request's `<cast>` block and
  in the inspector, then gone after Clear; `casterr` fails the keeper with
  the mock's echoing error body and finds the panel's failure line;
  `castclear` clears the chat while `mock-slow` holds the keeper and finds
  the call aborted, never answered; `castedit` corrects a field to the
  canary and finds it in the preview and the next request. `castsheet`
  leaves a sheet request mid-job, finds the sheet stored anyway, an entry's
  id in S-data only and the next request answered from it without a new
  call, then chats on the canary beside the sheet. `memcast` proves source
  turns and a register correction existed, remembers them, and finds only
  the validated derived cast anchor in S-data. Source turns, keeper output
  and scene state remain forbidden at every inspected hop. Then the steps
  `B-store`, `B-url`, `B-bf`, `B-clip` and `B-disk`.
- **C** `e2e/creator-retention.spec.ts` › "retention matrix: creation
  drafts: <path>", one test per row in its own persistent profile. A row's
  description holds `zqcanary7w-<label>-<id>-desc`, and the mock upstream and
  mock ComfyUI derive every later draft from it: the card holds `-card`, the
  image prompt `-prompt` and the four portraits `-img0` to `-img3`; a
  direction typed for new art holds `-steer`. The step
  "<label>: the content exists" proves the description in its field and at
  the mock upstream, the card on the page, the image prompt at the mock
  ComfyUI and the four portraits' bytes in the framed art stream the
  tab received, as far as the path reaches them. ComfyUI must then hold no
  queued or running prompt, history entry or lease, after the abort and
  failure paths too. Then the steps `B-store`, `B-url`, `B-bf`, `B-clip` and
  `B-disk`.
- **CR** `e2e/creator-retention.spec.ts` › "retention matrix: creation
  drafts: server restart mid-generation", its own server process under
  `.e2e/creator-restart/`, killed in the steps "crrst: SIGKILL while the
  card is written, then a restart", "crrst: SIGTERM while the portraits
  are painted, then a restart" and "crrst: SIGKILL while the portraits are
  painted, then a restart", then the browser and server cells as in **R**.
  After the SIGTERM the plain mock ComfyUI holds nothing of the run; after
  the SIGKILL it still holds the prompt of the run whose client was killed:
  the residual risk principle 1 states, shown rather than hidden.
- **W** `e2e/rework-retention.spec.ts` › "retention matrix: rework
  drafts: <path>", one test per row in its own persistent profile. A row's request holds
  `zqcanary7w-<label>-<id>-req`, and the mock upstream derives the answer
  from it: a change to reject holds `-rej`, every reason `-why` and the
  summary `-sum`, while the changes an Apply keeps write `kept-<label>`
  texts, which are not canaries. The step "<label>: the content exists"
  proves the request at the mock upstream and, as far as the path reaches
  them, `-rej` and `-why` on the page and `-sum` in the stream the tab
  read; the `rwapply` row reads the character back through the API and
  finds the accepted texts there. Then the steps `B-store`, `B-url`,
  `B-bf`, `B-clip` and `B-disk`.
- **SA** `e2e/sheet-art-retention.spec.ts` › "retention matrix: sheet
  art: <path>", one test per row in its own persistent profile. A saved character from a non-canary `kept-` base; the row
  types a direction holding `zqcanary7w-<label>-<id>-steer`, which outranks
  the card's mark, so the image prompt holds `-prompt` and the four
  portraits `-img0` to `-img3`. The step "<label>: the content exists"
  proves the direction at the mock upstream, the image prompt at the mock
  ComfyUI and the four in the art stream the tab read; ComfyUI then holds
  nothing of the run. `sause` paints four distinct candidates from a
  character with a stored portrait, Uses the fourth, finds the stored
  portrait equal to what the server makes of it, and scans fragments of
  the other three and of the JPEG reference sent upstream across the
  browser and server hops. Then the steps `B-store`, `B-url`, `B-bf`,
  `B-clip` and `B-disk`.
- **P** `e2e/scene-retention.spec.ts` › "retention matrix: scene
  picture: <path>", one test per row in its own persistent profile. A row
  chats with a saved character from a non-canary `kept-` base, on a line
  holding `zqcanary7w-<label>-<id>-steer`, which outranks the card's mark in
  the scene source, so the image prompt holds `-prompt` and the one picture
  `-img0`. The step "<label>: the content exists" proves the line at the
  mock upstream's scene call and the image prompt at the mock ComfyUI;
  ComfyUI then holds nothing of the run. `scene` paints on the private
  worker, finds one job input uploaded, the picture in the scene stream the
  tab read and on its canvas, and scans fragments of the picture's noisy
  bytes across the server hops and the profile. `sceneerr` fails the run
  inside ComfyUI and finds the lease released; `scenestop` presses Stop the
  picture and `sceneclear` clears the chat while ComfyUI samples, each
  finding the run interrupted. Then the steps `B-store`, `B-url`, `B-bf`,
  `B-clip` and `B-disk`.
- After Keep, `e2e/creator.spec.ts` › "Subject: written, four portraits,
  another picked, and Keep saves exactly one card and its portrait" finds
  exactly one new character with one portrait, the upload carrying the
  picked portrait only; the marks of the description, the image prompt and
  every candidate portrait nowhere in the server's data, temp and home
  directories, its log or the profile directory; and the kept card's text in
  the data directory only. Its marks are not canaries, since a kept card
  persists by design.
- **I** `e2e/image-card-retention.spec.ts` › "retention matrix: image card:
  <path>", server cells only, checked as in **S**. Each row posts what
  Atelier's server sends, with the integration key: notes holding
  `zqcanary7w-<label>-<id>-desc`, a direction holding `-steer` and a PNG
  whose text chunk holds `-src`, which the portrait pipeline strips; the mock upstream answers with
  `-card`. The image's top rows are random pixels, so the JPEG vision copy
  the server sends is unique to the row; the mock upstream records the data
  URL it received, and fragments of its compressed noise, held in the test's
  memory, are scanned for raw and as base64 across every server hop (a scan
  of planted copies, raw and as the data URL, is the positive control). The
  step "<label>: the content exists" proves the notes, the direction and
  the image at the mock upstream (two calls for the unusable answer, each
  answered with `-card`), a stream free of canaries, and no character and
  no copy of the image after the error, unusable and disconnect paths. The
  disconnect row's mock sends the answer up to its first `-card` chunk,
  records it once flushed to the socket, holds the stream open and leaves
  300 ms before the caller aborts: a flush plus a bound, not proof the
  server read it. In `icok` the notes also carry a
  `-keep` mark whose base is not a canary, and the card derives from it, so
  the kept card persists by design; the row reads it back with its portrait,
  finds no `-src` in the stored PNG, finds fragments of the stored PNG and
  the card's base in the data directory only, and finds the JPEG sent
  upstream, the `-keep` notes mark and the direction nowhere.
- **WF** `e2e/workflows-retention.spec.ts` › "retention matrix: imported
  workflow: the prompt place's text". The row imports a saved workflow
  whose prompt text holds `zqcanary7w-wf-<id>`, then replaces its file
  with an API export holding a second canary. The step "wf: the content
  exists" proves each in the tab, where the panel shows the file's prompt
  in its Prompt row, before Save stores the template with `{{prompt}}` in
  that place and closes the panel. Then the steps `B-store`, `B-url`,
  `B-bf`, `B-clip` and `B-disk`.
- **n/a** the path does not reach the hop (a malformed request never comes
  from the page; an image card request comes from Atelier's server, never
  a tab; clipboard across back/forward and cache across reload are covered
  by the neighbouring rows).

Outside this matrix, stated in the report, not claimed: process memory and
swap, browser internals.

### Deployment checks

The matrix runs locally. A deployment checks the hops beyond it by hand on
its own stack, with synthetic canaries in the matrix's format sent from a
signed-in tab and the cheapest fast models. As in the local matrix, each
row first shows its content exists (in the tab, the model's echo, the
assembled prompt or the activated entry), so a clean scan means something;
`stop` and `clear` run mid-stream, `rst` as a SIGTERM stop and a SIGKILL
mid-stream. A model that copies no canary into its reasoning gets `think`
traced with a fragment of the reasoning itself. Scans count matches of any
canary or fragment and print nothing else. Run them after the first deploy
and after any change to the proxy, the upstream or the ComfyUI setup.

| Hop | Inspect |
|---|---|
| Browser | storage surfaces, URL, history and `navigation` entries after each browser row; the closed profile directory, binaries included, with the hostname as a positive control |
| Authentication proxy | its log directory (the access log carries no path), any request-body spill location (tmpfs only), its temp and cache directories and its container logs |
| Identity provider | its log file and container logs |
| Tunnel or relay, if any | its stdout and stderr logs |
| Container | `/data`: its raw bytes, and every encrypted user database and portrait file under it (`users/<name>/` and `users/<name>/portraits/*.enc`, the deploy snapshots' `pre-deploy/<snapshot>/users/<name>/` and a failed restore's `users.failed-<timestamp>/<name>/` with their `portraits/`, unfinished writes' temp files included) decrypted for its user, and a portrait file for the id its name holds, with the deployment's `EPHEMERA_DATA_KEY` and scanned as plaintext, as **S-data** does for `users/` (a file that does not decrypt leaves the hop unverified); tmpfs `/tmp`, `docker diff` (only docker-init's mount point), health output; logging driver `none` leaves no log |
| Host | the data volume outside the data directory, `/tmp`, the deploy checkout (only the docs naming the canary format) |
| Upstream | its request, debug and error logs and any error dumps |

Not inspectable, so never claimed clean: the memory and disks of any VM the
containers run in (the proxy and the container run without swap), the
upstream's process memory and in-memory usage statistics, any CDN or tunnel
provider, and the model providers (`docs/PRINCIPLES.md` § Outside our
boundary).

## Deployment

One container behind a trusted authentication proxy, its port published on
the host's loopback only (§ Topology). The proxy terminates TLS, admits
users, clears inbound identity headers and injects `Remote-User` and the
proxy key; nothing else reaches the published port.

**Values and their copies.** This section owns them; a deployment's proxy
and host files repeat them and change together.

| Value | Owner | Copies |
|---|---|---|
| Public hostname | the deployment | the proxy's site and access rules, `EPHEMERA_ORIGIN` in the env file, `EPHEMERA_ORIGIN` in Atelier's env when used |
| Published loopback port | the override's `ports` | the proxy's upstream address or tunnel, `EPHEMERA_BASE_URL` in Atelier's env when used |
| Container port 8790 | `DEFAULT_PORT` in `apps/server/src/config.ts`, which Vite's dev proxy imports | the override's `ports` |
| Proxy key header `X-Ephemera-Proxy-Key` | `apps/server/src/boundary.ts` | the proxy's header injection and its clearing of inbound copies |
| Proxy key value | `infra/docker/.env` | the proxy's key configuration |
| Integration key value | `infra/docker/.env` | Atelier's `EPHEMERA_INTEGRATION_KEY` when used |
| Admitted users | the proxy's access rules for the hostname | none: a user's folder appears on their first request |
| Data key `EPHEMERA_DATA_KEY` | `infra/docker/.env` | the operator's backup |
| Bun version and image digest | `infra/docker/Dockerfile` ARGs | `@types/bun` in `package.json` (a unit test keeps it equal) |
| ComfyUI CA mount point `/run/comfyui-ca.pem` | `infra/docker/docker-compose.yml` | the Dockerfile's mount point, `CA_TARGET` in `infra/docker/contract.ts` |
| Workflows mount point `/run/workflows` | `infra/docker/docker-compose.yml` | the Dockerfile's mount point, `WORKFLOWS_TARGET` in `infra/docker/contract.ts` |

`EPHEMERA_REQUEST_TIMEOUT_MS` (600,000 unless set) stays above Atelier's
`EPHEMERA_CARD_TIMEOUT_MS` (540,000), so Atelier's deadline ends an image
card request before Ephemera's does.

**Prerequisites**
- A trusted authentication proxy for the hostname that meets principles 1
  and 2: every location (static assets and `/auth/renewed` included) behind
  authentication, an expired session answered with a redirect to the
  portal (SWAG's stock Authelia include does this, and the app recognizes
  it), inbound identity headers cleared, request and response buffering
  off, no proxy cache and a content-free access log. The proxy runs
  without swap.
- Access rules naming every intended user, followed by a deny rule for the
  same host. Ephemera admits whoever they admit.
- An OpenAI-compatible upstream verified per principle 1 and reachable from
  the container (README § Model providers lists common ones). Its API key
  may stay empty for a local server that needs none.
- For card portraits, a ComfyUI that meets principle 1's ComfyUI
  prerequisites (a plain ComfyUI or Atelier's private worker), reachable
  from the container, its address saved in Settings.

**Container**
- `infra/docker/Dockerfile` builds from the pinned `oven/bun` Alpine image
  (distroless lacks the `libstdc++` sharp loads); the SPA comes from the
  same `bun run build` e2e tests. The container runs
  `apps/server/src/index.ts` as UID 1000. The deployed commit (`VCS_REF`)
  is the image's revision label and the `EPHEMERA_BUILD_REVISION` of both
  the SPA build and the server (§ Development).
- `infra/docker/docker-compose.yml`, project `ephemera`: read-only root,
  tmpfs `/tmp` (`noexec,nosuid,nodev`), logging driver `none`, all
  capabilities dropped, `no-new-privileges`, a healthcheck
  (`infra/docker/healthcheck.ts`) that calls `GET /api/health` with the
  container's own proxy key and no `Remote-User`. The ignored
  `docker-compose.override.yml` (from the committed example) sets the memory
  limit, the equal swap limit and the only published port on the host's
  loopback, for example `127.0.0.1:8000:8790`. A host that pins its
  architecture does it there too: `platform` for the start and
  `build.platforms` for bake; the committed Compose file pins none.
- One bind mount for persisted data, ideally on an encrypted volume
  (`EPHEMERA_DATA_DIR`, holding `users/<username>/ephemera.sqlite.enc`
  and `users/<username>/portraits/` for each user and the deploy snapshots
  in `pre-deploy/`); an unset or missing path fails the start instead of
  creating an empty directory. The server makes it owner-only at start.
- One read-only bind of the ComfyUI CA certificate at
  `/run/comfyui-ca.pem`. `COMFYUI_CA_FILE` in the env file is its host path,
  and Compose points the container's `COMFYUI_CA_FILE` at the copy; while it
  is unset, the empty placeholder `infra/docker/no-comfyui-ca` is bound and
  the container's variable stays empty. A missing file fails the start.
- One read-only bind of the workflows directory at `/run/workflows`, in the
  same pattern: `EPHEMERA_WORKFLOWS_DIR` in the env file (or the shell) is
  its host path, and Compose points the container's
  `EPHEMERA_WORKFLOWS_DIR` at the copy; while it is unset, the placeholder
  directory `infra/docker/no-workflows/` is bound and the container's
  variable stays empty, so only the bundled graphs load. A missing
  directory fails the start, as does a bad graph in it (§ AI card creation
  and rework, Workflows directory).
- The upstream is reached at `EPHEMERA_UPSTREAM_BASE_URL` from inside the
  container: a service on the host needs an address the container can
  reach, such as `host.docker.internal` on Docker Desktop or the host's
  LAN address when the service binds only there.
- Secrets (the upstream API key, proxy key, `EPHEMERA_DATA_KEY`, the
  optional integration key `EPHEMERA_INTEGRATION_KEY` and ComfyUI bearer
  token `COMFYUI_API_KEY`) and the allowed ComfyUI origins
  `COMFYUI_ALLOWED_ORIGINS` live in the ignored `infra/docker/.env`
  (mode 0600, from `infra/docker/.env.example`), which Compose passes to
  the container. `EPHEMERA_DATA_KEY` is generated once
  (`openssl rand -hex 32`); losing it loses every user's data, a different
  key fails the start, and backing it up is the operator's job.
- `infra/docker/contract.ts` checks the resolved configuration before every
  start and the running container after it (the only service, read-only
  root, tmpfs, UID, no swap, logging, loopback ports, mounts, capabilities,
  not privileged, own PID, IPC and user namespaces, no devices or
  `volumes_from`, a pids limit, health, empty file-system diff, refused
  probe writes).
- Diagnostics follow principle 1: disk-backed logs only with synthetic
  content and no real chats running.

### Deploy checklist

Run in `infra/docker` of a clean checkout of the commit to deploy.

1. **Record the running image** when a `users/` tree exists:
   `docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' ephemera:latest`
   gives the previous image ID and revision (or tag it `ephemera:previous`).
   No `ephemera:latest` yet means no previous image.
2. **Configure.** Create `.env` (mode 0600) from `.env.example` and
   `docker-compose.override.yml` from the committed example. Keep every
   env file line `NAME=value` with balanced quotes and no `$` outside
   single quotes: Compose interpolates env file values.
3. **Build** a candidate tag (`ephemera:candidate`, for example with
   `docker buildx bake` and a tag override), never `ephemera:latest`,
   with the commit's full ID as its revision, from a context that holds
   only tracked files (a `git archive` of the commit, passed as
   `EPHEMERA_BUILD_CONTEXT`, keeps ignored files out), and check the Bun
   digest against the registry first (see Bump Bun).
4. **Check the configuration** against the candidate before anything starts:

   ```sh
   EPHEMERA_EXPECTED_DATA_DIR="$(cd <data directory> && pwd -P)" \
     bun contract.ts config ephemera:candidate
   ```

5. **Snapshot before migrations.** Stop the running container. When
   migrations may run (no previous image, a recorded revision Git does not
   resolve, or `apps/server/drizzle/` differs between the recorded and the
   new revision), copy the stopped data, the `users/` tree, to a new
   snapshot directory `pre-deploy/<UTC timestamp>-<recorded revision>` in
   the data directory (directories 0700, files 0600, renamed into place
   when complete). Never overwrite or delete a snapshot automatically:
   prune old ones by hand.
6. **Start.** Only now retag the candidate
   (`docker tag ephemera:candidate ephemera:latest`), start with
   `docker compose up -d --no-build --wait ephemera`, then run the Verify
   block below. Keep the previous image until the new one passes.
7. **Roll back** on failure: stop the container. If migrations may have
   run, move the live `users/` aside (keep it for inspection), copy the
   snapshot's `users/` tree in as an exact set, not an overlay, then start
   the recorded image (`docker tag <recorded image ID> ephemera:latest`,
   then `docker compose up -d --no-build --wait ephemera` with the recorded
   revision's Compose file). Without a snapshot of the matching state, only
   a forward fix applies. Never edit a deployed migration: Drizzle applies
   only migrations newer than the last one it recorded, so an edit never
   runs.

**Verify.** In `infra/docker`, with the data directory's real path and the
deployed image ID as the contract's expectations:

```sh
docker compose ps
EPHEMERA_EXPECTED_DATA_DIR="$(cd <data directory> && pwd -P)" \
  EPHEMERA_EXPECTED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' ephemera:latest)" \
  bun contract.ts container
```

`docker compose ps` shows the container healthy and the contract passes;
then open the hostname from an admitted user's browser. The container has
no logs by design:
`docker container inspect --format '{{json .State.Health}}' ephemera` shows
the health probes.

**Bump Bun.** `docker buildx imagetools inspect oven/bun:<version>-alpine`,
then update `BUN_VERSION` and `BUN_DIGEST` together with `@types/bun`.

### Local gateway

`./ephemera` (the launcher at the repository root, `ephemera.cmd` and
`scripts/ephemera/launch.ps1` on Windows, then `scripts/ephemera`) sets up
and runs the server without the container: for one person on this computer
behind the local gateway, or behind the operator's own proxy. The launcher
installs Bun when it is missing and the dependencies from `bun.lock` once;
every command reads `.env` itself (Bun's automatic `.env` loading is off),
with its values over the shell's, an empty one included. `.env`, the data
directory (unless `EPHEMERA_DATA_DIR` names another; a relative one is read
from the home, never from a version folder an update removes) and the run
state in `.ephemera/` live in the install's home: the checkout, or the
folder `EPHEMERA_HOME` names.

- `setup` writes `.env` from `.env.example`, atomically (a crash leaves the
  old file or the new one) and owner-only. It keeps a proxy key and data
  key that exist in `.env`, writes one the shell supplies into `.env` and
  makes the others, refusing to make a data key while a `users/` tree
  exists. It asks
  who uses Ephemera (just me, or behind a sign-in proxy), the username and
  port, and the model provider (the list in `scripts/ephemera/providers.ts`,
  kept equal to README § Model providers by a unit test), checks the
  provider's `/models` with the key, asks which listed model new libraries
  start with (`EPHEMERA_DEFAULT_MODEL`; Choose later in the app clears it),
  validates the whole configuration with
  the server's `loadConfig`, builds and restarts a running server. A saved
  API key is reused only for the base URL it was saved with. A value Bun's
  loader would read otherwise (`$`, a quote, a backslash, a newline) is
  refused. Without a terminal, or with `--yes`, it takes flags and
  `EPHEMERA_UPSTREAM_API_KEY` instead, keeps the current access mode and
  default model unless a flag names one, and fails rather than asks;
  `--model` must be an ID the checked provider lists, with the closest
  listed IDs named when it is not (`--no-check` takes it as typed).
  `doctor` warns when the provider does not list the default model.
- The served build lives in `.ephemera/web`, apart from `apps/web/dist`,
  which `bun run build` and e2e rewrite. A build is made in
  `.ephemera/web-next` with the checkout's commit (outside Git, a fresh
  name, every start) as `EPHEMERA_BUILD_REVISION`, and swapped in only
  while the server is stopped, so `update` builds while the old version
  still serves. The server runs with the served build's revision, so an
  open tab offers a reload after an update.
- `start` checks the ports, then runs `scripts/ephemera/serve.ts` in its own
  session with its output discarded, as the container's logging driver
  `none` does; `--foreground` keeps it attached with the operational log on
  the terminal. `serve.ts` takes `.ephemera/server.json` exclusively (its
  PID and address), so a second start ends before anything listens, then
  runs the gateway and the server in a process group of its own, so a
  terminal's hangup or Ctrl-C reaches `serve.ts` alone, which turns it into
  the server's orderly shutdown, asked over IPC, and waits for it. `stop`
  asks `serve.ts` through `.ephemera/stop.json`, naming its PID, which it
  looks for every 300 ms (a signal would end it at once on Windows), and
  elsewhere sends SIGTERM as well; `serve.ts` clears a request left for an
  earlier process when it starts.
  It records the
  server's exit status in `.ephemera/exit.json` once the gateway has handed
  over the last replies (5 s at most); `stop` reports saved only on that
  record. `stop`, `restart`, `status`, `open`, `update`
  (`git pull --ff-only`, install, build, restart when it ran) and `doctor`
  work from that record, matching the process by its exact command line
  (`ps`, or the process's CIM record on Windows).
  `.ephemera/` is Git-ignored and holds no content.
- `EPHEMERA_LOCAL_USER` turns the gateway on. The gateway listens on
  `127.0.0.1` at `EPHEMERA_LOCAL_PORT` (8780 unless set, never the server's
  own port); the server then listens on `127.0.0.1` too, and
  `http://localhost:<port>` replaces `EPHEMERA_ORIGIN`, so the root `.env`
  still serves `bun run dev`. Unset, `./ephemera` runs the server alone for
  a trusted authentication proxy of the operator's, which must meet
  § Deployment's prerequisites.
- The gateway (`scripts/ephemera/gateway.ts`) is that proxy for one user
  on this computer: a request whose `Host` is not the gateway's origin is
  refused with 421 before anything is forwarded (a page elsewhere can point
  its own name at 127.0.0.1); a GET or HEAD to `127.0.0.1:<port>` is
  redirected there with 308. It clears inbound `Remote-User` and proxy key
  headers, injects the proxy key and `EPHEMERA_LOCAL_USER`, passes the
  tab's `X-Ephemera-User`, `Origin` and everything else unchanged, never
  through the shell's `HTTP_PROXY`, never follows redirects, lifts its own
  idle limit for every request (the server bounds each one and keeps its
  streams alive) and aborts the server's request when the browser
  disconnects. A stop lets in-flight replies finish within the server's
  drain. It buffers, caches and logs nothing.
- On Windows, `install.ps1` (run as
  `irm https://raw.githubusercontent.com/SneakyShadyLurker/ephemera/main/install.ps1 | iex`
  in Windows PowerShell 5.1 or later; ASCII only, since 5.1 reads a script
  without a byte order mark in the system code page) makes an installed
  copy in `%LOCALAPPDATA%\Ephemera`, its home: it installs Bun with Bun's
  own installer, downloads the newest commit of `main` as an archive (no
  Git), unpacks it into `app-<commit>` with the system's `tar.exe`, records
  the commit in its `REVISION` file and names the folder in `current`. A
  shim `ephemera.cmd` in the home sets `EPHEMERA_HOME` and runs the current
  version's launcher; the home joins the user's `Path`, read and written
  raw in the registry so entries such as `%USERPROFILE%\...` stay
  expandable. Start menu and
  desktop shortcuts run `start --pause` (an error waits for Enter, so the
  window can be read), an optional Startup shortcut `start --no-open`; then
  it runs `setup`. Its steps throw rather than exit, so under `iex` the
  user's window stays open. Run again, it makes the shim, `Path` entry and
  shortcuts anew, so an interrupted install is repaired, then updates (or
  finishes a setup that never wrote `.env`). `update` in an installed copy (`scripts/ephemera/release.ts`)
  asks GitHub for the newest commit, downloads and unpacks it beside the
  running version, installs its dependencies and builds it from its own
  code, then stops the server, swaps the build in, names the new folder in
  `current`, removes versions but the new and the previous one (only
  `app-<commit>` folders and their partial downloads), and starts again from
  the new code, so no folder a running program holds is renamed. When the
  newest commit is the running one and only its build is missing, it
  rebuilds from that code instead.
  `EPHEMERA_REF` names another branch for testing. Windows has no mode
  bits: the home lies in the user's own profile, which other accounts
  cannot read by default, and `doctor` skips the `.env` mode check.
- Any program or account on the computer can reach loopback, so the
  gateway admits whoever uses the computer. It is not the hardened
  container: no read-only root, tmpfs or dropped capabilities.

## Browser baseline

Current Chromium-based browsers only (Chrome, Edge) on desktop and Android.
Browsers on iOS use WebKit and are not supported. Tests and the retention
matrix run in Playwright's Chromium build, not branded Chrome, so profile
evidence covers that build. Same-document View Transitions, `@starting-style`,
popover, `field-sizing`, anchor positioning and scroll-driven animations are
safe to use.
