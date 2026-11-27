# MagmaX Rotator

**One local API for every AI provider — with an intelligent failover engine, real model catalogues, sandboxed skills and live monitoring.**

MagmaX Rotator is a self-hosted AI gateway. Add your provider keys once; it discovers the models each provider actually exposes, routes every request through a configurable priority chain, and switches models automatically when one is rate limited, down, out of quota or timing out. It speaks the OpenAI Chat Completions API and the Anthropic Messages API on the same port, so Claude Code, OpenCode and any OpenAI-compatible tool can use it as a drop-in endpoint.

---

## Quick start

Requirements: **Node.js 22.5+** (the server uses the built-in `node:sqlite` module) and npm. No external database, no Docker, no account.

```bash
npm install
npm start
```

Open **http://localhost:3000**.

`npm start` builds the server and dashboard on first run, then boots the gateway:

```
Dashboard   http://localhost:3000
Gateway     http://localhost:3000/v1
```

Useful variants:

```bash
npm start -- --port 4000            # different port
npm start -- --host 0.0.0.0         # expose on the network (enable API-key auth first)
npm run dev                          # server with watch mode (dashboard from the last build)
npm run dev:web                      # Vite dev server with HMR on :5173 (proxies the API)
```

### Background control commands

Install the `magmaxrotator` command once, then start/stop the gateway like a service:

```bash
npm link              # or: npm install -g .
magmaxrotator start
magmaxrotator status
magmaxrotator restart
magmaxrotator stop
```

`start` builds when needed and runs the server in the background, writing its PID to `data/magmax.pid` and logs to `logs/server.log`. Options: `--port <n>`, `--host <addr>` (also `MAGMAX_PORT` / `MAGMAX_HOST`).

No global install needed: from the project folder use `node bin/magmaxrotator.mjs start`, or on Windows ``.\magmaxrotator.cmd start``. If `npm link` needs administrator rights, `npm install -g .` is equivalent; if PowerShell blocks the npm `.ps1` shim, call `magmaxrotator.cmd start`.

Foreground `npm start` remains available; `magmaxrotator stop` also stops a foreground server when it can identify it through `/api/status` (otherwise press Ctrl+C in that terminal).

Everything is stored under `./data` (SQLite database, encryption key, installed skills). Override with `MAGMAX_DATA_DIR`.

### First run

1. **Providers → Add provider** → pick a provider, paste a key, click **Connect & validate**.
   The key is validated with a real model-list request; only then is it activated. Local runtimes (Ollama, LM Studio, vLLM, llama.cpp, LocalAI) need no key.
2. Models are imported from the provider response. Enable/disable, set priority, favourite and pricing under **Models**.
3. Order the chain under **Router** — or leave it on priority order. Press **Test routing** to send a real tiny request through the chain.
4. Connect a client under **Integrations** (Claude Code / OpenCode), then watch **Monitoring**.

---

## What it does

- **Multi-provider gateway** — NVIDIA NIM, Google Gemini, OpenRouter, Groq, Kilo AI Gateway, Cline API, OpenAI, Anthropic, Together, DeepSeek, Mistral, Cerebras, SambaNova, Fireworks, Hugging Face Router, GitHub Models, Cloudflare Workers AI, Ollama, LM Studio, vLLM, llama.cpp, LocalAI, plus custom OpenAI- and Anthropic-compatible endpoints.
- **Real failover** — ordered candidates, exponential-backoff cooldowns, key rotation, error classification, stream-safe switching, continuation on output limits.
- **Real model discovery** — catalogues and metadata come from provider APIs (OpenRouter pricing, Gemini token limits, NVIDIA capabilities, Anthropic and Cloudflare model lists). Unknown specifications stay `null`; nothing is fabricated.
- **Model management** — search, filter, sort, favourites, enable/disable, priority, per-model pricing overrides, manual models and aliases (`claude-sonnet-4-5` → any routed model).
- **Skills hub** — built-in executable skills plus import from a directory or Git repo. Each run is a separate Node process with `--permission`, read access limited to its own folder, network only when declared, and a hard timeout. Execution logs and outputs are stored.
- **MCP servers** — add a stdio MCP server, perform the real `initialize` / `tools/list` handshake, inspect its tools and call them.
- **Monitoring** — request volume, success rate, latency, tokens, cost estimates, fallback and rate-limit events, provider/model breakdowns, SSE live events, structured logs and a per-request routing trace.
- **Local-first security** — AES-256-GCM encrypted provider keys, optional API key for `/v1`, optional dashboard admin token, rate limits, body-size limits, localhost-only binding by default, secret redaction in logs.
- **Built-in diagnostics** — real checks for database writes, encryption tamper detection, a live HTTP failover/streaming self-test, endpoint validation, provider connectivity, skills execution and client configuration.

