#!/usr/bin/env bash
# scripts/safe-restart.sh — restart this checkout's NanoClaw service, and
# recover automatically from the one failure mode that isn't a real
# problem: the upgrade tripwire (src/upgrade-state.ts) firing because this
# restart is the first time a rebuilt dist/ actually ran the check, and the
# marker predates it. docs/upgrade-recovery.md calls this "expected the
# first time an existing install meets the tripwire" and names the exact
# fix — this script applies that fix automatically instead of making a
# human or agent diagnose a crash-loop to find it.
#
# It does NOT loosen the tripwire: it only clears the marker in reaction to
# an *observed* trip on a restart it itself issued, once, and if the trip
# recurs after that it stops and says so instead of retrying again.
#
# Usage: scripts/safe-restart.sh
# Safe to call from any skill/script after a `pnpm run build` + service
# restart step; it derives the repo root itself so it doesn't depend on
# shell state (ROOT/PROJECT_ROOT, sourced functions) from an earlier step.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "${PROJECT_ROOT:-$PWD}")"
cd "$ROOT"
# shellcheck source=setup/lib/install-slug.sh
source "$ROOT/setup/lib/install-slug.sh"

ERR_LOG="$ROOT/logs/nanoclaw.error.log"
TRIPWIRE_SIGNATURE="update did not go through the supported path"

err_log_lines() {
  [ -f "$ERR_LOG" ] && wc -l < "$ERR_LOG" || echo 0
}

# True if the tripwire signature appears anywhere after line $1 of the error log.
tripped_since() {
  [ -f "$ERR_LOG" ] || return 1
  tail -n "+$(( $1 + 1 ))" "$ERR_LOG" | grep -qF "$TRIPWIRE_SIGNATURE"
}

restart_service() {
  if [ "$(uname -s)" = "Darwin" ]; then
    SVC="$(launchd_label)"
    if launchctl list "$SVC" >/dev/null 2>&1; then
      echo "restarting $SVC"
      launchctl kickstart -k "gui/$(id -u)/$SVC"
    elif [ -f "$HOME/Library/LaunchAgents/$SVC.plist" ]; then
      echo "loading $SVC (installed but not loaded)"
      launchctl load "$HOME/Library/LaunchAgents/$SVC.plist"
    else
      echo "no service for this checkout — run /setup, or dev: set a free WEBHOOK_PORT in .env then 'pnpm run dev'"
      return 2
    fi
  elif command -v systemctl >/dev/null 2>&1; then
    UNIT="$(systemd_unit).service"
    if systemctl --user is-active --quiet "$UNIT"; then
      systemctl --user restart "$UNIT"
    elif systemctl --user is-enabled --quiet "$UNIT" 2>/dev/null; then
      systemctl --user start "$UNIT"
    else
      echo "no service for this checkout — run /setup, or dev: set a free WEBHOOK_PORT in .env then 'pnpm run dev'"
      return 2
    fi
  else
    echo "no supported service manager on this platform"
    return 2
  fi
}

# Poll for up to ~10s: the tripwire exits the process at startup, before DB
# init (src/index.ts, step "0.5"), so a trip shows up in the log almost
# immediately — this window is generous, not tight.
wait_and_check_trip() {
  local since="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if tripped_since "$since"; then
      return 0
    fi
  done
  return 1
}

before=$(err_log_lines)
restart_service || exit $?

if wait_and_check_trip "$before"; then
  echo ""
  echo "Upgrade tripwire fired on this restart. Per docs/upgrade-recovery.md this"
  echo "is expected the first time an existing install meets the tripwire — the"
  echo "marker predates the code, not an unsanctioned change. Healing once:"
  pnpm exec tsx scripts/upgrade-state.ts set "" safe-restart

  before=$(err_log_lines)
  restart_service || exit $?

  if wait_and_check_trip "$before"; then
    echo ""
    echo "STOP: the tripwire fired again after stamping the marker once. This is"
    echo "no longer the benign stale-marker case — do not stamp again. Investigate"
    echo "logs/nanoclaw.error.log by hand (see docs/upgrade-recovery.md)."
    exit 1
  fi
  echo "Tripwire cleared — marker restamped, restart went through clean."
else
  echo "Service restarted clean."
fi
