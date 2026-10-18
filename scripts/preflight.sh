#!/usr/bin/env bash
# Everything that can be checked without an aircraft, in one command.
#
# This is the gate to run before a SITL session, a HITL session, or a flight —
# which is why it is one command and not seven. Each stage prints a line, and a
# failure prints its tail, because a stack trace three stages up is the thing
# you actually need.
#
#   ./scripts/preflight.sh            # suites, types, production build
#   ./scripts/preflight.sh --soak     # and the simulated-radio rehearsals (~2 min)
#
# What it deliberately does NOT do is talk to an autopilot. For that:
#   cd packages/gs && uv run python scripts/day_in_the_life.py \
#       --attach auto --net --wait-ready
set -uo pipefail
cd "$(dirname "$0")/.."
SOAK=0; [ "${1:-}" = "--soak" ] && SOAK=1
FAILED=()

stage() {
  local name="$1"; shift
  printf '  %-32s' "$name"
  local out
  if out=$("$@" 2>&1); then
    printf 'ok    %s\n' "$(printf '%s' "$out" | tail -1 | cut -c1-42)"
  else
    printf 'FAIL\n'
    printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
    FAILED+=("$name")
  fi
}

echo
echo "preflight — everything checkable without an aircraft"
echo
stage "gs protocol suite"   sh -c 'cd packages/gs && uv run pytest -q'
stage "relay suite"         sh -c 'cd packages/relay && uv run pytest -q'
# The hub installer. It provisions the field deployment and has never run on
# hardware, so the parts that are pure logic are the only ones a gate can hold.
stage "cli hub suite"       sh -c 'cd packages/cli && uv run --group dev pytest -q'
stage "console suite"       sh -c 'cd packages/console && npm test --silent'
stage "console typecheck"   sh -c 'cd packages/console && npm run typecheck --silent'
stage "console prod build"  sh -c 'cd packages/console && npm run build'
# The Cesium minifier bug only a production build surfaces: a chunk that does
# not parse means the page never mounts, and a dev build cannot see it.
stage "every chunk parses"  sh -c 'cd packages/console && out=$(find .next/static/chunks -name "*.js" -exec node --check {} \; 2>&1); [ -z "$out" ] && echo "all chunks parse" || { echo "$out"; exit 1; }'
stage "telemetry frame"     sh -c 'cd packages/gs && uv run python scripts/frame_diff.py --ref origin/main 2>/dev/null | tail -1'

if [ "$SOAK" = 1 ]; then
  echo
  echo "  simulated-radio rehearsals"
  stage "day in the life (fat pipe)"  sh -c 'cd packages/gs && uv run python scripts/day_in_the_life.py --net --wait-ready --reboot 2>/dev/null | tail -1'
  stage "day in the life (5% loss)"   sh -c 'cd packages/gs && uv run python scripts/day_in_the_life.py --loss 0.05 --wait-ready 2>/dev/null | tail -1'
  stage "radio soak (one seed)"       sh -c 'cd packages/gs && uv run python scripts/radio_soak.py --seeds 1 --loss 0.05 --items 20 --budget 40 2>/dev/null | tail -1'
fi

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "  all stages passed"
  exit 0
fi
echo "  FAILED: ${FAILED[*]}"
exit 1
