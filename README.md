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
- **Pictures**: portraits and scene pictures through ComfyUI or [Atelier](https://github.com/SneakyShadyLurker/atelier-studio), with
  your own ComfyUI workflows imported in Settings or mounted on the server
- **Polish**: light and dark themes, custom palettes, and layouts built for
  phones, tablets and desktops
- **An example character**: one card ships with the server, Friday Abbams with
  her portrait, so a new library has someone to talk to from the first visit

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

Each new library starts with the example character; delete her like any card,
or set `EPHEMERA_STARTER_CHARACTER=off` to start new libraries empty.

`bun run check` runs typecheck, lint, unit tests and the persistence audit;
`bun run test:e2e` runs the Playwright flows and retention scans. The hardened
container and its deploy checklist are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § Deployment.

## Model providers

Ephemera talks to one OpenAI-compatible upstream, set for the whole server in
`.env` (or `infra/docker/.env` for the container):

```sh
EPHEMERA_UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
EPHEMERA_UPSTREAM_API_KEY=your-key   # leave empty for a local server without one
```

Restart the server after a change. The model list comes from the provider's
`/models`, and every model picker also takes a model ID typed in full. Where the
provider reports a model's context window, reasoning levels or image input,
Ephemera uses them; where it does not, set the window in Settings > Model setup,
under Context, before chatting with that model.

| Provider | Base URL | Key | Context windows reported |
|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | Required | Yes |
| DeepSeek | `https://api.deepseek.com` | Required | Yes |
| Groq | `https://api.groq.com/openai/v1` | Required | Yes |
| Mistral | `https://api.mistral.ai/v1` | Required | Yes |
| Together AI | `https://api.together.ai/v1` | Required | Yes |
| vLLM | `http://<host>:8000/v1` | Only if started with one | Yes |
| llama.cpp server | `http://<host>:8080/v1` | Only if started with one | No |
| Ollama | `http://<host>:11434/v1` | None | No |
| LM Studio | `http://<host>:1234/v1` | Only if enabled | No |
| CLIProxyAPI | `http://<host>:8317/v1` | One of its client keys | Yes |

Each chat sends a prompt cache key (`prompt_cache_key` and an
`x-session-affinity` header) so providers that cache prompts can reuse them. A
provider that refuses the field gets the request again without it, and the
server stops sending it; `EPHEMERA_UPSTREAM_SESSION_CACHE=off` turns it off from
the start. A provider that refuses the output cap (`max_tokens`) or the
streamed usage request (`stream_options`) by name gets the request again
without that field; the usage request then stays off, and token counts show as
not reported. Inside the container, `localhost` is the container itself: point a
server on the host at an address the container can reach, such as
`host.docker.internal`.

## Documentation

[Product](docs/PRODUCT.md) · [Principles](docs/PRINCIPLES.md) ·
[Architecture](docs/ARCHITECTURE.md)

## License

[GNU AGPL v3.0 only](LICENSE). Ephemera is meant for adults; operators decide
who they admit.
