# Product

Ephemera is a self-hosted roleplay chat for the people its operator admits:
pick a character, pick who you are, and talk to an AI model through a
polished web interface, with character cards, personas, prompt presets,
swipes and lorebooks. Characters and settings
are kept; conversations never are.

## Access

Its users reach it at a hostname behind a trusted authentication proxy
(for example SWAG with Authelia). Every user the proxy's access rule admits
gets a separate instance, created on their first visit: their own
characters, personas, presets, lorebooks, events, memories, portraits and settings, which no other user can see,
list or change. There are no local accounts, sign-up, user administration or
sharing: the proxy's identity is the only identity. When the sign-in
expires, the open tab stays where it is: a notice offers Sign in in a new
window, and once the user is back the tab carries on by itself, sending
the message that was waiting and saving edits made meanwhile. If the tab
finds itself signed in as someone else, it drops everything it holds and
reloads as that user.

## What persists and what vanishes

| Kept on the server, per user and encrypted | Exists only in the open tab |
|---|---|
| Characters, their avatars and embedded lorebooks | Messages, swipes and edits |
| Personas | The composer draft |
| Prompt presets (their Author's Note included) and sampler presets | Assembled prompts and the prompt inspector view |
| Library lorebooks and the characters each is linked to | Model output, including reasoning |
| UI settings (theme and colour palette, up to three custom palettes, default model, image prompt model, last chosen character and persona, defaults) | |
| Events: each instruction, its chance, its cooldown, its scope and whether it is on | The lorebook's timed effects (which entries stay in or rest) |
| | Which event fired on which reply, and the event text as filled for a request |
| Memory, on for every character until the owner turns it off: its notebook and its memories (title, summary, cues) | The turns a memory was written from, which of them are folded, and which memories this chat carries |
| Cast sheets: the people each character's card names and their fixed details, read from the card | The cast register: who is in the story and how they stand, by reply, with the owner's corrections and removals |
| | Local and global macro variables, both scoped to this tab's chat |
| | An AI-written card before Keep: its description, the card, a direction for new art, the image prompt and the candidate portraits |
| | An AI rework before Apply: the request, the proposed changes and the review |
| | New art for a saved character before Use as portrait: the direction, the image prompt and the candidate portraits |
| | Scene pictures and the source and image prompts written for them |

A refresh, closing the tab or pressing **Clear** removes everything in the
right column from the app, and Ephemera keeps no copy it could restore.
After a reload the app comes back with the same theme, palette, model, character
and persona, and an empty chat.
Leaving a non-empty chat, or a card that has not been kept, asks for
confirmation first, so loss is always intended. What lies outside Ephemera's control (model providers, browser and
OS internals) is named in `PRINCIPLES.md`.

## Saved data and native files

Character, lorebook, prompt-preset and sampler-preset files use the formats
`ephemera.character`, `ephemera.lorebook`, `ephemera.prompt-preset` and
`ephemera.sampler-preset`, respectively. Unsupported versions, wrong kinds and
mixed native/foreign envelopes are refused. A malformed native PNG packet never
falls through to foreign chunks.

Startup upgrades older saved data transactionally to native version 1, preserving
ids, relationships, portraits, notes and timestamps. Changed revisions fence old
tabs. Each changed encrypted database is durably replaced before serving; a
conversion or write failure refuses startup. Already upgraded files are safe to
open again. Wider legacy text remains readable and reducible, while new writes,
imports and exports keep public bounds. A blank event left after removing old
no-op instructions remains disabled as "No instructions", editable and deletable;
it cannot be enabled until valid instructions are supplied.

## Features

Version 1.0 holds everything below.

**Characters**
- Import SillyTavern Character Card V2 and V3 from PNG (`ccv3` preferred over
  `chara`) and JSON, including embedded lorebooks. Recognized fields become
  native typed data; unknown extensions and transport metadata are discarded.
  Imports report what was kept, changed and left out.
  Lorebook keywords, entry names and tags past Ephemera's limits are left
  out or shortened rather than refusing the card, and the import says so.
- Create, edit, duplicate and delete characters. Fields are native:
  name, description, personality, scenario, first message, alternate
  greetings, example dialogue, system prompt and post-history overrides,
  creator notes, tags, and the Character's Note (text sent in every chat
  at its depth and role, saved in the card).
- Export and re-import native Ephemera character PNG or JSON files. Both
  carry a strict `{ format, version: 1, data }` envelope; PNG uses only an
  `ephemera` text chunk. The embedded lorebook travels with the card; linked
  books, memories and cast sheets stay in the instance.
- Duplicating a character keeps its links to library lorebooks.
- Gallery with search and tag filtering. Tags ignore case everywhere:
  "Noir" and "noir" are one tag, on a card, in the gallery and in event
  scopes.

**Create with AI**
- From the gallery, a model the owner picks (the saved one by default),
  at a reasoning effort they pick from the levels it offers (its own
  default unless chosen), writes a new card from a description in the owner's words, for the
  current persona (also chosen there), so a description that mentions
  `{{user}}` gets a card consistent with who the owner plays. Three kinds:
  - Subject: one person. The card's description holds one block named
    after them (`<mara_voss>`), with their background, appearance,
    personality and way of speaking
    (`<backgroundstory>`, `<appearance>`, `<personality>`, `<vocabulary>`),
    within about 5,500 tokens. Each block holds only what shapes how
    they act, talk and react, in as few words as that takes: people in
    their life outside the card are short unnamed lines unless the owner
    names them, and no secrets, goals or conflicts are invented that the
    owner did not ask for.
  - Multiple Subjects: two or three people, one such block each.
  - A Subject or Multiple Subjects description holds the people alone,
    never a current place, time or scene: only the opening sets where
    and when play begins, so the place can change while the people stay
    the same.
  - Scenario: a bare, open-ended frame to step into, in four blocks:
    `<Roleplay>` (the premise, `{{user}}`'s role and at most three broad
    pressures), `<Setting>` (the world's outline, or only what departs
    from a franchise's canon), `<People>` (who lives there in general
    terms, their looks first) and `<Tone>`, within about 10,000 tokens.
    It holds no fixed characters: no named or individual people,
    profiles, cast or role list, since the narrator invents every
    person, place and event as play needs them, and its pressures belong
    to factions and institutions. A franchise the owner names is used by
    name, the canon figures the premise needs and any real person named
    only as one line each in `<Setting>`.
  - A Subject card's text calls its person `{{char}}`, so the card's name
    fills it in; Multiple Subjects name each person, and a Scenario
    names no one.
  - The text the model reads is terse notation, the most detail in the
    fewest tokens: fragments and `label: value` lines, no filler, word
    limits as ceilings. Only the opening, the pitch, quoted speech and the
    `<Tone>` sample are full sentences.