---

## Providers

### Priority providers

| Provider | Base URL | Auth | Access | Notes |
| --- | --- | --- | --- | --- |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | Bearer | Free developer credits, then metered | OpenAI chat completions + Anthropic endpoint |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Bearer / `x-goog-api-key` | Free tier with quotas | Model limits read from the native models endpoint |
| OpenRouter | `https://openrouter.ai/api/v1` | Bearer | Paid; `:free` models exist | Live pricing and capability metadata |
| Groq | `https://api.groq.com/openai/v1` | Bearer | Generous free tier, strict limits | |
| Kilo AI Gateway | `https://ai-gateway.kilo.ai/api/v1` | Bearer | Free models anonymously; paid with key | See “Kilo Code and Cline” below |
| Cline API | `https://api.cline.bot/api/v1` | Bearer | Paid usage-based | OpenAI-compatible; sends `X-Response-Format: openai` |

### Additional providers

OpenAI, Anthropic, Together AI, DeepSeek, Mistral, Cerebras, SambaNova, Fireworks AI, Hugging Face Router, GitHub Models, Cloudflare Workers AI, any OpenAI-compatible API, any Anthropic-compatible API.

Cloudflare Workers AI additionally requires the **account ID** (it is part of the URL). GitHub Models needs a token with the `models:read` scope.

### Local / keyless

Ollama (`127.0.0.1:11434/v1`), LM Studio (`127.0.0.1:1234/v1`), vLLM (`127.0.0.1:8000/v1`), llama.cpp and LocalAI (`127.0.0.1:8080/v1`). The runtime must be running before you connect; “Test” reports the real connection result.

### Kilo Code and Cline

Kilo Code and Cline are **coding agents**, not model vendors. They do not expose arbitrary model APIs of their own; their official programmatic interfaces are gateways:

- **Kilo Code** → Kilo AI Gateway (`ai-gateway.kilo.ai/api/v1`), OpenAI-compatible. Anonymous access works only for `:free` models and is IP rate limited; a Kilo API key unlocks the rest.
- **Cline** → Cline API (`api.cline.bot/api/v1`), OpenAI-compatible, authenticated with a Cline API key from `app.cline.bot`.

Both are supported as providers through those gateways — not by pretending the agents themselves are inference APIs.

### Access transparency

Every provider carries a tier: `free`, `limited` (documented free/trial quota), `paid`, `local` or `unknown`. These reflect published access models at the time of writing — **check the provider’s current pricing**. MagmaX never assumes a provider is free.

### Multiple keys

A provider can hold several keys. The router picks the key with the fewest failures and rotates on auth/quota errors; failed keys are recorded with the last error and can be disabled individually.

---

## Routing and failover

Configure under **Router**:

| Setting | Meaning |
| --- | --- |
| Routing mode | `priority`, `fastest`, `cheapest`, `smart`, `manual` |
| Profile | `general`, `coding`, `reasoning`, `fast`, `long_context`, `vision`, `free_local` |
| Max attempts | Hard cap on provider attempts per request |
| Request timeout | Per-attempt budget in milliseconds (the timeout also guards the stream) |
| Cooldown / max cooldown | Exponential backoff base and cap |
| Automatic recovery | Background health checks re-validate providers |
| Continuation | Non-streaming: continue when a model hits its output limit |
| Fallback rules | Per error class: which failures move to the next model |
| Excluded models | Never route these ids |

### Algorithm

