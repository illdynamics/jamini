#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[smoke:deepseek] %s\n' "$*" >&2; }

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  log 'DEEPSEEK_API_KEY missing; skipping direct provider smoke test'
  exit 0
fi

log 'testing direct DeepSeek /chat/completions'
response="$(curl --silent --show-error --fail \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Return exactly: deepseek-direct-ok"}],
    "thinking": {"type": "disabled"},
    "stream": false
  }' \
  https://api.deepseek.com/chat/completions)"

if grep -q 'deepseek-direct-ok' <<<"$response"; then
  log 'direct provider smoke test passed'
  exit 0
fi

printf '%s\n' "$response"
log 'direct provider smoke test failed'
exit 1