- The card fills in as the model writes, and Stop ends it. A finished card
  also has an opening (a `> Location:` line, an empty line and one
  sentence, set in that shape even when the model strays): on a Subject
  or Multiple Subjects card the sentence places the subjects in the scene,
  where they are and how they are, as in "{{char}} is seen tanning on a
  plush sun lounger, unassuming and relaxed"; on a Scenario card it gives
  one sensory detail. It also has a
  one-line pitch shown as its tagline; no alternative openings and an
  empty scenario field. The model writes no tags: the card carries one,
  Subject, Multiple Subjects or Scenario, after its kind. A block over its token cap
  is reported, never cut.
- While the model thinks before writing, the screen says so, and nothing
  of its reasoning is shown. A finished card that lacks parts is written
  once more at once, and the screen says the first draft is being written
  again. When a card still ends incomplete, the screen names what is
  wrong: sections missing or unfinished, or blocks out of shape. A
  card cut off at the model's output ceiling, one the provider's filter
  stopped and a description too long for the model's context window each
  say so, with what to try instead.
- With a ComfyUI address in Settings, the model writes an image prompt from
  the card (the image prompt model from Settings, when one is set), worded for the image model family of the workflow
  chosen beside the model (Krea 2, MOSS Image, or General for any other), and ComfyUI paints a batch of four portraits
  (2:3, 1024 x 1536) with it; every workflow the server has (the built-in
  ones and any its workflows directory adds) is offered, and the
  choice is kept for the next card. The showcase offers it again under New
  art, with the model that writes the image prompt and
  its reasoning effort (the card's until others are chosen, kept for the
  session; the Settings image prompt model, when set, in place of the
  card's model), so the art changes without writing the card again. A short
  direction typed under the four portraits, such as a place, light or
  outfit, steers the next image prompt: the model follows it before the
  card's notes, while the prompt keeps its framing, order, length and
  rules; Enter paints with it, and it stays until the card is dropped. A Subject's
  portrait defaults to one person in a single frame. Its Composition choice,
  before creation and under New art, also offers a Diptych of two tall panels:
  one moment and one pose, the person from the front on the left and from
  directly behind on the right.
  Composition survives Rewrite, Discard or back to Describe, and visits to
  Settings in the same tab; clearing the session or choosing another kind
  resets it to regular.
  Every portrait is an amateur capture in the place's own available light,
  never flash or a staged shoot. Its Look, for Subject and Multiple
  Subjects before creation and under New art, is Auto by default: the
  model fits the capture to the card, an amateur snapshot unless the card
  calls for another, a mirror selfie for someone whose life is posting
  themself, black and white film for any era before the 1950s, 35mm colour
  film for the 1950s to the 1990s, or an early compact digital camera for
  the 2000s. Choosing one outright names the capture only; the card keeps
  its own era. Look survives Rewrite, Discard, back to Describe and a
  change between Subject and Multiple Subjects; clearing the session or
  choosing Scenario resets it to Auto.
  Every woman on a cover, a Scenario's unnamed women included, poses by
  her dominant personality trait that a picture can show: the image prompt
  names her pose and where she is in the place in words. A scene picture
  does the same wherever the chat leaves the pose open. Multiple Subjects get one group
  portrait, and a Scenario a movie poster: unnamed women of its world,
  three unless the owner's art direction asks for another number, where
  its story begins, under the card's title in poster lettering, a
  film still of the story's era, in black and white before the 1950s. The showcase presents the card with its
  art: pick one of the four, ask for new art, rewrite the card or discard
  it. While art develops, the screen names the stage (checking ComfyUI,
  writing the image prompt, the queue, sampling with its step count,
  receiving the four), says who it waits for after a silence, and Stop
  ends it; new art that fails or is stopped keeps the portraits on show,
  and a failure says why. Without an address, or when the art fails, the
  card can be kept without a portrait. Settings shows whether ComfyUI answers and names any
  node or model the chosen workflow lacks.
- Keep saves an ordinary character with the chosen portrait, ready to chat
  with or edit in its sheet. If only the portrait fails to save, the card is
  kept and the portrait can be tried again.
- Nothing is kept before Keep, and only the card and the one chosen
  portrait after it. The description, the card, a direction for new art,
  the image prompt and the four portraits live in the open tab, and in the server for one request.
  The description survives Discard and a visit to Settings; a reload,
  closing the tab or Keep clears it.
- From [Atelier](https://github.com/SneakyShadyLurker/atelier-studio), an optional image generation service Ephemera supports, a
  generated image can be turned into a Subject, Multiple
  Subjects or Scenario card in one click (Subject unless Atelier asks for
  another), tagged with its kind: the image is the description, its prompt
  the notes, an optional direction from the owner steers who the characters
  are, the saved
  model writes it at its default effort, and the card is kept on arrival
  with the image as its portrait.

**AI Rework**
- From a saved character's sheet, **AI Rework** in the header (an icon on
  phones) opens a composer: a popover on tablet and desktop, a bottom
  drawer on phones. The owner writes what should change, picks a model
  (the saved one by default), its reasoning effort and the persona `{{user}}`
  is. Reasoning offers the model's supported levels and starts at Model
  default; an unsupported choice falls back to that default. The choice
  stays in tab memory until leaving the sheet, a reload or `pagehide`.
- The model receives the card's fields as the sheet shows them (name,
  description, personality, scenario, first message, alternate greetings,
  example dialogue, system prompt and post-history overrides, creator
  notes, tags and the Character's Note), the embedded lorebook, the
  persona and, under "Include portrait", the stored portrait. The switch is
  on for a model whose catalog entry says it reads images, off and disabled
  for one that reads text only, and off but available when the catalog does
  not say. A model with no known context window, or a card too large for
  it, is refused before the model is called, and the composer reopens
  saying why.
- Whatever the request, the model also goes through the whole card: it
  fixes inconsistencies, deepens flat or generic characters into
  believable people without adding secrets, goals or named people the
  card lacks, adds what the card's layout lacks and moves misplaced
  material. On a subject card, a side character named only in the
  description or personality field, and not by the request, becomes a
  short unnamed line; what the card already establishes stays. A scenario card ends up with no fixed characters: each named
  one becomes the faction or kind of people they stand for, in general
  terms, their name, profile and personal hooks dropped, a lorebook entry
  about them rewritten about that group, and a franchise's canon figures
  stay as one line each. A scenario card is also trimmed to its frame:
  location tours, daily life, role lists, plot hooks, narrator
  instructions and style samples leave its description. Wordy prose in the fields the model reads is rewritten into
  the creator's terse notation, every fact kept but a scenario card's trim. A card whose description is not in the creator's subject or
  scenario layout is converted to it, the description replaced whole and
  every fact kept but a scenario card's trim; the personality
  field, and a scenario card's scenario field, are then emptied, and that
  emptying is accepted or rejected with the conversion. The first message
  takes the creator's opening shape for its layout, what a longer one set
  up moving to the scenario but for where the subjects are and how, and
  alternate greetings keep their form. On a subject
  card the place and time play begins in stay in the opening alone: the
  description loses any it holds, and so does the scenario field unless
  they are all it holds. A single subject
  is called `{{char}}` in the card's text, everyone else by name. Speech
  it writes sounds like the character talking, not prose.
- The model answers with changes, each naming its field, the
  passage it replaces and a reason. They appear inline as tracked changes
  while the model writes, in each field's place: struck and inserted words
  (a removal stays struck in view, however long),
  long unchanged stretches folded behind "Show N unchanged words", a large
  rewrite as one inserted passage with "Show original", and each change's
  reason with Accept and Reject at the end of its sentence. Lorebook
  entries the changes touch, add or remove show above the lorebook's
  summary; a new entry is accepted or rejected whole. A bar under the sheet
  counts the changes, steps through them with Previous and Next, lists the
  ones that could not be matched (never applied) and offers Discard and
  Apply. Stop keeps what arrived for review.
- While the model works and under review the fields are read-only, and
  Chat, Duplicate, Delete, the portrait picker, New art, Open lorebook, the linked
  lorebooks' links and Add alternate wait; Export stays available. Every change starts accepted, except an
  emptying that arrives after its conversion was rejected.
- Apply writes only the accepted changes through the sheet's normal save.
  Undo stays on offer until Done, another rework or leaving the sheet; it
  restores the fields Apply wrote, except any the owner typed in since,
  which it names; when one of them is a field a conversion emptied, the
  converted description stays as applied too, since it holds that text.
- Nothing of a rework is kept before Apply, and after it only the accepted
  changes as part of the character. The request, the answer, the changes
  and the review live in the open tab, and in the server for one request.
  The request survives Discard and closing the composer while the sheet is
  shown; Apply, leaving the sheet, a reload or closing the tab clears it.

**New art for a saved character**
- A saved character's sheet offers **New art** under its portrait. It opens
  a studio, a dialog on tablet and desktop and a drawer on phones, that
  paints four portraits as Create with AI does, from the card as the sheet
  shows it. Nothing paints until New art is pressed. Without a ComfyUI
  address the studio says portraits are off and links to Settings.
- Kind sets the framing: a Subject portrait, a Group photo or a Scenario
  still, preset from the card's Subject, Multiple Subjects or Scenario tag
  and Subject without one. Subject offers Regular (one frame, the default)
  or Diptych (front and rear) in a session-only Composition choice. Subject
  and Group photo offer the same Look as Create with AI, session-only and
  reset by Scenario still.
  A card in the format Create with AI writes gives
  the same art source as there. Any other card gives its description, the
  bounded personality, the first sentences of its scenario, and its opening's
  Location line, or the opening's first sentences when it has none.
- With a stored portrait, **Match current portrait** shows it to the model
  that writes the image prompt, which takes the people's looks from it and
  the rest from the card. The switch follows the model as "Include
  portrait" does in AI Rework. The prompt model starts as the image prompt
  model from Settings, else the saved one; it, its effort, the workflow
  and a direction work as under New art in Create with AI.
- Once four are on show, **Use as portrait** replaces the stored portrait
  with the chosen one through the portrait upload; the studio closes and
  the sheet shows it. A failed upload stays in the studio with Retry save.
  Close stops a paint in flight and keeps the four until the sheet is left.
- Nothing is kept before Use as portrait, and after it only the chosen
  portrait. The direction, the image prompt and the four live in the open
  tab, and in the server for one request; leaving the sheet, a reload or
  closing the tab clears them.

**Personas**
- Name, avatar and description. One default persona; optionally bind a
  persona to a character. Avatars go through the same pipeline as character
  portraits.

**Lorebooks**
- A library of lorebooks beside the ones embedded in cards: create,
  rename, edit, duplicate (the copy is linked to no character) and delete.
  The Lorebooks screen lists the library by name, each book with its
  entries, how many are on, how its enabled entries go in and the
  characters it is linked to, then the books in character cards, which
  open in their card's editor and can be copied to the library as books of
  their own. One Find covers book and character names.
- Link a book to any number of characters, up to 8 books per character.
  A character's chats read its embedded book and its linked books together,
  in link order; deleting a book or a character removes its links. Links
  are made from either side: a book's editor says how many characters it
  is linked to, since an edit reaches all of them, and manages them; a
  character's sheet lists its linked books beside the one in its card,
  links one from the library or a new one, and unlinks one, which keeps
  the book in the library.
- An entry goes in one of three ways, each with its own mark wherever the
  entry shows: always, on its keywords, or by chance with a percentage.
- Import SillyTavern World Info files or standalone card lorebooks and
  convert them to native data. Export and re-import Ephemera lorebook JSON.
  Reports say what was kept, changed and left out.

**Events**
- One-line instructions the story is given now and then, by chance, kept
  per user in one Events row at the top of the Lorebooks screen, above the
  library. The row arrives closed and says how many events there are and
  how many are on; opened, it lists them. Each event has its instruction
  (up to 500 characters, one line, macros filled as in the Author's Note),
  a chance per reply (0 to 100%, one decimal), a cooldown in replies (0 to
  1,000), an on/off switch and a scope: all characters, or chosen
  characters and cards carrying any chosen tag. A user keeps up to 200
  events, newest first, and one event names up to 100 characters.
- Each new reply for a character rolls the chance of every event that is
  on, in scope and not cooling down. Of the events that hit, exactly one,
  drawn at random, goes into that request as a system direction after the
  latest turn: "[Direction for your next reply: ... Work it into the scene
  naturally and do not mention this note.]". A cooldown of N keeps the
  event out of the N replies after the one it fired on. A swipe or a
  regenerate rolls again; Continue, Write for me and the inspector's
  preview never roll, and a chat without a character has no events.
- The chat shows nothing of an event; the prompt inspector shows the one a
  request carried as "Event".
- The definitions are saved like characters; which event fired on which
  reply is chat content, kept only in the open tab and forgotten with the
  chat.
- Events are separate from lorebook event pools, which select among entries.

**Memory**
- A character remembers its story across chats. Memory is on for every
  character, new or old, until the owner turns it off in the character's
  sheet or on its memory screen; the sheet's Memory section holds the
  switch, how much is remembered and Open memory. Turning it off keeps
  what was remembered and stops writing and reading it. Forget everything
  deletes the memories and empties the notebook and the next chat's
  opening, leaves memory on or off as it was, and the open chat with the character shows every folded turn
  again. Changing persona continues the same character's story under the
  new player name. Duplicating the character gives it independent memory.
- What a character remembers has two layers. The notebook says where the
  story stands: a situation in a few sentences (with the in-story time
  when the story gives it), where each pair of people stands with each
  other and what made it so, one line per pair, durable facts and open
  threads, and Cast lines for recurring invented NPCs. Each Cast line is
  an editable JSON object with a name, gender and optional fixed anchor
  fields, at most 32 lines of 1,200 characters each. It holds no ids or
  scene state. The model is instructed to omit the player and card subjects;
  owner lines stay editable, the player is excluded when seeding, and card
  anchors win on overlap. Invalid owner
  lines stay editable but cannot seed a chat. Model additions and changes
  must validate; an invalid model cast edit is discarded while valid notebook
  edits and the summary remain. Memories are the story scene by scene, each a title, a summary
  in prose of what happened, opening with the in-story time when the
  story gives it, and a few cues (places, objects, people, named
  events). Beside the notebook, each memory call also writes the opening
  of the next chat, set on the next day: a Location line with the place
  and that day's time, then one sentence in the present tense that
  places the people the day finds together, by name, seen from outside,
  where the way the span ended plausibly leaves them, with no dialogue,
  no plot and nothing for `{{user}}`, so each chat starts a fresh scene
  that follows from the last. The
  memory model's instructions fit any card: one character,
  several, or a whole scenario and its cast. Neither layer repeats what
  the card, the persona and the lorebooks already say, and a summary
  does not restate what the notebook already holds, while what the span
  established is told in it as events: a memory records only what the
  story added or changed.
- Memory calls the persona `{{user}}`, never by name, so the notebook and
  every memory hold whichever persona plays the next chat. The memory
  model reads the story as it is, is told the persona's name and to write
  `{{user}}` for them, and any whole-word mention left in its answer of
  the name, or of its first word when that is not a title or an initial,
  becomes `{{user}}`, unless the character's name holds it or another
  capitalised word follows, as in someone else's full name. The
  chat prompt fills in the name of the persona in play before memories
  are recalled or measured, and nothing else in memory is filled.
- Once the unremembered part of a chat passes a size, after a reply, one
  model call writes a memory of the older turns and revises the notebook:
  it rewrites the situation and names only the lines it changes, drops or
  adds, every other line kept word for word. In a small context window it
  is told how much room the notebook has. The newest turns stay out of
  it, so the scene in play is sent as it is. Remembered turns stay in what the model reads until the history
  no longer fits; then the oldest memories replace their turns, oldest
  first, and go in before the history with the notebook, so a memory
  stands in only for what no longer fits. The memories still waiting are
  never recalled. Up to four older memories whose cues match the latest
  turns are recalled into the chat near its end, and every memory marked
  Always in the prompt is as well, in story order. The notebook always
  goes in; this chat's memories and the recalled ones go in while all of
  it fits 12% of the context in use, a memory too large for what is left
  skipped for smaller ones.
  Once this chat's memories pass the recap budget, the oldest half merges
  into one chapter; once the story before the chat passes it, its oldest
  half merges the same way, so a story told across many chats keeps
  fitting, its oldest part ever more condensed. A memory and a chapter
  that holds it are never recalled together. Once the episode and notebook are
  written, a failed chapter step leaves that success intact. Repeating the same
  kept attempt returns it without writing another episode, while it still exists.
- A new chat reads as the next scene of the same story. The character's
  memories from before it go in as what came before this chat, in story
  order, the newest that fit, for the whole chat. Until it remembers
  anything of its own, the model is told that the chat is a new scene set
  some time later, the notebook's situation being where the last scene
  ended, not where this one begins, and that everyone keeps what they
  remember and where they stand with each other, so an opening that
  reads as a first meeting of people who know each other is a reunion.
  Those that go in are not recalled as well; those left out for room may
  be. Once the chat has memories of its own, they go in after the story
  before it and keep their room first.
- With the Settings switch on and memory on for the character, a new chat
  opens on the memory's opening, `{{user}}` filled for the persona in
  play, and the card's first message and alternate greetings follow as
  the next swipes. While that opening is the greeting in play, the model
  is told instead that the chat opens on the day after the last scene
  ended, its opening being that day as the ending left it, and the story
  goes on from it. An empty opening leaves the card's greetings alone.
- Clear, and starting a chat with someone else, remember how the chat
  ended: while memory is on for its character and a turn or more is
  unremembered, the dialog's action is Remember and clear (Remember and
  start new), which writes one last memory of every unremembered turn,
  the newest included, after a reply still being written has finished and
  a memory being written has landed. The dialog stays open while it is
  written and says so; a failure says why and offers Try again. Clear without remembering (Start new without
  remembering) and Keep chatting stay. The chat itself is still never
  kept; its ending becomes a memory.
