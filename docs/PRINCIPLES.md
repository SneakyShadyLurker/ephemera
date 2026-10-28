# Principles

Ranked: when two principles conflict, the higher one wins.

## 1. Zero retention

Ephemera never persists chat content anywhere it controls. "Chat content"
means messages, swipes, drafts, assembled prompts, model output, reasoning
and session-only state such as local and global macro
variables, the lorebook's timed effects and which event fired on which
reply, the scene pictures painted from the chat with the source and
image prompts written for them, and the cast register: who is in the
story and how they stand, its snapshot per reply, the owner's corrections
and removals, and the keeper call's input and answer. Raw model text and its filled display text are both chat content.
Cast developments, continuity cues and literal grounding quotes follow the
same boundary. Provider-attempt receipts and the request/session usage ledger
are tab-only diagnostics: Clear, reload and `pagehide` drop them. Missing
reported counters are unknown, not zero; these counts make no price claim.
The Author's Note belongs to the prompt preset and persists with it; the
prompt it expands into is chat content. The chosen character,
persona, model and theme are UI settings, not chat content: they persist on
the server with the other settings, never in browser storage.

Creation drafts follow the same rules as chat content on every hop: the
owner's description for an AI-written card, the card before it is kept, a
direction for its new art, the image prompt written from it and the
candidate portraits, also when new art is painted for a saved character
(the stored portrait the prompt model may see is character data); and a rework
request, the model's proposed changes and the review state before Apply;
and for a card written from an image of Atelier (an optional image
service Ephemera supports), the uploaded image, its notes,
the owner's direction for it and the model's answer. Keeping a card turns it and the chosen portrait
into ordinary character data, as Use as portrait does with the one
portrait chosen for a saved character; applying a rework turns only the accepted
changes into it, through the sheet's own save. For an image-born card, the
click in Atelier is the user's Keep: the card and the image, as its
portrait, become character data on arrival, and nothing of a request whose
card is not kept persists. Everything else is dropped.

Memory is on for every character until its owner turns it off in the
character's sheet, and the app says so where memory is offered and in
Settings. With memory on, the model's memory of a span of the chat (a
title, a summary, its cues, the rewritten notebook, including its cast lines
of remembered NPC names, genders and fixed anchors, and the opening of the
next chat) persists as
character data, encrypted per user, editable and deletable. The span itself, the turns it covered, their ids and
the chat it came from never persist; which turns are folded and which
memories a chat carries stay in the open tab as chat content. A memory may
carry phrases from the chat, as a kept card carries its description.
Memory belongs to the character: a different persona continues that story
under the new player name, while a duplicate character has independent memory.
An archivist may read cast context only from a snapshot at or before its
span ends, without scene ids or volatile state. That context never writes
directly to character data; persistence accepts only the validated memory answer.

The controlled hops are the browser tab, the trusted authentication proxy
(SWAG in the reference topology), the Ephemera container, the
OpenAI-compatible upstream (CLIProxyAPI in the reference topology) and, for
creation drafts, the ComfyUI instance the owner configured, which also paints scene pictures. Each keeps chat content in memory only
and only as long as it is needed.

**Browser**
- Chat state lives in an in-memory store. Clear, refresh, tab close and
  `pagehide` empty it, so the back/forward cache cannot restore it.
- Clearing is one operation: advance a session epoch, abort every in-flight
  generation and inspector request, and drop any late result tagged with an
  older epoch. Nothing may repopulate a cleared chat.
- Both macro namespaces belong to the current chat in this tab. Neither
  reaches saved settings or a process-global server store. A request and a
  preview evaluate on validated copies; only an explicit chat action may
  commit the returned state for its still-current session epoch.
- No chat content in localStorage, sessionStorage, IndexedDB, cookies, Cache
  Storage, URLs, query strings or history state. No service worker.
- A scene picture is PNG bytes in the chat store, drawn onto a canvas from
  a bitmap decoded in memory, never a URL or a Blob, and outside the
  messages, so no generation, preview, inspector or memory call carries it.
  Clear, refresh and `pagehide` drop it, and so does deleting the message
  it follows.
