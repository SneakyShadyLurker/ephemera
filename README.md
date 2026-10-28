<p align="center">
  <img src="apps/web/public/favicon.svg" width="96" height="96" alt="Ephemera">
</p>

<h1 align="center">Ephemera</h1>

<p align="center">
  <strong>An opinionated roleplay interface where your characters stay and your conversations don't.</strong><br>
  Bring your SillyTavern cards. Every chat vanishes when you close the tab.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-c77f1e"></a>
  <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-2a231e">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-2a231e">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-c77f1e">
</p>

---

Ephemera is a self-hosted roleplay chat that makes the choices for you: cards
written for models, one formatting language, memory and story events that work
without tuning. Your characters, personas, lorebooks and presets are saved and
encrypted per user. Your conversations never touch a disk.

## Highlights

### ✦ Create with AI
Describe a character, a group or a whole scenario in a few words. The model
writes a complete card, consistent with the persona you play, and paints
portrait candidates when an image backend is connected.

### ✦ AI Rework
Tell the model what should change in an existing card. Its edits arrive as
tracked changes, each with a reason, for you to accept or reject one by one.

### ✦ Memory
Characters remember. An editable notebook of where the story stands, memories
of what happened and the next chat's opening carry over, saved encrypted as
character data. The turns themselves are never saved. On by default, switchable
per character.

### ✦ Events
One-line story directions that fire by chance, with cooldowns and scopes, so
scenes keep moving without you steering every turn.

## Also included

- **SillyTavern import**: Character Card V2 and V3 from PNG or JSON with
  embedded lorebooks, World Info books and Chat Completion presets, with a
  report of what was kept, changed or left out
- **Chat**: streaming, swipes, regenerate, continue, impersonate, edits with
  undo, and a cast register that keeps everyone in the scene consistent
- **Lorebooks and presets**: a lorebook library linked to any character,
  ordered prompt blocks, an Author's Note, independent sampler presets and a
  macro engine for `{{char}}`, `{{user}}` and more
- **Pictures**: portraits and scene pictures through ComfyUI or Atelier, with
  your own workflows mounted in
- **Polish**: light and dark themes, custom palettes, and layouts built for
  phones, tablets and desktops

## Zero chat retention

Chat messages, drafts, assembled prompts and replies live only in the open tab
and, for one request, in server memory. Cards you keep, reworks you apply and
character memory become saved, encrypted character data. A retention test
matrix guards every hop Ephemera controls; your model provider and image
backend need the settings in [docs/PRINCIPLES.md](docs/PRINCIPLES.md), such as
request logging off.

## Quick start

Requirements: [Bun](https://bun.sh) (or Docker), an OpenAI-compatible model
upstream, a trusted authentication proxy that injects `Remote-User` and the
proxy key (for example SWAG with Authelia), and a current Chromium-based
browser on desktop or Android. ComfyUI or Atelier is optional.

```sh
bun install
cp .env.example .env   # set the upstream, the proxy key and the data key
bun run dev            # http://localhost:5173
```

`bun run check` runs typecheck, lint, unit tests and the persistence audit;
`bun run test:e2e` runs the Playwright flows and retention scans. The hardened
container and its deploy checklist are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § Deployment.

## Documentation

[Product](docs/PRODUCT.md) · [Principles](docs/PRINCIPLES.md) ·
[Architecture](docs/ARCHITECTURE.md)

## License

[GNU AGPL v3.0 only](LICENSE). Ephemera is meant for adults; operators decide
who they admit.