- In the chat, a seam marks where the remembered turns end: the latest
  memory's title on a hairline, how many turns are folded and how many
  are still sent. Remembered turns still sent stay in the thread,
  read-only; Show the folded turns brings the folded ones back, dimmed
  and read-only. Edit opens the latest memory; Forget deletes it and frees
  its turns, which return to the story when they were folded. The
  inspector says when a prompt folded memories, and a preview when it
  would. While a memory is written the seam says so; a failure keeps the
  turns live and offers Try again. A mark beside the context meter says
  memory is on, with the count of remembered turns, and opens the memory
  screen, whose Back then returns to
  the chat; it shows once the character's memory has loaded, and no
  memory is sent or written before.
- The memory screen, beside the sheet, has the same switch, edits the
  notebook in place (memory turned off in another tab leaves the notebook
  there until its edits are saved), the next chat's opening under the
  situation as "Next chat opens with" (Regenerate beside it writes a new
  opening from the notebook and the newest memories, with memory's model,
  into the field, where it is saved like an edit, and Undo restores the
  last one), and
  lists the memories newest first, a chapter folding the ones it gathers;
  each opens to edit its title, summary, cues and Always in the prompt, or
  to delete it. Remember now writes a memory of the open chat with this
  character whatever its size.
- Settings has a Memory section: Open new chats where the story left
  off, on by default (off, the card's greeting opens every chat), the
  model memory calls use (the reply's
  by default) and its effort (one the model does not offer goes as its
  default), the size that starts a memory, how many
  recent turns stay out, and the recap budget: Automatic by default, the
  room memory has in the memory model's context window, or a number that
  caps it.
- Settings has a Cast section: the model the keeper and the cast sheet
  use (memory's by default) and its effort (memory's by default).
- The notebook, the next chat's opening and the memories are character
  data, kept per user and encrypted; Settings lists them under what is
  kept on this server. The opening never changes the card: its first
  message and alternate greetings stay the owner's own, in the sheet and
  in every export. The chat they came from, its turns and which of them a memory
  covered are never kept. The prompt inspector shows each memory message
  by its part.

**Cast**
- The chat keeps a cast register: one entry per person in the story but
  the persona, men and women alike, each with a fixed record (age,
  ethnicity, skin, face, sexual experience, relationship, height, weight,
  build, hair, eyes, intimate body, personality, fetishes and taboos) and
  a state that follows the scene (present or away, outfit, position,
  activity, mood, arousal, injuries, intoxication). The fixed anchor is the
  card or initial baseline. Evidence-backed developments can change current
  durable facts, and short voice, goals and knowledge cues carry continuity.
  Owner corrections take precedence over developments and the baseline.
  The keeper and sheet reader are instructed to leave unknown details empty,
  never invent missing anatomy, history or psychology. Development and continuity
  updates require a literal quote in a shown turn; matching that quote grounds
  an update but does not prove its meaning. After each reply or
  Continue that completes, a keeper call reads the turns since its last
  answer in chronological batches, covering the entire gap before publishing
  a snapshot, and answers with what changed. Completed batches stay private and
  retries resume at the first unfinished batch while their source and context
  remain unchanged. Appended replies queue behind the active work. Changes to
  the chat epoch, character, persona, model, effort, player name, sheet, notebook
  seeds or corrections, or replacing any source message object, invalidate that
  checkpoint. When helper context changes during active or queued work, the newest
  valid target restarts once under the current context. Corrections and a newly
  read sheet can still merge with an ordinary single-call answer. Editing history,
  switching branches or changing character or persona cancels work without
  automatically recomputing it. A context change with no active or queued work
  starts nothing and leaves any failure visible for Try again. It fills empty baseline fields
  without rewriting set ones; developments are held separately. A person who
  left the scene stays in the register as away. Each reply variant keeps its own
  snapshot: a swipe shows the cast as it stood after that variant, and
  editing or deleting history invalidates dependent snapshots, so catch-up
  starts from the last valid one. Deletion's Undo restores the snapshots.
- The narrator reads the register with every reply: the fixed records in
  the preset's Cast block, after the scenario in the default preset (a
  preset without the block gets them at the same place, and the preset
  editor can add it back), and who is present and how as a "Cast now"
  line just before the latest turn. The baseline stays in the stable block;
  current durable overrides and continuity join the dynamic state line.
  The default preset does not ask the model to write a present block.