1. Collect enabled models from active providers with a usable credential.
2. Drop excluded models, cooling-down models and models that cannot satisfy required capabilities (tools/vision).
3. Apply the profile filter (`free_local`, `vision`) and score per mode.
4. Prefer an exact requested model or a configured alias, then walk the chain.
5. For each candidate, attempt the request with the healthiest key. Classify failures and decide:
   - `rate_limit` → cooldown (honours `Retry-After`), next candidate
   - `auth` / `quota` → record key failure, rotate key, then next candidate
   - `server`, `network`, `timeout` → cooldown with exponential backoff, next candidate
   - `model_unavailable` → next candidate
   - `invalid_request`, `context_length`, `content_filter` → stop with `400` by default (another model will not fix a bad payload)
   - `cancelled` → stop immediately
6. If everything fails, return a `429`/`502` with every attempt listed (provider, model, class, status, message).

### Streaming safety

Fallback happens only **before any byte reaches the client**. The engine counts emitted events; once output started, a provider failure returns an explicit stream error instead of silently switching models. That prevents duplicated or truncated text and replayed tool calls. Non-streaming requests may continue a `finish_reason: length` response (configurable, same model, up to N times).

Response headers expose routing without secrets: `X-MagMax-Request-Id`, `X-MagMax-Model`, `X-MagMax-Provider`, `X-MagMax-Attempts`, `X-MagMax-Fallbacks`, `X-MagMax-Mode`.

---

## API

