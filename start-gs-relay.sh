#!/usr/bin/env bash
# Start the gs bridge WITH the public relay uplink, reading the token from a file
# so it never has to be pasted into a chat or a shell history.
#
#   echo -n '<relay token>' > ~/.commandant_relay_token && chmod 600 ~/.commandant_relay_token
#   ./start-gs-relay.sh
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

if [ ! -s "$TOKEN_FILE" ]; then
  echo "no token at $TOKEN_FILE — starting WITHOUT the relay uplink (local only)." >&2
  exec env -u COMMANDANT_RELAY -u COMMANDANT_RELAY_TOKEN \
    sh -c "cd '$GS_DIR' && uv run python -u -m gs --flight-id '$FLIGHT_ID'"
fi

pkill -f "python -u -m gs" 2>/dev/null || true
sleep 3
cd "$GS_DIR"
COMMANDANT_RELAY="wss://commandant-relay.fly.dev/publish" \
COMMANDANT_RELAY_TOKEN="$(cat "$TOKEN_FILE")" \
exec uv run python -u -m gs --flight-id "$FLIGHT_ID"
