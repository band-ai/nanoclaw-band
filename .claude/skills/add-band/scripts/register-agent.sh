#!/usr/bin/env bash
#
# Register a Band external agent from a Band API key, using only curl + a JSON
# parser. A portable, dependency-light alternative to the Hermes plugin's
# hermes_band_platform/skills/add-band/scripts/register_agent.py: no Python SDK,
# no hermes_cli, no cloned repo — so a bootstrap can mint a Band agent before it
# installs anything (the same shape openclaw/bootstrap.sh uses).
#
# Security: the key is read from $BAND_API_KEY (or its alias $BAND_USER_API_KEY,
# never an argument) and handed to
# curl through a --config heredoc on stdin, so it never appears in any process's
# argv (`ps`). Only the returned agent-scoped id + key are printed; the Band API
# key is never echoed.
#
# Output (stdout — capture- / eval-able):
#   BAND_AGENT_ID=<uuid>
#   BAND_AGENT_API_KEY=<agent-key>
#
# Usage:
#   export BAND_API_KEY=...                  # or BAND_USER_API_KEY, or paste at the prompt
#   eval "$(scripts/register-agent.sh)"      # prompts for name + description, then
#                                            # sets BAND_AGENT_ID + BAND_AGENT_API_KEY
#   eval "$(scripts/register-agent.sh --name MyBot --description 'A helpful bot')"
#
# Flags (both optional; a flag skips its prompt):
#   -n, --name NAME            agent name
#   -d, --description DESC     agent description
#   -h, --help                 show usage and exit
#
# Env knobs: BAND_BASE_URL (default https://app.band.ai),
#            BAND_AGENT_NAME, BAND_AGENT_DESCRIPTION (set either to skip its
#            prompt), BAND_USER_AGENT.
set -euo pipefail

name_default="Band agent"
desc_default="An agent on the Band platform."

usage() {
  cat <<USAGE
Register a Band external agent from your Band API key.

Usage:
  register-agent.sh [--name NAME] [--description DESC]

Options:
  -n, --name NAME            agent name (prompted if omitted)
  -d, --description DESC     agent description (prompted if omitted)
  -h, --help                 show this help and exit

The Band API key is read from \$BAND_API_KEY (or \$BAND_USER_API_KEY), or
pasted at the prompt.
USAGE
}

# JSON-escape a string (backslash first, then double-quote) so a user-typed
# name/description with quotes can't break the request body below.
json_escape() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }

base="${BAND_BASE_URL:-https://app.band.ai}"; base="${base%/}"
ua="${BAND_USER_AGENT:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36}"

# Name/description precedence: CLI flag > env var > interactive prompt > default.
# A pre-set env var counts as "provided" so existing non-interactive callers
# (CI, bootstraps) keep their no-prompt behavior.
name="${BAND_AGENT_NAME:-}";        [ -n "$name" ] && name_set=1 || name_set=0
desc="${BAND_AGENT_DESCRIPTION:-}"; [ -n "$desc" ] && desc_set=1 || desc_set=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--name)
      [ $# -ge 2 ] || { echo "band: $1 needs a value right after it, e.g. $1 \"My agent\"" >&2; exit 2; }
      name="$2"; name_set=1; shift 2 ;;
    --name=*)        name="${1#*=}"; name_set=1; shift ;;
    -d|--description)
      [ $# -ge 2 ] || { echo "band: $1 needs a value right after it, e.g. $1 \"A helpful bot\"" >&2; exit 2; }
      desc="$2"; desc_set=1; shift 2 ;;
    --description=*) desc="${1#*=}"; desc_set=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "band: don't recognize \"$1\" — run with --help to see the options." >&2; usage >&2; exit 2 ;;
  esac
done

# Prompt for any value not supplied by a flag or env var. Prompts write to
# /dev/tty (not stdout), so they never pollute the eval-able output below;
# pressing Enter accepts the bracketed default. The `( : >/dev/tty )` probe
# confirms the terminal is actually openable (a bare `[ -r /dev/tty ]` passes
# on the device node even when no tty is attached) — with none (CI, curl|bash
# without a terminal), fall back to the defaults silently.
if { [ "$name_set" -eq 0 ] || [ "$desc_set" -eq 0 ]; } && ( : >/dev/tty ) 2>/dev/null; then
  printf "Let's set up your Band agent. Press Enter to keep the default in [brackets].\n" >/dev/tty
  if [ "$name_set" -eq 0 ]; then
    printf "  Agent handle on Band [%s]: " "$name_default" >/dev/tty
    IFS= read -r reply </dev/tty || reply=""
    name=${reply:-$name_default}
  fi
  if [ "$desc_set" -eq 0 ]; then
    printf "  A description helps other agents discover it on Band.\n" >/dev/tty
    printf "  Description [%s]: " "$desc_default" >/dev/tty
    IFS= read -r reply </dev/tty || reply=""
    desc=${reply:-$desc_default}
  fi
fi
name=${name:-$name_default}
desc=${desc:-$desc_default}

# Read the Band API key: prompt on /dev/tty when unset (curl|bash makes stdin the
# script), or accept a pre-set BAND_API_KEY (BAND_USER_API_KEY is honored as an
# alias). The prompt writes to /dev/tty, not stdout, so it never pollutes the
# eval-able output above.
: "${BAND_API_KEY:=${BAND_USER_API_KEY:-}}"
if [ -z "${BAND_API_KEY:-}" ]; then
  [ -r /dev/tty ] || { echo "band: no terminal here to ask on — set BAND_API_KEY and run again." >&2; exit 1; }
  printf 'Paste your Band API key (hidden as you type): ' >/dev/tty
  IFS= read -r -s BAND_API_KEY </dev/tty
  printf '\n' >/dev/tty
fi
[ -n "${BAND_API_KEY:-}" ] || { echo "band: a Band API key (with agent-create scope) is required to continue." >&2; exit 1; }

req_body=$(printf '{"agent":{"name":"%s","description":"%s"}}' "$(json_escape "$name")" "$(json_escape "$desc")")

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

printf 'BAND_AGENT_ID=%s\nBAND_AGENT_API_KEY=%s\n' "$id" "$key"