- A new chat seeds recurring NPCs from the enabled memory notebook, after
  reading the card's cast sheet. Card anchors win over remembered lines.
  Remembered people get fresh chat ids, minor roles and empty, absent state
  until the story places them. The register admits at most 40 people and
  never evicts a known entry to make room. Editing Cast lines, turning memory
  off or Forget everything replaces the notebook overlay; people already
  established in this chat remain. Overlay changes preserve narration and scene
  painting already in progress. The narrator reads remembered anchors
  through this corrected register alone, while memory and opening calls
  read the full notebook. A memory call may also read effective cast context
  from a snapshot at or before its span ends. That input has no scene ids or
  volatile state and is never copied directly into persistence; only the
  validated memory answer can become character data.
- Each character has a cast sheet: the people its card describes (a
  Subject card's subject, a Group card's subjects; a Scenario has none,
  since its people are invented in play, unless an older card still
  describes some in full),
  read from the card alone by the cast model when a chat with it first
  starts, and read again at the next chat once the card changes. Every chat with the character
  starts with them in the cast. The sheet is character data, kept per
  user and encrypted, never part of an export, and deleted with its
  character; the character sheet's Cast section lists its people by name
  and age, with Read the cast now, or Regenerate the cast.
- The cast panel lists the women in the register: under the portrait, up
  to five present, each with what she is doing and how she feels where
  the column has room, then the rest and those away behind disclosures;
  across the phone's band, their names and ages over at most two lines,
  then how many more. Men and others are kept for the narrator but not listed,
  and with no woman in the register the panel stays hidden. A name opens
  her record, beside the roster from tablet up and as a drawer on phones;
  the newest message's menu, and on phones a control in the header, open
  the whole roster. The record reads as prose: her looks, her intimate
  body, her personality, experience, fetishes and taboos, then her state,
  or where she was last seen. Edit record shows every field; Save keeps
  the changes as the owner's corrections for this chat, a fixed field for
  the whole chat and a state field until the keeper next answers. Revert
  takes a corrected field back to what was recorded. Remove from cast
  leaves her out of the chat's cast, for the narrator and the keeper too,
  and the roster says she was removed, with Undo, until the cast next
  updates or the panel is used. While the keeper works, a hairline under
  "Cast" breathes; a failure says so, with Try again, and the fields the
  newest update changed wash briefly.
