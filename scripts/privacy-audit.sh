#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0; FAIL=0; WARN=0
pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; WARN=$((WARN + 1)); }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=============================================="
echo " Jamini Privacy Audit"
echo " $(date)"
echo "=============================================="
echo ""

# ── Check 1: Blocked domains in source ─────────────────────────────
echo "--- Check 1: Blocked Google/Gemini domains ---"
BLOCKED_DOMAINS=(
  "generativelanguage.googleapis.com"
  "aiplatform.googleapis.com"
  "oauth2.googleapis.com"
  "accounts.google.com"
  "play.googleapis.com"
  "logging.googleapis.com"
  "monitoring.googleapis.com"
  "cloudtrace.googleapis.com"
  "telemetry.googleapis.com"
  "firebaseinstallations.googleapis.com"
  "firebase-settings.crashlytics.com"
  "crashlyticsreports-pa.googleapis.com"
  "analytics.google.com"
  "google-analytics.com"
  "www.google-analytics.com"
  "stats.g.doubleclick.net"
  "doubleclick.net"
)

for domain in "${BLOCKED_DOMAINS[@]}"; do
  hits=$(grep -rl "$domain" \
    --include='*.ts' --include='*.js' --include='*.json' --include='*.md' \
    src/ config/ bin/ scripts/ \
    2>/dev/null | grep -vE 'privacy-audit|PRIVACY_LOCKDOWN|\.test\.ts$' || true)

  if [ -n "$hits" ]; then
    for hit in $hits; do
      fail "Blocked domain found outside denylist: $domain in $hit"
    done
  else
    pass "No unapproved reference to: $domain"
  fi
done

# ── Check 2: Telemetry library references ───────────────────────────
echo ""
echo "--- Check 2: Telemetry/analytics libraries ---"
TELEMETRY_TERMS=(
  "opentelemetry"
  "@opentelemetry"
  "otel"
  "clearcut"
  "crashlytics"
  "firebase-analytics"
  "google-analytics"
  "sentry"
  "@sentry"
  "datadog"
  "dd-trace"
  "newrelic"
  "new-relic"
  "posthog"
  "segment"
  "amplitude"
  "mixpanel"
  "bugsnag"
  "rollbar"
  "update-notifier"
)

for term in "${TELEMETRY_TERMS[@]}"; do
  hits=$(grep -rl "$term" \
    --include='*.ts' --include='*.js' --include='*.json' \
    src/ config/ bin/ \
    2>/dev/null | grep -vE '\.test\.ts$' || true)

  if [ -n "$hits" ]; then
    for hit in $hits; do
      if grep -q "BLOCKED\|denylist\|blocklist\|disabled\|DISABLED\|privacy\|PRIVACY\|REDACT" "$hit" 2>/dev/null; then
        pass "Telemetry term '$term' in $hit (in denylist/blocking context)"
      else
        warn "Telemetry term '$term' found in $hit (verify it's not active)"
      fi
    done
  else
    pass "No telemetry library reference: $term"
  fi
done

# ── Check 3: Dependencies audit ─────────────────────────────────────
echo ""
echo "--- Check 3: Dependency audit ---"
PKG_JSON="$REPO_ROOT/package.json"

if grep -qE '"sentry"|"datadog"|"newrelic"|"posthog"|"segment"|"amplitude"|"mixpanel"|"bugsnag"|"rollbar"|"opentelemetry"|"@opentelemetry"' "$PKG_JSON" 2>/dev/null; then
  fail "Telemetry SDK found in package.json dependencies"
else
  pass "No telemetry SDKs in package.json dependencies"
fi

if grep -q "@google/gemini-cli" "$PKG_JSON" 2>/dev/null; then
  warn "@google/gemini-cli is a required dependency (wrapping target). Ensure telemetry is suppressed."
else
  pass "No unexpected Google dependencies"
fi

# ── Check 4: Config defaults ────────────────────────────────────────
echo ""
echo "--- Check 4: Config defaults ---"
CONFIG_TS="$REPO_ROOT/src/config.ts"
if [ -f "$CONFIG_TS" ]; then
  if grep -q "historyMode.*ephemeral" "$CONFIG_TS" 2>/dev/null; then
    pass "Config default: historyMode = ephemeral"
  else
    warn "Config: historyMode may not default to ephemeral"
  fi
fi

# ── Check 5: Settings path correct ─────────────────────────────────
echo ""
echo "--- Check 5: Settings path verification ---"
CLI_TS="$REPO_ROOT/src/cli.ts"
if [ -f "$CLI_TS" ]; then
  if grep -q "'.gemini'" "$CLI_TS" 2>/dev/null && grep -q "'settings.json'" "$CLI_TS" 2>/dev/null; then
    pass "Settings path: .gemini/settings.json found in cli.ts"
  else
    fail "Settings path: .gemini/settings.json NOT found in cli.ts"
  fi
