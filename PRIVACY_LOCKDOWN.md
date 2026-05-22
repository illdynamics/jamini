# Jamini Privacy Lockdown

This document describes all privacy hardening applied to Jamini to ensure no data is sent to Google, Gemini, Vertex AI, or any telemetry/tracking services.

## What Is Blocked

### Network Egress
All outbound connections to Google/Gemini hostnames are blocked at the bridge level:

- `generativelanguage.googleapis.com`
- `aiplatform.googleapis.com`
- `oauth2.googleapis.com`
- `accounts.google.com`
- `play.googleapis.com`
- `logging.googleapis.com`
- `monitoring.googleapis.com`
- `cloudtrace.googleapis.com`
- `telemetry.googleapis.com`
- `firebaseinstallations.googleapis.com`
- `firebase-settings.crashlytics.com`
- `crashlyticsreports-pa.googleapis.com`
- `analytics.google.com`
- `google-analytics.com`
- `www.google-analytics.com`
- `stats.g.doubleclick.net`
- `doubleclick.net`
- `gstatic.com`
- `googleapis.com`
- `googleusercontent.com`
- `google.com`

### Model/API Routes
The bridge rejects any request where:
- Model contains "gemini", "google", "vertex", "palm", or "bison"
- URL path targets Gemini-native endpoints (`/v1/models/gemini*`, `/v1beta/models/gemini*`, etc.)
- Auth mode uses Google OAuth or Application Default Credentials

### Telemetry & OpenTelemetry
All telemetry is force-disabled through environment variables in child process:

- `GEMINI_TELEMETRY_ENABLED=false`
- `GEMINI_TELEMETRY_LOG_PROMPTS=false`
- `GEMINI_TELEMETRY_USE_COLLECTOR=false`
- `GEMINI_TELEMETRY_USE_CLI_AUTH=false`
- `GEMINI_TELEMETRY_OTLP_ENDPOINT=` (empty)
- `GEMINI_TELEMETRY_TARGET=local`
- `OTEL_SDK_DISABLED=true`
- `OTEL_TRACES_EXPORTER=none`
- `OTEL_METRICS_EXPORTER=none`
- `OTEL_LOGS_EXPORTER=none`
- All `OTEL_EXPORTER_OTLP_*` endpoints set to empty

### Analytics/Tracking SDKs
All analytics and error tracking SDK environment variables are blanked:

- `SENTRY_DSN=` (empty)
- `DD_API_KEY=` (empty)
- `DD_APP_KEY=` (empty)
- `NEW_RELIC_LICENSE_KEY=` (empty)
- `POSTHOG_API_KEY=` (empty)
- `SEGMENT_WRITE_KEY=` (empty)
- `AMPLITUDE_API_KEY=` (empty)
- `MIXPANEL_TOKEN=` (empty)
- `BUGSNAG_API_KEY=` (empty)
- `ROLLBAR_ACCESS_TOKEN=` (empty)

### Gemini CLI Settings
The Gemini CLI settings file is written to the correct path: `$GEMINI_CLI_HOME/.gemini/settings.json` with:

```json
{
  "privacy": { "usageStatisticsEnabled": false },
  "telemetry": {
    "enabled": false,
    "logPrompts": false,
    "target": "local",
    "otlpEndpoint": ""
  }
}
```

### Auto-Update
All automatic update mechanisms are disabled:
- `NO_UPDATE_NOTIFIER=1`
- `NPM_CONFIG_UPDATE_NOTIFIER=false`
- `NPM_CONFIG_AUDIT=false`
- `NPM_CONFIG_FUND=false`
- Dependencies pinned to exact versions (no ^ or ~ ranges)

### Persistent History
History mode defaults to `ephemeral` (memory-only, wiped on exit).
Set `JAMINI_HISTORY_MODE=local` to opt into local-only persistent history.
History files, if created, use 0700/0600 permissions and are never synced.

### Logging
- Default log level is `error` for the CLI
- All API keys, tokens, and secrets are redacted from logs
- Logs are written to `$JAMINI_HOME/log/` with mode 0700/0600
- No prompts, completions, or file contents are logged

### Feedback
All feedback endpoints are disabled. Any feedback mechanism is no-op by default.