- The register, its snapshots and the corrections are chat content:
  Clear, a reload or leaving the page drops them with the chat.

**Presets**
- Prompt presets: main prompt, post-history instructions, order and
  on/off state of each prompt block, role, in-chat depth and insertion order,
  generation-type triggers and card-override locks, and up to 128 custom blocks.
  Every source block, including examples, lorebooks and cast anchors, accepts
  an optional template with `{{content}}` where its text goes. Empty means
  bare text; a nonempty template without that placeholder cannot be saved.
  Empty sources send nothing. Continue and Write for me have separate action
  instructions; empty action text sends no extra instruction.
- The prompt preset sheet keeps a formatting key: each mark the chat draws
  in a reply (narration, speech, actions, thoughts, the four highlight
  tones and quoted lines), written as a block would ask for it and drawn
  as the chat shows it. On wide screens it stays beside the blocks, as the
  character sheet's index does; elsewhere it follows them.
- The built-in default prompt preset carries Ephemera's own instructions
  in four blocks: how to play scenario cards as game master and subject
  cards as their subjects with lean narration and outcomes judged without
  plot armor, what every non-player character must have and how they act
  in character, give agreement, trust and attraction only when earned
  rather than by default, hold grievances and turn dark only for reasons,
  take initiative and first meet `{{user}}` and one another as strangers
  unless the card, persona, lorebook or story so far says they know each
  other,
  a world model of the scene (space, bodies, sex and consequence), and
  the reply format (a location line, speech, actions and thoughts prefixed
  with name and age, and a closing list of the characters present). They
  read the tags the AI card creator writes. Its persona source template labels the
  persona as `<persona>`, the tag the main prompt names, and says it
  describes the player's character, whatever its pronouns, as fact the
  story stays consistent with.