Both protocols share port 3000.

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` | implemented | Streaming, tools, `stop`, `response_format`, `seed`, extra passthrough fields; `max_completion_tokens` accepted |
| `GET /v1/models` | implemented | Enabled models + aliases, `?all=1` includes disabled |
| `POST /v1/completions` | implemented | Prompt mapped onto chat for older SDKs |
| `POST /v1/messages` | implemented | Anthropic Messages: system, tools, tool_use/tool_result, streaming events |
| `POST /v1/messages/count_tokens` | estimated | ≈4 chars/token; response is labelled `_magmax_estimated` |
| `POST /v1/embeddings` | not implemented | Returns `501` with an explanation |
| `POST /v1/responses` | not implemented | Returns `501`; use chat completions |
| `GET /api/*` | dashboard API | Admin token applies when configured |

Example:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Explain failover in one line."}]}'
```

Set any model name: an exact model id, an alias, or `auto` for pure chain order.

---

## Claude Code

Claude Code needs an Anthropic-compatible base URL. Under **Integrations** you can preview and write the config, or set it manually:

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_AUTH_TOKEN="<router API key from Settings>"
export ANTHROPIC_MODEL="claude-sonnet-4-5"       # alias mapped to any routed model
export ANTHROPIC_SMALL_FAST_MODEL="claude-haiku-4-5"
```

The base URL **must not** include `/v1`; Claude Code appends `/v1/messages`. “Apply to settings.json” merges these into `~/.claude/settings.json` and keeps a `.magmax-backup` copy. Model names sent by Claude Code are matched against your aliases (Models → aliases) or exact model ids; unmatched names route automatically.

**Verified in this build:** Anthropic Messages requests, SSE streaming, tool_use/tool_result round-tripping, system prompts and model aliases through the gateway. **Not verified:** every Claude Code feature (e.g. its internal 1M-context flags) — these are forwarded as ordinary requests, not specially emulated.

## OpenCode

OpenCode supports custom OpenAI-compatible providers. The generated `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME/opencode/opencode.json`) contains:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "magmax": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MagmaX Rotator",
      "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "<router API key>" },
      "models": { "magmax-auto": { "name": "MagmaX Auto (automatic failover)" } }
    }
  },
  "model": "magmax/magmax-auto"
}
```

`magmax-auto` routes automatically; registered model ids force that model. Streaming and tool calling are the standard OpenAI semantics passed through by the gateway.

---

## Skills

A skill is a directory with `skill.json` and an entry module:

```json
{
  "id": "my-skill",
  "name": "My Skill",
  "version": "1.0.0",
  "description": "What it does",
  "entry": "index.mjs",
  "permissions": { "network": [], "filesystem": "none", "env": [] },
  "timeoutMs": 10000,
  "exampleInput": { "text": "hello" }
}
```

```js
export async function run(input, ctx) {
  ctx.log('optional diagnostic output');
  return { ok: true, echo: input.text };
}
```

The function must return JSON-serialisable data. The runner prints it on stdout; stderr is captured as logs.

Execution model:

- `node --permission --allow-fs-read=<skill-dir>` (plus `--allow-net` only when the manifest declares network access)
- environment reduced to `PATH`; no inherited secrets
- hard timeout (max 120 s) and output caps
- results, errors and duration stored per skill

Built-in skills: **Text Summarizer**, **JSON Toolkit** (validate/format/minify/repair), **Token & Cost Estimator**, **Regex Tester**, **URL Metadata** (network) and **Line Diff**. Install from a directory (absolute path) or an `https://` Git repository (`git clone --depth 1`). Built-ins can be disabled but not removed.

> The permission sandbox is a strong guard, not a perfect security boundary. Review third-party skills before installing them.

### MCP

Add a stdio server (`command` + `args`), press **Probe** to perform the real JSON-RPC `initialize` / `tools/list` handshake, inspect discovered tools and call one with JSON arguments. Nothing is spawned until you add a server and press Probe or Call.

---

## Security

- Provider keys are encrypted with **AES-256-GCM** using `data/master.key` (created with `0600`) or `MAGMAX_MASTER_KEY`.
- Keys are never returned by the API, never logged, and never embedded in the dashboard bundle.
- `/v1` authentication is configurable (`requireApiKey`); when enabled, use `Authorization: Bearer <router key>`.
- The dashboard API optionally requires an admin token (Settings → Security); the token is stored in this browser only.
- Default binding is `127.0.0.1`. Exposing the gateway requires an explicit `--host` flag; enable both authentication layers first.
- Sliding-window rate limiting and a configurable request-body limit apply to `/v1`.
- Logs redact `sk-…`, bearer tokens and `key=` patterns; request payload logging is off by default.
- Requests older than 30 days are pruned automatically. Provider keys are excluded from configuration exports.

---

## Data, backup and updates

| Path | Contents |
| --- | --- |
| `data/magmax.db` | SQLite (WAL) — settings, providers, models, requests, events, skills, MCP servers |
| `data/master.key` | AES-256-GCM master key (0600) |
| `data/skills/` | Installed skill directories |

- **Settings → Data** downloads the SQLite file, exports/imports configuration (no keys), and clears request history.
- **Backups:** copy `data/` while the server is stopped, or download the database from the UI.
- **Updates:** `git pull && npm install && npm start` (the launcher rebuilds when sources change). Your `data/` directory is untouched.

---

## Diagnostics and tests

**Settings → Diagnostics → Run System Diagnostics** performs real checks:

1. Server/runtime information
2. SQLite insert/read/delete round trip
3. AES encryption round trip and tamper rejection
4. Failover engine: real HTTP 429 from a local mock upstream → classification → cooldown → fallback → intact SSE output
5. SSE adapter: delta, finish reason and usage parsing
6. Gateway endpoints: `/v1/models` and request validation over loopback
7. Provider connectivity (live calls, only if enabled)
8. Model catalogue sanity
9. Skills: sandboxed run of an installed built-in
10. Client integration configuration detection
11. Dashboard bundle / data directory checks

Automated tests:

```bash
npm test
```

Covered: error classification (429/401/500/400/404/context/retry-after), encrypted key storage and tamper rejection, routing modes and profiles, cooldown/exclusion/alias/capability selection, settings persistence, Anthropic request translation, sandboxed skill execution (success and real failure), HTTP failover with a broken stream, OpenAI and Anthropic endpoints (non-streaming and SSE), request validation and API-key auth.

**Not covered automatically:** live provider calls, because they require your credentials and would spend your quota. Use the Providers page or the diagnostics “Include live provider checks” option for those.

---

## Troubleshooting

**`No eligible model` / empty chain**
Connect a provider, press **Sync models**, then enable at least one model in **Models**.

**Provider test fails with 401/403**
The key is invalid, lacks scope, or the provider needs an extra field. Cloudflare requires the account ID; GitHub Models needs a token with `models:read`.

**429 or “all attempts failed”**
Everything is rate limited or cooling down. Open **Router** to see cooldowns and clear them, or raise cooldown settings. Providers may enforce daily quotas.

**Claude Code still talks to Anthropic**
Environment variables are not applied. Restart the terminal/IDE, or use **Integrations → Apply to settings.json**. Confirm `ANTHROPIC_BASE_URL` has no `/v1` suffix.

**Ollama/LM Studio won’t connect**
Start the runtime and confirm its port. Keyless local providers still need to be running; “Test” shows the connection error.

**Port 3000 is busy**
`npm start -- --port 4000`, then update client base URLs.

**Streaming stops with an error after output began**
This is deliberate: MagmaX will not switch models mid-stream. Retry the request to let the chain pick a healthier model.

**Locked out of the dashboard after setting an admin token**
Stop the server and clear the setting:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/magmax.db');db.prepare(\"UPDATE settings SET value='\\\"\\\"' WHERE key='adminToken'\").run();console.log('admin token cleared')"
```

**`git clone failed` when installing a skill**
`git` must be on `PATH` and the URL must be `https://`. SSH URLs are rejected by design.

**SQLite / `node:sqlite` errors on startup**
Use Node 22.5 or newer (`node -v`). Node 24 is recommended.

---

## Architecture

```
server/
  index.ts            Hono app, static dashboard, graceful shutdown
  config.ts           paths, host/port, .env loading
  db.ts               SQLite schema + typed access (node:sqlite)
  crypto.ts           AES-256-GCM secret storage
  http-utils.ts       auth, rate limits, body limits, error shapes
  providers/
    registry.ts       real endpoints, tiers, auth styles, docs
    discovery.ts      model catalogues (OpenAI/Anthropic/Gemini/Cloudflare)
    openai.ts         OpenAI-compatible adapter (+SSE)
    anthropic.ts      Anthropic Messages adapter (+translation, SSE)
    errors.ts         HTTP failure classification
    runtime.ts        credential selection, target building
    ops.ts            connect/test/sync, background health checks
  router/
    engine.ts         candidate scoring, failover loop, continuation
    state.ts          cooldowns with exponential backoff
    recording.ts      request records for monitoring
  skills/             sandboxed runtime + six built-in skills
  mcp.ts              minimal stdio MCP client
  integrations.ts     Claude Code / OpenCode config generation
  diagnostics.ts      real system checks incl. local failover test
  api/                OpenAI, Anthropic and dashboard routes
web/                  React 19 + Vite + Tailwind 4 dashboard (8 tabs)
tests/                Vitest unit + HTTP integration tests
```

Database: SQLite in WAL mode through Node’s built-in `node:sqlite` — no native modules to compile. Realtime: server-sent events (`/api/monitoring/stream`). Timeouts: `AbortController` per attempt, kept armed for the whole stream.

---

## Known limitations

- **Implementations not provided:** OpenAI Responses API and embeddings (explicit `501`s). Token counting is an estimate, not a provider tokenizer.
- **Streaming failover is pre-first-byte only** by design; mid-stream provider failures return an error.
- **Capability metadata** is only as good as the provider API. Tools/vision/reasoning/streaming may be `unknown` (shown as blank) and are used as soft signals, never invented.
- **Pricing** is read from provider responses where available (notably OpenRouter). Everything else is `unknown` unless you enter it manually; cost totals therefore cover only priced models.
- **Kilo Code and Cline** are supported through their gateways, not as direct model APIs.
- **Provider auth beyond API keys** (OAuth flows, AWS Bedrock signing, Vertex service accounts) is not implemented; use an OpenAI/Anthropic-compatible gateway for those.
- **Skills sandbox** restricts filesystem and network with Node’s permission model but is not a container. Untrusted code still deserves review. Skills cannot install npm dependencies automatically — vendor them inside the skill folder or keep the entry dependency-free.
- **MCP** supports stdio transport only; HTTP/SSE MCP transport is not implemented.
- **Single-user model:** one local dashboard, optional single admin token. There are no user accounts or per-user quotas.
- **No automatic updater:** updates are `git pull` + `npm install` + restart.
- **Live provider integrations are untested here** because doing so requires real credentials; the adapters follow the documented APIs and the failover/streaming machinery is covered by local HTTP tests.

---

## License and attribution

Built as a local-first developer tool. Provider names and APIs belong to their respective owners; this project is not affiliated with them.