- Per-chat metadata, the `{{pick}}` seed and the cache affinity id, lives
  in the same memory and is renewed on Clear. The affinity id leaves the
  tab only with a generation request; previews, logs and storage never
  carry it, and the server holds it for the request alone.
- Every response, streams included, is sent with `Cache-Control: no-store,
  no-transform`, overwriting library defaults such as the AI SDK's
  `no-cache`; `no-transform` keeps proxies such as Cloudflare from rewriting
  it (they would inject analytics and bot-detection scripts). The one
  exception is a portrait (a character's or a persona's avatar) requested by
  its current version, sent `private, no-cache, no-transform` with a
  validator bound to the user: the browser may keep it but asks the server
  before every use, so the boundary always runs and another user's request
  for the same address is refused, never answered from the cache. Portraits
  are never chat content.
- The composer disables autocomplete and the page opts out of machine
  translation (`translate="no"`).
- A dependency that persists state by default is configured not to, or is
  not used.
- Loss is intentional, not accidental: leaving a non-empty chat asks for
  confirmation, and an expired proxy session is renewed without
  navigating the tab away (see principle 2).

**Authentication proxy**
- Ephemera's site turns off request and response buffering, keeps any
  unavoidable request-body spill on tmpfs, disables
  proxy caching, writes a content-free access log, disables the URL-bearing
  error log and allows long-lived streams for slow reasoning models.

**Container**
- Chat requests stream upstream and are forgotten when the response ends:
  no database rows, files, temp files (tmpfs included), caches or queues
  hold content. The server aborts the upstream call when the client
  disconnects and bounds every request's lifetime.
- The persistence layer accepts only character, persona, preset, lorebook,
  event, memory, cast sheet and settings schemas, so chat objects have no
  path to the writable data mount. An event is its definition; which event
  fired where never reaches it. A memory is the model's validated answer;
  the span it was written from never reaches it. A cast sheet is character
  data read from the card alone: the people it names and their fixed
  details, never a chat's state.
- Each user's database lives in server memory and reaches the disk only as
  one encrypted file, and each portrait's image as one more encrypted file
  beside it; plaintext database or image bytes are never written (no temp
  file, journal or WAL).