- Sampler presets: model, max output tokens, temperature, top-p,
  frequency and presence penalty, seed, reasoning effort (low to maximum,
  as the model offers) where the model supports it. The context window is
  the model's own, not a preset value; Settings can cap it per model.
- Import SillyTavern Chat Completion preset JSON as native prompt and sampler
  presets, with recognized instructions converted into blocks, source templates
  and actions. The report names approximations and discarded settings. Valid
  unused prompt-library entries become disabled blocks.
- Export and re-import prompt and sampler presets independently as Ephemera
  JSON files. Native imports create only their own kind and retain their name,
  Author's Note, actions and templates. Exports wait for pending edits to save;
  a conflict or an oversized readable legacy item is explained inline.
- Characters, personas and presets autosave. When another tab saved the
  same one first, the save is refused and the sheet offers Reload or Keep
  mine.

**Chat**
- Start from a character's greeting; swipe between alternate greetings.
  If a required character, persona or preset cannot load, the greeting
  waits with **Try again**.
- Streaming replies with stop.
- Regenerate, and swipes: step through alternate replies, swiping past the
  last one generates a new one.
- Edit or delete any message, delete a message and everything after it,
  or delete one alternate reply, each with Undo; continue a reply;
  impersonate (the model writes the user's next message into the composer).
  Continuing an edited reply keeps the edit literal and fills macros only
  in the new model text. Continue joins the addition without repeating the
  existing reply. An empty composer cannot Send.
- Author's Note owned by the prompt preset: text, an on/off switch,
  placement in the chat at a depth or after the main prompt, role and
  frequency, sent at its frequency for every character while on. The
  default preset ships a behavioral reminder about NPC agency and the limits
  of each person's knowledge.
- Collapsible reasoning display: reasoning the model writes inline (in tags
  such as `<think>`) read out of the reply when the prompt preset says so,
  shown open or closed by default, editable, optionally sent back with the
  latest replies; the thinking time of models that hide their reasoning.
- Replies render Markdown, a single newline as a line break, with
  typographic quotes, dashes and ellipses. Four highlight tones,
  `:rose[words]`, `:sage[words]`, `:iris[words]` and the subdued
  `:mist[words]`, give a preset a shorthand to ask the model to mark parts
  of a reply; the default preset marks sexual actions. The cast panel
  uses the same tones in each woman's record: sexual experience, fetishes
  and taboos in rose, personality in sage, the intimate body in iris.
- A character's reply reads as four distinct voices, loudest first: spoken
  lines in quotation marks, actions in `*asterisks*`, thoughts in
  `:thought[words]` and unmarked narration. A line's cue, such as
  `Kate (25):`, names its speaker as a play script does: the name in the
  reading sans, a step smaller and quieter than the turn's nameplate, so
  several speakers in one scene read apart at a glance, and the age as a
  quiet aside. The cast panel under the portrait lists the women in the
  scene, each name semibold in ink with her age as a quiet aside over a
  line of her current state; an entry opens her full record. A present
  block, from a preset that still asks for one, opens each woman's line
  with her name, upright and semibold in ink. A reply or greeting that
  opens with a Location line shows it as `> Location:` set apart by an
  empty line, even when the model wrote it without the quote mark or the
  empty line; the stored text is unchanged.
- The chosen character is present beside the story: one portrait, their
  prose in a reading sans across the page and yours in the interface sans on
  a slip at the trailing edge, a room that leans
  faintly toward the portrait's colour, and a lamp and a glow that answer
  while they write.
- **Picture this scene**: with a ComfyUI address saved, a button under the
  character's portrait, in the float and in the phone band (alone in its
  place when there is no portrait), paints one 2:3 picture of the moment.
  The prompt model (the image prompt model from Settings, else the chat's,
  taken at the press and kept for Paint it again) writes an image prompt from the card, the looks and
  state of the people present as the cast register has them, and the
  chat's latest turns (up to 40 turns and about 6,000 tokens), and ComfyUI paints
  it with the workflow chosen in Settings, in a capture fitted to the era
  the card and the chat give, a selfie only when the chat has the
  character taking one. Only the character is shown,
  never the persona: a Subject card's subject, the subjects of a Group card
  the latest turns place in the scene, or the one person of a Scenario
  card they focus on, who looks as the chat has described them. A Subject or Group card's stored portrait goes to a
  prompt model that reads images, and on Atelier's private worker (an
  optional hardened ComfyUI backend Ephemera supports) its top
  third goes to the workflow's reference graph as the face to keep; a
  Scenario card sends text only. One picture per press, laid into the
  story after the newest message, large and view only, with the stage
  while it paints, Stop, and Paint it again or Hide after a failure or a
  stop. It is never sent to the text model and lives in the open tab only:
  Clear, a reload, leaving the page or deleting the message it follows
  takes it.
