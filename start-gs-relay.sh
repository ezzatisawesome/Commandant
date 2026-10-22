#!/usr/bin/env bash
# Start the gs bridge WITH the public relay uplink, reading the token from a file
# so it never has to be pasted into a chat or a shell history.
#
#   echo -n '<relay token>' > ~/.commandant_relay_token && chmod 600 ~/.commandant_relay_token
#   ./start-gs-relay.sh [flight-id]
set -euo pipefail
TOKEN_FILE="${COMMANDANT_RELAY_TOKEN_FILE:-$HOME/.commandant_relay_token}"
# Found relative to this script, not written down. The path here was absolute and
# pointed into a git worktree (.claude/worktrees/mission-upload-and-editing) that
# was removed some time ago, so this script had been broken on every machine
# including the one it was written on -- it would cd into nothing and exit. It
# got there by `git add -A` sweeping up a scratch file.
GS_DIR="${GS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/packages/gs}"
if [ ! -d "$GS_DIR" ]; then
  echo "no gs package at $GS_DIR (set GS_DIR to override)" >&2
  exit 1
fi
FLIGHT_ID="${1:-coyote-hill-live}"

# Stopping the old daemon is NOT optional on the uplink path only -- it was
# written that way and the local-only branch `exec`ed before ever reaching it,
# so `./start-gs-relay.sh` with no token file started a SECOND gs on top of the
# running one. Both then probe the same radio and race for ws port 8790, and
# PX4 latches one GCS address per channel (see packages/gs/scripts/px4_sitl.sh).
# One function, called on both paths, before either exec.
stop_running_gs() {
  # Prefer the service manager where there is one: on a field hub gs runs from
  # gs.service with Restart=always, so killing the process just brings it
  # straight back and the pattern below would race its respawn forever.
  if command -v systemctl >/dev/null 2>&1 \
     && systemctl list-unit-files gs.service >/dev/null 2>&1 \
     && systemctl is-active --quiet gs.service; then
    echo "stopping gs.service" >&2
    systemctl stop gs.service || sudo systemctl stop gs.service
    return
  fi
  # Pattern match as the fallback. `python -u -m gs` was the pattern and it
  # cannot match the unit's own ExecStart, which has no `-u` -- so on the hub
  # this silently left the old daemon running. Match the module invocation with
  # the buffering flag optional, and anchor on `python` so a `less` or an editor
  # sitting on that command line is not a candidate.
  local pattern='python([0-9.]*)? (-u )?-m gs( |$)'
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  # Never count this script, its subshells, or the pgrep itself.
  pids="$(echo "$pids" | tr ' ' '\n' | grep -v "^$$\$" | grep -v '^$' || true)"
  [ -z "$pids" ] && return
  echo "stopping gs: $(echo "$pids" | tr '\n' ' ')" >&2
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  # `sleep 3` and hope was the old behaviour. A gs flushing a tlog tail to a
  # Pi's SD card can take longer than that, and the new instance then dies on
  # bind with "address already in use" -- so wait for the exit we asked for,
  # and escalate rather than guess.
  local waited=0
  while [ "$waited" -lt 100 ]; do
    pgrep -f "$pattern" >/dev/null 2>&1 || return
    sleep 0.1
    waited=$((waited + 1))
  done
  echo "gs did not exit after 10s; sending SIGKILL" >&2
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
  sleep 0.5
}

stop_running_gs
cd "$GS_DIR"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "no token at $TOKEN_FILE — starting WITHOUT the relay uplink (local only)." >&2
  # No `sh -c "... '$FLIGHT_ID'"` here any more. That interpolated the argument
  # into a shell string, so an apostrophe in a flight id -- a ridge named after
  # somebody, or a paste accident -- closed the quote and ran the remainder as
  # a command. `cd` above plus a direct exec needs no quoting at all.
  exec env -u COMMANDANT_RELAY -u COMMANDANT_RELAY_TOKEN \
    uv run python -u -m gs --flight-id "$FLIGHT_ID"
fi

# The token goes in the environment, never in argv: `ps` shows argv to every
# user on the box, and on a hub that includes the console's service account.
COMMANDANT_RELAY="wss://commandant-relay.fly.dev/publish" \
COMMANDANT_RELAY_TOKEN="$(cat "$TOKEN_FILE")" \
exec uv run python -u -m gs --flight-id "$FLIGHT_ID"
