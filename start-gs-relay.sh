#!/usr/bin/env bash
# Start the gs bridge WITH the public relay uplink, reading the token from a file
# so it never has to be pasted into a chat or a shell history.
#
#   echo -n '<relay token>' > ~/.commandant_relay_token && chmod 600 ~/.commandant_relay_token
#   ./start-gs-relay.sh
set -euo pipefail
TOKEN_FILE="${COMMANDANT_RELAY_TOKEN_FILE:-$HOME/.commandant_relay_token}"
GS_DIR=/Users/ezzatsuhaime/Documents/Commandant/.claude/worktrees/mission-upload-and-editing/packages/gs
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