- Keyboard shortcuts: Left and Right swipe the last reply, Ctrl+Enter
  regenerates, Alt+Enter continues; from an empty composer, Up edits the
  last message and Ctrl+Up your last one.
- Context meter that stays out of sight until the context in use is three
  quarters full, then shows token use against it; the prompt inspector
  always has the figures.
- Replies cut off at the output limit or stopped by the provider's content
  filter say why in the footer, including when reasoning used the output
  room before any reply. Continue clears the old reason while it writes and
  uses the new attempt's reason afterwards. A partial continuation leaves
  its cast snapshot stale until a complete reply can be processed.
- Prompt inspector: the exact prompt of the last request, with the model's
  own count, how much of it the provider's prompt cache served, and what
  the model wrote and how much of that was reasoning when the provider
  says, plus a preview before sending that marks where it first differs
  from the last prompt sent, which is as far as that cache can reach. It
  names the Cast block and the Cast state line. Usage expands into this
  request's provider attempts and this tab's session totals by purpose:
  narration, cast keeper and sheet, memory and chapter, opening and scene
  prompt text. Helper repairs and SDK retries count as separate attempts;
  image generation is excluded. Failed or aborted calls may have used tokens,
  and missing receipts or counters stay unknown rather than becoming zero.
  Cached tokens appear only when reported, including an explicitly reported
  zero. Counts are not prices. The tab retains at most 512 records and each
  server request or job at most 128, with a notice when accounting truncates.
  Clear, reload and `pagehide` drop the records. Without attempt receipts,
  attempt counts are unknown.
- **Clear** with confirmation; it also closes the character, back to a
  chat without one. A chat with nothing written yet, at most the untouched
  greeting, clears without asking.

