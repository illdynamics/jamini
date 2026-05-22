# Jamini Architecture

Jamini is a **wrapper + local HTTP bridge** architecture that makes the unmodified upstream Gemini CLI talk to DeepSeek V4 models instead of Google Gemini.

## Core Flow

```
User shell
  │
  ▼
jamini (CLI wrapper, src/cli.ts)
  │
  ├── 1. Load config (~/.jamini/config.json + env overrides)
  ├── 2. Validate model args (reject unsupported models)
  ├── 3. Write Gemini CLI settings (~/.jamini/gemini-cli-home/settings.json)
  │       Forces API-key auth mode, disables OAuth
  │
  ├── 4. Start local bridge (JAMINI_BRIDGE_MODE decides how)
  │       │
  │       ▼
  │     Bridge HTTP server (bridge/src/server.ts, Express)
  │       │  Listens on 127.0.0.1:{ephemeral port}
  │       │  Exposes Gemini-compatible REST endpoints
  │       │
  │       └── Translates Gemini GenerateContent ↔ DeepSeek Chat Completions
  │             │
  │             ▼
  │           api.deepseek.com (via DEEPSEEK_API_KEY)
  │
  ├── 5. Set env for child Gemini CLI:
  │       GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:{port}
  │       GEMINI_API_KEY={local proxy key}
  │       GEMINI_CLI_HOME=~/.jamini/gemini-cli-home
  │       (Unsets Vertex/OAuth env vars)
  │
  └── 6. Spawn upstream @google/gemini-cli (UNMODIFIED)
        │
        ▼
      Gemini CLI sends Gemini GenerateContent requests
      → to local bridge at GOOGLE_GEMINI_BASE_URL
      → bridge translates → DeepSeek
      → bridge translates response back → Gemini CLI behaves normally
```

## Key Principle: Gemini CLI Source Is Never Modified

Jamini treats `@google/gemini-cli` as an unmodified upstream dependency. All integration happens through:

- **Environment variables** (GOOGLE_GEMINI_BASE_URL, GEMINI_API_KEY, GEMINI_CLI_HOME)
- **Isolated config directory** (~/.jamini/gemini-cli-home/settings.json)
- **Local HTTP bridge** that speaks Gemini REST API on the inbound side and DeepSeek Chat Completions on the outbound side
- **Process spawning** — the wrapper runs Gemini CLI as a child process

## Bootstrap Script

The [`./jamini`](../jamini) script at the repo root handles build and install:

```bash
# Build the container image (Docker or Podman)
./jamini build

# Install to ~/.config/jamini and ~/bin/jamini, auto-installs @google/gemini-cli
./jamini install

# Remove from system
./jamini uninstall
```

The `install.sh` one-liner wraps all of this — it fetches the release zip and calls `./jamini install` automatically.

## Bridge Launch Modes (`JAMINI_BRIDGE_MODE`)

How the bridge process gets started:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Try process mode. If it fails and container runtime exists, fall back to container. If JAMINI_BRIDGE_URL is set, use external. |
| `process` | Start bridge as a local Node.js child process on 127.0.0.1:{free port}. No Docker/Podman needed. **This is the preferred path.** |
| `external` | Do not start any bridge. Use JAMINI_BRIDGE_URL. User must have a bridge running. |
| `container` | Start bridge in a Docker or Podman container. Fallback if process mode can't work. |

## Container Image

A Dockerfile is provided for containerized deployments and container bridge mode:

```bash
# Build via the bootstrap script (recommended)
./jamini build

# Or build directly
docker build -t jamini:latest .

# Run in a container (process mode is preferred)
docker run --rm -it \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v "$PWD:/workspace" \
  jamini:latest "explain this repo"
```

Container mode is a fallback — **process mode is the default and preferred path** (no container needed).

## Translator Modes (`JAMINI_TRANSLATOR_MODE`)

Which implementation handles Gemini ↔ DeepSeek translation:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Uses custom bridge. |
| `custom` | Jamini's own TypeScript bridge (bridge/src/server.ts). Production-grade Gemini GenerateContent → DeepSeek Chat Completions translator. |
| `litellm` | LiteLLM proxy mode. Not yet implemented (stub). |

## Auth Bypass Mechanism

Jamini prevents Gemini CLI from ever triggering Google OAuth/login:

1. Writes `settings.json` to `~/.jamini/gemini-cli-home/` that forces `"selectedType": "gemini-api-key"` auth
2. Sets `GEMINI_API_KEY` to a local proxy key (random UUID) — this satisfies Gemini CLI's API-key auth check
3. Sets `GOOGLE_GEMINI_BASE_URL` to `http://127.0.0.1:{port}` so all Gemini API traffic goes to the local bridge
4. Unsets/overrides `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and sets `GOOGLE_GENAI_USE_VERTEXAI=false`
5. The bridge accepts the local proxy key in `Authorization` headers and validates it before processing requests

The bridge authenticates to DeepSeek using `DEEPSEEK_API_KEY` — this key never leaves the bridge process.

## Model Resolution

User-facing models → DeepSeek backend:

| Jamini Model | DeepSeek Model | Thinking |
|-------------|----------------|----------|
| `v4-flash` | `deepseek-v4-flash` | disabled |
| `v4-flash-thinking` | `deepseek-v4-flash` | enabled |
| `v4-pro` | `deepseek-v4-pro` | disabled |
| `v4-pro-thinking` | `deepseek-v4-pro` | enabled |

All model list endpoints (`/v1beta/models`, `/v1/models`) return only these four models. Google/Gemini models are never exposed.

The complete model catalog is in [`config/model-catalog.json`](../config/model-catalog.json).

## Endpoint Surface

The bridge exposes these Gemini-compatible REST endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe |
| GET | `/version` | Bridge version info |
| GET | `/v1beta/models` | List models (4 Jamini models only) |
| GET | `/v1/models` | List models (4 Jamini models only) |
| GET | `/v1beta/models/:model` | Model detail |
| GET | `/v1/models/:model` | Model detail |
| POST | `/v1beta/models/:model:generateContent` | Non-streaming generation |
| POST | `/v1/models/:model:generateContent` | Non-streaming generation |
| POST | `/v1beta/models/:model:streamGenerateContent` | Streaming generation (SSE) |
| POST | `/v1/models/:model:streamGenerateContent` | Streaming generation (SSE) |
| POST | `/v1beta/models/:model:countTokens` | Token counting (estimate) |
| POST | `/v1/models/:model:countTokens` | Token counting (estimate) |
| GET | `/debug/config` | Debug config (secrets redacted) |

## Process Supervision

- Wrapper selects a free loopback port via `http.createServer().listen(0, '127.0.0.1')`
- Bridge PID written to `~/.jamini/run/bridge.pid`
- Stale PID files detected (process no longer alive) and cleaned up
- Bridge logs written to `~/.jamini/log/bridge.log`
- Wrapper logs written to `~/.jamini/log/jamini.log`
- SIGINT/SIGTERM forwarded to both bridge and Gemini CLI child
- Bridge process killed on wrapper exit (unless external mode or `JAMINI_KEEP_BRIDGE=1`)

## File Layout

```
~/.jamini/
├── config.json              # User config (no secrets)
├── log/
│   ├── jamini.log           # Wrapper logs
│   └── bridge.log           # Bridge logs
├── run/
│   ├── bridge.pid           # Bridge process PID
│   └── .local-proxy-key     # Random proxy auth key
└── gemini-cli-home/         # Isolated Gemini CLI state
    └── settings.json        # Forces API-key auth, disables OAuth
```
