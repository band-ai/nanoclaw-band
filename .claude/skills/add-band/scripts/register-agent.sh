#!/usr/bin/env bash
#
# Register a Band external agent from a Band API key, using only curl + a JSON
# parser. A portable, dependency-light way to mint a Band agent before anything
# else is installed: no Python SDK, no cloned repo.
#
# Security: the key is read from $BAND_API_KEY (never an argument) and handed to
# curl through a --config heredoc on stdin, so it never appears in any process's
# argv (`ps`). Only the returned agent-scoped id + key are printed; the Band API
# key is never echoed.
#
# Output (stdout — capture- / eval-able). These are the EXACT names the adapter
# reads (src/modules/band-config.ts): BAND_AGENT_ID + BAND_API_KEY. The emitted
# BAND_API_KEY is the agent-scoped key and replaces the create-scope key you
# pasted below — persist it in .env.
#   BAND_AGENT_ID=<uuid>
#   BAND_API_KEY=<agent-scoped-key>
#
# Usage:
#   export BAND_API_KEY=...                  # your CREATE-scope key, or paste at the prompt
#   eval "$(scripts/register-agent.sh)"      # sets BAND_AGENT_ID + BAND_API_KEY (agent-scoped)
#
# Env knobs: BAND_BASE_URL (default https://app.band.ai),
#            BAND_AGENT_NAME, BAND_AGENT_DESCRIPTION, BAND_USER_AGENT.
set -euo pipefail

base="${BAND_BASE_URL:-https://app.band.ai}"; base="${base%/}"
name="${BAND_AGENT_NAME:-Band agent}"
desc="${BAND_AGENT_DESCRIPTION:-Agent on Band}"
ua="${BAND_USER_AGENT:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36}"
# Read the Band API key: prompt on /dev/tty when unset (curl|bash makes stdin the
# script), or accept a pre-set BAND_API_KEY. The prompt writes to /dev/tty, not
# stdout, so it never pollutes the eval-able output above.
if [ -z "${BAND_API_KEY:-}" ]; then
  [ -r /dev/tty ] || { echo "band: set BAND_API_KEY (no terminal to prompt on)" >&2; exit 1; }
  printf 'Paste your Band API key: ' >/dev/tty
  IFS= read -r -s BAND_API_KEY </dev/tty
  printf '\n' >/dev/tty
fi
[ -n "${BAND_API_KEY:-}" ] || { echo "band: Band API key (agent-create scope) required" >&2; exit 1; }

req_body=$(printf '{"agent":{"name":"%s","description":"%s"}}' "$name" "$desc")

# Only the secret X-API-Key header goes through stdin (-K -), never argv.
resp=$(curl -sS -X POST "$base/api/v1/me/agents/register" \
  -H "User-Agent: $ua" \
  -H "Accept: application/json, text/plain, */*" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Content-Type: application/json" -d "$req_body" -w $'\n%{http_code}' -K - <<EOF
header = "X-API-Key: $BAND_API_KEY"
EOF
) || true

code=${resp##*$'\n'}
out=${resp%$'\n'*}
case "$code" in
  200 | 201) ;;
  *) echo "band: registration failed (HTTP ${code:-?}): $(printf '%.300s' "$out")" >&2; exit 1 ;;
esac

# Pull the agent id + key from the response shapes Band may return.
if command -v jq >/dev/null 2>&1; then
  id=$(printf '%s' "$out" | jq -r '.data.agent.id // .agent.id // .data.id // .agent_id // .id // empty')
  key=$(printf '%s' "$out" | jq -r '.data.credentials.api_key // .credentials.api_key // .data.api_key // .api_key // .key // .token // empty')
elif command -v python3 >/dev/null 2>&1; then
  read -r id key < <(printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
def g(*path):
    cur = d
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur
i = g("data","agent","id") or g("agent","id") or g("data","id") or d.get("agent_id") or d.get("id") or ""
k = g("data","credentials","api_key") or g("credentials","api_key") or g("data","api_key") or d.get("api_key") or d.get("key") or d.get("token") or ""
print(str(i).strip(), str(k).strip())
')
else
  echo "band: need jq or python3 to parse the registration response" >&2
  exit 1
fi

[ -n "${id:-}" ] && [ -n "${key:-}" ] || {
  echo "band: registration response missing agent id/key" >&2
  exit 1
}

printf 'BAND_AGENT_ID=%s\nBAND_API_KEY=%s\n' "$id" "$key"