### Environment Isolation
- Child processes (Gemini CLI, bridge) receive an **explicit allowlist** of environment variables
- Parent process environment is **not inherited** — only explicitly safe vars are passed
- Google/Gemini/Vertex auth variables are force-blanked or set to false

## What Is Still Allowed

- DeepSeek API calls to `https://api.deepseek.com` (configurable via `DEEPSEEK_BASE_URL`)
- Local bridge communication on `127.0.0.1` only
- Brave Search API (opt-in, requires `BRAVE_API_KEY`)
- Unstructured API (opt-in, requires `UNSTRUCTURED_API_KEY`)
- Gemini CLI binary execution (as wrapper target — telemetry suppressed via env vars and settings)
- Local-only persistent history (opt-in via `JAMINI_HISTORY_MODE=local`)

## How to Verify

### Run Privacy Audit
```bash
npm run privacy:audit
```

### Run Privacy Tests
```bash
npm run test:privacy
```

### Run Full Test Suite
```bash
npm test
```

### Monitor with Packet Capture
```bash
sudo tcpdump -i any -n 'host generativelanguage.googleapis.com or host aiplatform.googleapis.com or host oauth2.googleapis.com'
```

Expected result: **Zero packets**.

### Verify No Telemetry Libraries
```bash
npm ls --production 2>/dev/null | grep -iE "sentry|datadog|newrelic|posthog|amplitude|mixpanel|bugsnag|rollbar|opentelemetry|firebase|google-analytics"
```

Expected result: **No matches**.

## How to Wipe Local Data
```bash
rm -rf ~/.jamini
```

To wipe only history:
```bash
rm -rf ~/.jamini/history
```

## How to Manually Update
```bash
git pull origin main
npm ci --no-audit --no-fund
npm run build
```

Auto-update is disabled. Manual updates only.

## Warnings

### Google Account-Level Settings
Jamini cannot control Google account-level Gemini Apps activity settings. If you use Gemini directly (outside Jamini), you must separately disable:

- [Gemini Apps Activity](https://myactivity.google.com/product/gemini)
- [Google Account History settings](https://myaccount.google.com/data-and-privacy)

### DeepSeek Privacy
DeepSeek processes prompts and completions on their servers. Jamini cannot control DeepSeek's data handling. Review DeepSeek's privacy policy for their data practices.

### Local Bridge Security
The Jamini bridge listens on 127.0.0.1 only and requires a local API key. Ensure no other local processes can access the bridge port.

## Defense-in-Depth Layers

| Layer | Description |
|-------|-------------|
| 1. Environment variable lockdown | Child processes receive explicit allowlist, not inherited env |
| 2. Settings file | Correct path (`.gemini/settings.json`) with 0700/0600 permissions |
| 3. Network egress blocking | 21 Google hostnames blocked in bridge before outbound calls |
| 4. Axios monkey-patch | Every axios request validated against blocklist |
| 5. Model denylist | 11 regex patterns blocking Google/Gemini/Vertex model names |
| 6. URL path blocking | 18 regex patterns blocking Gemini-native API paths |
| 7. Auth blocking | OAuth (ya29.) and ADC tokens rejected with 403 |
| 8. Log redaction | API keys, tokens, secrets scrubbed from all log output |
| 9. No auto-update | Version checks, update notifier, npm audit all disabled |
| 10. Ephemeral history | No persistent data without explicit opt-in |
| 11. Privacy audit script | Automated verification of all above layers |
| 12. CI-enforceable tests | Vitest suite validates privacy guarantees |

## Failure Modes

If the bridge detects an attempted Google/Gemini connection:
- The connection is **blocked**
- Error logged: `[PRIVACY] Blocked outbound request to blocked host: <hostname>`
- The request **fails closed** (no data is sent)

If an unsupported model is requested:
- Request rejected with HTTP 403
- Error: `Blocked Google/Gemini route by privacy policy. Jamini is configured for DeepSeek-only operation.`

If OAuth or ADC auth is attempted:
- Request rejected with HTTP 403
- Error: `Blocked Google OAuth authentication by privacy policy.`

---

*Applied to Jamini v0.2.3+*