fi

# ── Check 6: No inherited process.env spawning ────────────────────
echo ""
echo "--- Check 6: No inherited process.env in child process spawn ---"
if [ -f "$CLI_TS" ]; then
  SPAWN_SPREADS=$(grep -c "\.\.\.process\.env" "$CLI_TS" 2>/dev/null || echo "0")
  if [ "$SPAWN_SPREADS" -gt 0 ]; then
    warn "process.env spread found $SPAWN_SPREADS time(s) in cli.ts — verify safe context"
  else
    pass "No process.env spread in cli.ts child process env"
  fi
fi

# ── Check 7: Auto-update disabled ────────────────────────────────
echo ""
echo "--- Check 7: Auto-update disabled ---"
AUTO_UPDATE_TERMS=(
  "update-notifier"
  "auto-update"
  "checkForUpdates"
  "latest-version"
)

for term in "${AUTO_UPDATE_TERMS[@]}"; do
  hits=$(grep -rl "$term" \
    --include='*.ts' --include='*.js' --include='*.json' --include='*.sh' \
    src/ config/ bin/ scripts/ \
    2>/dev/null | grep -vE 'privacy-audit|PRIVACY_LOCKDOWN|\.test\.ts$' || true)
  if [ -n "$hits" ]; then
    for hit in $hits; do
      if grep -q "DISABLED\|BLOCKED\|privacy\|NO_UPDATE\|DISABLE\|defense\|blocklist" "$hit" 2>/dev/null; then
        pass "Auto-update term '$term' in $hit (in blocking context)"
      else
        warn "Auto-update term '$term' found in $hit"
      fi
    done
  else
    pass "No auto-update reference: $term"
  fi
done

# ── Check 8: Environment variable telemetry blocking ────────────────
echo ""
echo "--- Check 8: Environment variable telemetry blocking ---"
TELEMETRY_ENV_CHECKS=(
  "GEMINI_TELEMETRY_ENABLED.*false"
  "OTEL_SDK_DISABLED.*true"
  "NO_UPDATE_NOTIFIER.*1"
)

for pattern in "${TELEMETRY_ENV_CHECKS[@]}"; do
  if grep -rq "$pattern" --include='*.ts' src/ 2>/dev/null; then
    pass "Telemetry env var blocked: $pattern"
  else
    warn "Telemetry env var not explicitly blocked in src/: $pattern"
  fi
done

# ── Check 9: Bridge egress blocklist ─────────────────────────────────
echo ""
echo "--- Check 9: Bridge network egress blocklist ---"
SERVER_TS="$REPO_ROOT/bridge/src/server.ts"
if [ -f "$SERVER_TS" ]; then
  if grep -q "GOOGLE_HOST_BLOCKLIST" "$SERVER_TS" 2>/dev/null; then
    pass "Network egress blocklist present in bridge server"
  else
    warn "No GOOGLE_HOST_BLOCKLIST found in bridge server"
  fi
  if grep -q "isBlockedHost" "$SERVER_TS" 2>/dev/null; then
    pass "isBlockedHost function present in bridge server"
  else
    warn "No isBlockedHost function in bridge server"
  fi
  if grep -q "GOOGLE_URL_PATTERNS\|isBlockedUrlPath" "$SERVER_TS" 2>/dev/null; then
    pass "URL path blocking present in bridge server"
  else
    warn "No URL path blocking in bridge server"
  fi
  if grep -q "ya29\|googleusercontent" "$SERVER_TS" 2>/dev/null; then
    pass "OAuth/ADC token blocking present in bridge server"
  else
    warn "No OAuth/ADC token blocking in bridge server"
  fi
  if grep -q "feedback.*disabled\|feedback.*403\|DISABLED.*feedback" "$SERVER_TS" 2>/dev/null; then
    pass "Feedback endpoints disabled in bridge server"
  else
    warn "No feedback endpoint disabling found"
  fi
fi

# ── Check 10: Version pinning ───────────────────────────────────────
echo ""
echo "--- Check 10: Version pinning ---"
if [ -f "$PKG_JSON" ]; then
  # Count caret ranges in dependencies (should be zero for privacy-critical)
  CARET_COUNT=$(grep -c '"\^' "$PKG_JSON" 2>/dev/null || echo "0")
  if [ "$CARET_COUNT" -eq 0 ]; then
    pass "No caret ranges in package.json (all versions pinned)"
  else
    warn "$CARET_COUNT caret range(s) in package.json — consider pinning"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo " Privacy Audit Summary"
echo "=============================================="
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}❌ PRIVACY AUDIT FAILED — $FAIL issue(s) found${NC}"
  exit 1
else
  echo -e "${GREEN}✅ PRIVACY AUDIT PASSED${NC}"
  exit 0
fi