- Logs carry operational fields only: route, status, duration, model id.
  They never carry a username.
  Error objects can carry the prompt (the AI SDK's do), so code logs error
  class and status only and overrides library error handlers that print raw
  errors.
- Read-only root filesystem, RAM-backed `/tmp`, no swap and logging driver
  `none` narrow where a bug could write. They are defence in depth, not a
  write barrier: the data mount stays writable.

**Upstream**
- Deployment prerequisite: no request, debug or error-body logging and no
  error dumps, verified with a canary (`docs/ARCHITECTURE.md` § Deployment
  checks) after every upstream upgrade or restart. On CLIProxyAPI that means
  `server.commercial-mode: true` with request logging, debug logging and
  error dumps off. CLIProxyAPI's documentation notes that commercial
  mode is not a process-wide guarantee that error text is content-free; that
  residual risk is stated, not hidden.

**ComfyUI**
- Ephemera runs on a plain ComfyUI or on Atelier's private worker, an
  optional hardened ComfyUI backend with a private worker protocol that
  Ephemera supports. The rules below hold for both.
- It receives the image prompt for a card's portraits or for a scene picture
  (written from the card and the chat's latest turns) and, on Atelier's
  private worker only, the top third of a Subject or Group character's
  stored portrait as an in-memory job input for the workflow's reference
  graph, removed with the job's lease. A plain ComfyUI never receives the
  portrait, because its upload route writes to disk; it runs the text graph
  instead. A Scenario card sends no portrait. Images return over the
  WebSocket in plain native mode. A protocol-2 private worker's opted-in memory
  sink holds the ordered PNGs under the request's lease so its authenticated,
  lease-scoped status and output endpoints can recover a broken socket.
  Releasing the lease removes these outputs with the inputs. No image node
  writes to disk: a graph using a node class outside Ephemera's allowlist of
  in-memory classes stops the start. Private mode requires job status, memory image outputs,
  preview control, lease renewal and admission, plus the worker's build,
  allowlist and limits metadata. Missing capabilities fail closed;
  only a missing private handshake selects native mode. Ephemera opts out of
  private-worker previews. A busy admission wait, at most 300 seconds, and
  a wait for a worker that is starting, at most 60 seconds, both stay within
  the original request deadline and do not extend rendering or retention
  lifetimes. The worker's waiting-list place is a bare integer header, never
  content.
- Deployment prerequisite: no prompt-bearing logs, no disk output and no
  retained history. Atelier's private worker meets this: releasing
  a job's lease removes or interrupts the job, and the worker's reaper removes
  its history and lease assets. Terminal and unsubmitted leases expire;
  active work is released after 120 seconds without a successful scoped status
  observation. Released work still running 60 seconds later, or work reaching
  its immutable admitted execution budget, restarts the worker. Ephemera retries
  failed releases rather than waiting for these bounds. The last run's tensors
  and prompt references stay in that worker's memory until it recycles itself after 180 idle
  minutes; continued activity postpones that. Active cancellation requires
  release intent to reach the worker; a failed or lost response cannot
  prove it did.
- A plain ComfyUI does not meet it, so after every run Ephemera removes its
  prompt from the queue and deletes its history entry, then asks the
  instance through `/free` to drop its executor cache, which still holds the
  run's outputs and prompt text. That cache is instance-wide: the call clears
  other clients' cached results too and unloads the models. Ephemera
  requires native atomic cancellation at `/api/jobs/<id>/cancel` and cancels
  only its own job. Validated normal completion gets a bounded wait for
  native retirement, preferring its own history entry as evidence. An unreadable
  queue cannot suppress history deletion or cache release after that bound;
  bounded follow-up catches late history insertion for success, failure and
  abort alike. Scoped history deletion may repeat, but a successful global
  cache release repeats only when later retirement proves another is needed.
  A failed release is retried. On abort or failure,
  cleanup and its follow-up repeat safe cancellation at one-second polls while that id remains
  pending or running; HTTP 200 alone does not prove it stopped.
  It never falls back to `/interrupt`.
  A failed history delete or cache release is tried again. A prompt still
  stopping when cleanup's poll gives up is followed for up to five minutes;
  a submit without an answer, which ComfyUI may still admit, and a queue
  that could not be read are followed for a minute, and the prompt is
  removed wherever it appears. An orderly stop of Ephemera ends its runs and
  waits up to eight seconds for this cleanup.
- Residual risks: if Ephemera is killed mid-job rather than stopped, or a
  cleanup stays unresolved after its retries and follow-up (which is logged,
  by reason only), the prompt text stays in that instance until it restarts
  or its history limit drops it. They are stated, not hidden.

**Diagnostics.** Disk-backed logging (the container's `local` driver,
the upstream's request logs) is enabled only to reproduce a fault with
synthetic content while no real chat runs, and is switched off afterwards.

**Evidence, not proof.** Retention tests are regression evidence across a
matrix: every controlled hop (browser storage and profile directory, the
proxy's temp and log paths, container filesystem and data mount, the
upstream's logs)
times every content class (input, draft, output, reasoning,
inspector result, local/global macro variables, lorebook activation, lorebook
timed effects, event state, swipes, edits, continuations, impersonated
drafts, creation drafts with their candidate portraits, rework drafts, the
span a memory is written from, scene pictures and their prompts, the cast
register and its corrections), including
failure paths: oversized chats, upstream
errors, ComfyUI errors, cancellation mid-stream, Stop and Clear mid-paint,
Clear during streaming or during a keeper call, back/forward
navigation, reload, session expiry mid-send, a server restart mid-stream and
malformed requests. A hop that could not be inspected is reported as unverified,
never as clean.

**Outside our boundary.** Stated honestly instead of claimed:
- model providers behind the upstream apply their own retention,
  including prompt caches keyed by the chat's affinity id, which Ephemera
  sends so a chat stays on one replica;
- the host OS outside Docker's VM may page memory;
- browser internals (tab thumbnails, session restore, crash reports) and
  cloud features the user enabled (enhanced spellcheck, translation);
- browser extensions and screenshots.

## 2. Private, per user

- No telemetry, analytics, error-reporting services or third-party requests.
  Fonts, icons and assets are bundled.
- Content Security Policy: same-origin scripts only with no inline script,
  `connect-src 'self'`, local images only, `object-src 'none'`,
  `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`.
  Inline styles generated by UI libraries are the only permitted relaxation,
  chosen explicitly; `script-src` is never widened.
- Only the users the trusted authentication proxy's access rule for
  Ephemera admits get in, each to their own data alone. The proxy clears
  inbound identity headers and injects
  `Remote-User` and an application-specific proxy key; the API rejects any
  request whose key does not match or whose `Remote-User` is not a valid
  username, and creates nothing for it. The container's published port is
  loopback-only. A second trusted caller, Atelier's server, presents its
  own key, which opens one route: creating a character from an image. It
  still names a valid username and the exact Origin, and the card lands in
  that user's own instance. Atelier forwards only its proxy-verified
  user and sends only for users its `EPHEMERA_USERS` allows, so the
  `Remote-User` the integration key carries is a verified identity.
- Each user's characters, personas, presets, lorebooks, events, memories,
  portraits and settings live in a separate instance and folder, encrypted at rest under a key
  derived for that user. No route, cache or server memory lets one user read, list, change or infer
  another's data.
- A tab is bound to the user it loaded as. A request bound to a user other
  than the one `Remote-User` names, or a write through the proxy bound to none, is
  refused before it reaches any data, so
  after a re-login as someone else the tab never shows or writes the
  previous user's data; it hides itself and reloads.
- The proxy's session cookie may be shared with sibling apps on the domain, so unsafe
  requests require an exact `Origin` match and a JSON content type
  (multipart only for card and lorebook imports, portrait uploads and
  Atelier's image cards). No CORS.
- When the proxy session expires, the proxy answers every request with a
  redirect to the portal, which the app recognizes (it never follows
  redirects, and its own API never answers 401 or 3xx). The tab never
  navigates: the app opens the sign-in in a separate window, which returns
  to a same-origin page that tells the tab and closes, and the tab then
  retries what failed once, keeping the chat intact.
- The upstream API key lives only on the server.
- The server calls two upstreams the owner configured, the
  OpenAI-compatible upstream and ComfyUI, and nothing else. The ComfyUI address comes only from settings,
  never from card or model text, and must be one of the origins the owner
  allows on the server; its token and certificate live only on the server,
  the token goes to an allowed origin only, and redirects are never
  followed. The browser's policy does not change: candidate portraits are
  drawn from memory, not loaded from a URL.

## 3. Untrusted content stays inert

Character cards come from the internet and models echo them. Every card
field, lorebook entry and model reply is untrusted text.

- Markdown renders with raw HTML off. Images and links from cards and
  replies are inert: images are not loaded, links show their destination as
  text and are not followed. Renderer defaults that allow more (Streamdown
  allows all link and image prefixes) are tightened explicitly and tested.
- Imports are validated against the card schemas with size limits. Known
  fields become typed native data; unknown extensions and transport metadata
  are discarded. Conversion happens at import or startup, never during generation.
- Avatars: PNG, JPEG or WebP only, decoded and re-encoded server-side with
  pixel and byte caps, metadata stripped, served with an explicit content
  type and `nosniff`. No SVG. Card data needed for export is stored
  separately from the image.
- URLs found inside cards are never fetched.

## 4. A premium, calm experience

- Typography and spacing carry the design; chrome stays quiet so the story
  is the focus.
- Two voices, told apart at a glance by place and surface, never by colour
  alone: the character's prose is set in a reading sans, open on the canvas
  across the story; the owner's lines are set in the interface sans on a
  quiet slip at the trailing edge, so an exchange reads as two people and
  not as a transcript.
- Every turn opens with its speaker's name, set in the voice that follows:
  the character's name in the reading sans and in ink, the loudest name in
  the story, with a hairline from it to the edge of the story that opens
  the reply; the owner's persona (or "You") in the interface sans, a quiet
  label over the slip. No badge, no accent. The name stays at the top of
  the story while its turn scrolls past, and assistive technology hears it
  once.
- The character is present: one portrait at the head of the latest reply,
  whose text wraps around it, so it moves down the story as the story grows
  (above the story on phones), not a thumbnail on every turn.
- A wide window is used, not framed in empty canvas: the story spans the
  chat column with padding, and once the column has room the portrait grows
  with it.
- Past full HD the whole interface scales up with the window, to a quarter
  larger at 4K; lines do not grow longer. A screen's header controls sit on
  the edges of the content they act on.
- The room may lean faintly toward the hue of the character's portrait,
  read from the image in the browser and kept in memory only: never saved,
  sent or logged. The lean changes hue and a little chroma, never
  lightness, so text contrast holds; a portrait of disagreeing hues leans
  it less, and a grey portrait, no portrait or no character leaves the
  palette as it is.
- Motion explains change: messages arriving, swipes sliding, panels opening.
  Short, spring-based, interruptible, and reduced to fades under
  `prefers-reduced-motion`.
- One ambient exception keeps the window from looking dead at rest: the
  mark at the top of the navigation breathes, its lamp's glow rising and
  settling in a slow, seamless loop. It is the only motion on screen at
  rest, and under `prefers-reduced-motion` it holds its resting glow.
  While a reply is in flight the lamp breathes faster and the character's
  portrait glows in step with it, and streamed words arrive with a short
  fade (a continued reply streams on without one, so its earlier words stay
  still); when the reply settles, both return to rest. Text in the focused
  composer lights the glow faintly, without movement. Under
  `prefers-reduced-motion` the lamp holds still, the glow shows still and
  words appear at once.
- Streaming is smooth: no layout jumps, stable scroll anchoring, no flicker
  while Markdown completes.
- Every action is reachable by keyboard; the layout works from phone to
  desktop; light and dark themes follow the system unless overridden, in
  any of six colour palettes, each with both schemes and the same
  contrast floors, or one of three the player makes, which warns below
  those floors and never refuses.

## 5. Efficient by default

- Roleplay quality comes before token savings. Optimize instructions, context
  and caching only when character fidelity, continuity and immersion hold up;
  noticeable quality loss rules an optimization out.
- Ship little JavaScript: route-level code splitting keeps the first
  paint small. The remaining chunks load right after it, while the session
  that served the page is fresh, so an expired session can never strand a
  screen (principle 2 outranks on-demand loading).
- Streaming must not re-render the whole thread: fine-grained store
  selectors and the React Compiler keep updates local.
- Prefer native platform features (View Transitions, `@starting-style`,
  popover, `field-sizing`) before adding a library for the same job.

## 6. Built from maintained parts

- Use a maintained library before writing our own; write code only for what
  makes this product different: prompt assembly, swipes, the retention model.
- One owner per rule: card parsing, prompt assembly, macros and lorebook
  activation live once in `packages/core`, used by server and UI.
- Validate at every boundary with Zod. Strict TypeScript, no `any`.
- Current stable releases only; check the installed version's documentation
  before using an API.
- Tests exercise behavior, starting with the retention matrix.
- Support importing SillyTavern Character Card V2/V3 PNG and JSON, including
  embedded lorebooks, plus World Info and Chat Completion preset imports.
  Convert recognized fields into Ephemera data and report changed or omitted
  settings. Exports use strict versioned native envelopes; prompt and sampler
  presets export independently. Foreign formats are inbound only.
  Optimize Ephemera for its own use without legacy limits. SillyTavern is
  AGPL-3.0: never copy its source.
