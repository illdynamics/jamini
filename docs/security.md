# Security

## Secret Handling

- **`DEEPSEEK_API_KEY`** is runtime-only. It is never written to config files, logs, or disk.
- **`BRAVE_API_KEY`** and **`UNSTRUCTURED_API_KEY`** are runtime-only. Same protections.
- The bridge redacts `Authorization` headers, bearer tokens, and API keys from all log output.
- `~/.jamini/config.json` only contains non-secret settings (model, mode, URLs). API keys are never persisted.
- Generated Gemini CLI `settings.json` contains no DeepSeek secrets.
- Debug endpoints (`/debug/config`) redact all secret values before returning.

## Local Bridge Binding

- The bridge **binds to `127.0.0.1` only** by default.
- Remote binding (e.g., `0.0.0.0`) requires explicit `JAMINI_ALLOW_REMOTE_BRIDGE=1` and prints a warning.
- Bridge port is ephemeral by default (dynamically allocated), reducing predictable attack surface.
- Fixed port can be set via `JAMINI_BRIDGE_PORT` if needed.

## Local Proxy Authentication

Between the Jamini wrapper and the bridge:

1. Wrapper generates a random UUID **local proxy key** on first run
2. Key is stored in `~/.jamini/run/.local-proxy-key` (permissions: `0600`)
3. Wrapper sets `GEMINI_API_KEY` to this proxy key for the Gemini CLI child
4. Gemini CLI sends the key in `Authorization: Bearer {key}` headers
5. Bridge validates inbound requests against this key before processing
6. The proxy key is never a real Google or DeepSeek key

This prevents other local processes from accidentally or maliciously using the bridge.

## Isolated Gemini CLI State

- Jamini does **not** use the user's real `~/.gemini` directory.
- Gemini CLI state is isolated to `~/.jamini/gemini-cli-home/` (set via `GEMINI_CLI_HOME`).
- Settings are written to force API-key auth mode and disable OAuth/Vertex paths.
- Google Cloud env vars (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`) are explicitly unset/overridden.

## No Google Auth

- Jamini never requires Google OAuth, browser login, or a real Gemini API key.
- Gemini CLI is configured to use `gemini-api-key` auth mode with a local dummy key.
- All Gemini API requests go to `http://127.0.0.1:{port}` — never to Google servers.
- If Gemini CLI somehow attempts Google auth, this is treated as a release-blocking bug.

## Network Exposure

- Bridge only listens on loopback (`127.0.0.1`).
- No inbound connections from other hosts are possible by default.
- External bridge mode users must configure their own firewall/network security.
- Container bridge mode binds host port to `127.0.0.1` only (not `0.0.0.0`).

## YOLO / Dangerous Mode

- **YOLO is NOT enabled by default.** Users must explicitly pass `-y`, `--yolo`, or `--approval-mode=yolo`.
- When YOLO is enabled, Gemini CLI auto-approves all tool actions — this can execute destructive commands.
- **⚠️ Only use YOLO in disposable VMs, containers, or trusted workspaces.**
- Jamini preserves Gemini CLI's approval/sandbox behavior unless YOLO is explicitly requested.
- YOLO flags are passed through to Gemini CLI unchanged; Jamini does not add or remove them.

## Optional Tools

- **Brave Search** and **Unstructured** tools are **disabled by default** unless:
  1. The corresponding API key (`BRAVE_API_KEY` / `UNSTRUCTURED_API_KEY`) is set, AND
  2. Config allows it (`enableBraveSearch` / `enableUnstructured` not set to `off`)
- Even when enabled, these tools are optional — Jamini works with only `DEEPSEEK_API_KEY`.
- Tool timeouts, rate limits, and structured error handling prevent abuse.

## File Permissions

All Jamini-created files and directories use restrictive permissions:

| Path | Permissions |
|------|-------------|
| `~/.jamini/` | `0700` |
| `~/.jamini/config.json` | `0600` |
| `~/.jamini/run/` | `0700` |
| `~/.jamini/run/.local-proxy-key` | `0600` |
| `~/.jamini/run/bridge.pid` | `0600` |
| `~/.jamini/log/` | `0700` |
| `~/.jamini/log/*.log` | `0600` |
| `~/.jamini/gemini-cli-home/` | `0700` |
| `~/.jamini/gemini-cli-home/settings.json` | `0600` |

## No Silent Provider Fallback

- If DeepSeek is unreachable, the bridge returns errors — it never silently falls back to Google Gemini.
- If the bridge fails to start, Jamini reports the error clearly.
- Auto mode never silently chooses a less-compatible or less-secure translator.
- Unsupported models are rejected with a clear error message, not silently routed.

## No Hidden Telemetry

- Gemini CLI telemetry is disabled by default in the generated settings (`usageStatisticsEnabled: false`).
- Jamini itself has no telemetry or phone-home behavior.
- No analytics, crash reports, or usage data is sent anywhere.