**Prompting**
- Ordered prompt blocks, depth placements and history for Chat Completion models.
- Macros: `{{char}}`, `{{user}}` (the chosen persona's name, or "User"
  without one), `{{time}}`, `{{date}}`, `{{weekday}}`, `{{isotime}}`,
  `{{isodate}}`, `{{datetimeformat}}` (in the browser's timezone),
  `{{random}}`, `{{pick}}` (stable within a chat), `{{roll}}`.
  Nested and scoped macros, whitespace, conditional branches, local/global
  variable functions and shorthand operators, indexed object/array values,
  card and history fields, runtime limits, reasoning delimiters, UTC offsets
  and relative time differences are handled by the same bounded evaluator.
  Both variable namespaces disappear with the chat; "global" does not mean
  shared between tabs or saved on the server.
  If filling a model reply exceeds the macro limits, a notice explains
  why its text stays literal, and its partial variable changes are discarded.
- A card's own system prompt and post-history instructions replace the
  preset's, unless Settings says to prefer the preset's.
- Embedded character lorebook: keyword activation over a scan depth,
  constant entries, insertion order, before/after-character placement and a
  token budget.
- History trimmed to fit the context in use: the oldest
  messages go a block at a time (an eighth of the prompt budget), so the
  retained start of the chat stays put between overflows and the
  provider's prompt cache keeps the rest. If a block cannot fit, trimming
  falls back to individual messages within it.
- Each chat sends its own cache affinity id with every generation, so
  providers that cache prompts keep it on one replica. A new chat or
  **Clear** gets a new one; previews send none.

**Models**
- Model list from the upstream's `/v1/models`, any OpenAI-compatible
  provider's (README § Model providers), without the models its catalog
  hides; pick per preset or per session. Every model picker finds a model
  by typing part of its ID, and takes a whole ID the provider does not
  list. While the list loads or fails, typing an ID still works, and a
  failed list offers Try again.
- Each model's limits come from the model catalog, in whichever field
  names the provider uses: its context window, the most it writes in one
  answer, its reasoning levels and whether it reads images. AI creation,
  rework and memory never ask a model for more output than it reports; the
  reasoning control is offered only for models that support it. Until the catalog reports reasoning support, the
  control is offered for every model and says so. A model that reports no
  context window is never sent a silently guessed budget: the owner sets
  its window in Settings, under Context, and until then nothing is sent to
  it. Every place that refuses for that reason links to that model's
  window field, and a model picker in Settings notes it under the choice.
- Settings also hold a context limit per model, 131,072 tokens unless set
  there. The context in use, which sets the token budget, is the smaller
  of the model's window and its limit.
- Prompt post-processing per model, off unless set in Settings, for models
  whose chat template needs it: merge consecutive roles, one leading system
  message (semi-strict), strict alternation, or a single user message.

**World Info** for a character's embedded and linked lorebooks, using the
entry settings stored in the card:
- secondary keys with AND ANY, AND ALL, NOT ANY and NOT ALL;
- recursion: entries bring in entries their text mentions, with the
  non-recursable, prevent further recursion and delay until recursion
  flags, within the scan's work bound;
- positions before or after the character, before or
  after the example dialogue, above or below the Author's Note, in the
  chat at a depth with a role; imported outlet entries become disabled text;
- timed effects (sticky, cooldown, delay), whose state lives only in the
  open tab like the rest of the chat;
- trigger chance: an entry that has one is rolled once per request when it
  would go in (always on, a keyword match or a recursive match), and a lost
  roll keeps it out of that request; an entry held by a sticky effect stays
  in without a roll, and an always-on entry with a chance works as a random
  event;
- event pools: of the entries of one pool
  that would go in, at most one is sent per request, a prioritized one with
  the highest order or else one drawn by weight, before its chance and the
  budget; an entry held by a sticky effect keeps its pool, and a pool taken
  once stays taken for the request, also in recursive passes. An entry
  joins up to eight pools, and one name across a character's lorebooks is
  one pool;
- per-entry scan depth, Match case and whole-word overrides;
- budget admission: entries staying in first, direct
  matches before recursed ones, highest orders first.

The lorebook editor edits every one of these, and the inspector says why
each entry went in or stayed out; when a request read several of a
character's books, each entry it lists names its book and opens it there. Unsupported imported
settings, including group scoring, automation ids, vector matching, character
filters and unknown metadata, are omitted and named in the import report.
Keys are matched against the chat and, with
recursion, the text of entries already sent; card fields, the persona and
notes are not scanned.

### Prompt and lorebook behavior

- **`{{random}}`**: options chosen uniformly from the platform's generator.
- **`{{pick}}`**: stable within a chat and per position, from the chat's seed.
- **Macro side effects**: only explicit chat actions commit variable changes.
  Greetings and user text are filled when created; model output is filled
  for display on receipt and its raw text again when a later generation uses
  it as history. Previews run on copies. Background prompt recounts never
  advance variables.
- **Lorebook scan depth, budget and recursion**: Ephemera reads a book's
  own scan depth, token budget and recursive scanning, which its lorebook
  screen edits. There are no global World Info settings: a book that
  sets no depth or budget uses the last 2
  messages and a quarter of the context, and entries bring in other entries
  only when the book turns recursion on.
- **Several lorebooks for one character**: a character's books (the one
  in its card, then its linked library books in
  link order) are read together under each book's own settings: an entry
  uses its own book's scan depth, and only entries of books with recursion
  on bring in, or are brought in by, other entries. The books share one
  budget, the largest any of them allows. One request reads at most 10,000
  entries across the books and reports the rest unscanned.
- **Event pools**: a pool is
  settled once per request, by the first scan pass in which one of its
  entries triggers or by an entry a sticky effect holds: the entry chosen
  must still pass its chance, have its placement sent and fit the budget,
  and when it does not, no other entry of the pool takes its place. A pool
  name used in two of a character's books is one pool. Group scoring is
  kept and not used.
- **Highlights in lorebook scans**: keys match a message without its
  highlight markup (`:rose[` and its `]`), so a key such as "Rose" or
  "Mist" fires on the story, not on the tone names.
- **Lorebook Match case and whole words**: an entry's own settings decide.
  Without them, the card entry's Match case field applies, with
  case-insensitive and whole-word matching as the defaults.
- **A prompt that cannot fit**: when the fixed blocks alone exceed the
  context in use, Ephemera sends nothing and says why.
- **Block trimming**: by default history is left out a block at a time,
  so the retained start of the chat holds for the provider's prompt cache.
  Turning block trimming off in Settings drops the oldest messages one at a time.
- **Memory**: memories are separate from lorebook entries. The remembered
  turns fold out of the request by themselves and come back with Show, and
  a notebook of where the story stands, rewritten by every memory, goes in
  beside them.
- **Prompt cache affinity**: Ephemera sends each chat's cache affinity id
  with every generation, unless the deployment turns the upstream session
  cache off for an upstream that rejects it.
- **Reasoning effort**, as this document states above: sent where
  the model catalog lists it.

### Non-goals

- Saving, exporting, importing or backing up chats in any form.
- Local accounts, sign-up, user administration or sharing between users.
- Extensions, plugins, scripting and slash commands.
- Text Completion backends, image generation beyond card portraits and
  scene pictures, TTS and STT.
- Support for anything but current Chromium-based browsers.

## Done means

1.0 is done when users can import their cards and chat in a fast, refined
interface, and the retention tests find no trace of the chat at any
hop Ephemera controls.
