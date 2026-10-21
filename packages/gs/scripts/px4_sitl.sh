#!/usr/bin/env bash
# Build and run REAL PX4 for gs to talk to.
#
# Everything else in this repo tests against scripts/radio_soak.py's stand-in
# autopilot, which is written to the protocol as we understand it -- so it can
# only ever confirm our own reading. Pointing gs at the actual firmware found
# four faults in an afternoon that five passes against the stand-in had not:
# chunked STATUSTEXT never reassembled, stream re-requests that never backed
# off, reboot detection that needed a position the vehicle was not sending, and
# parameter writes dropped for a type mismatch.
#
# No simulator is involved. PX4_SIM_MODEL=none boots the firmware with
# SYS_AUTOSTART=0: no airframe, no lockstep, no Gazebo -- and a complete MAVLink
# implementation, which is the part gs talks to. The vehicle will not fly, will
# not arm (it correctly refuses: "Resolve system health failures first"), and
# will not report a position. Everything else is real: 720 parameters, the
# mission/fence/rally protocols, command acks, reboots.
#
#   ./scripts/px4_sitl.sh build     # once, ~10 min
#   ./scripts/px4_sitl.sh run       # leaves PX4 listening on udp 14580
#   uv run python -m gs --mavlink udpout:127.0.0.1:14580
#
# NOTE: PX4 latches ONE ground station address per channel, so a second gs
# talking to it silently steals the link from the first. If telemetry stops,
# look for another gs before suspecting the code.
set -euo pipefail

ROOT="${PX4_DIR:-${TMPDIR:-/tmp}/PX4-Autopilot}"
BUILD="$ROOT/build/px4_sitl_nogz"

case "${1:-run}" in
build)
	[ -d "$ROOT" ] || git clone --depth 1 --recurse-submodules --shallow-submodules \
		https://github.com/PX4/PX4-Autopilot.git "$ROOT"
	cd "$ROOT"
	# The stock sitl target builds the Gazebo plugins, which need cppzmq and
	# gz-sim. We want the flight code, not a simulator, so drop them.
	sed -e 's/^CONFIG_MODULES_SIMULATION_GZ_MSGS=y/CONFIG_MODULES_SIMULATION_GZ_MSGS=n/' \
	    -e 's/^CONFIG_MODULES_SIMULATION_GZ_BRIDGE=y/CONFIG_MODULES_SIMULATION_GZ_BRIDGE=n/' \
	    -e 's/^CONFIG_MODULES_SIMULATION_GZ_PLUGINS=y/CONFIG_MODULES_SIMULATION_GZ_PLUGINS=n/' \
	    boards/px4/sitl/default.px4board > boards/px4/sitl/nogz.px4board
	uv venv .venv-px4 >/dev/null
	uv pip install -q --python .venv-px4/bin/python -r Tools/setup/requirements.txt
	PATH="$ROOT/.venv-px4/bin:$PATH" make px4_sitl_nogz
	echo "built: $BUILD/bin/px4"
	;;
run)
	[ -x "$BUILD/bin/px4" ] || { echo "not built yet: ./scripts/px4_sitl.sh build" >&2; exit 1; }
	WORK="$ROOT/run"
	rm -rf "$WORK" && mkdir -p "$WORK"
	cd "$WORK"
	echo "PX4 on udp 14580; connect with --mavlink udpout:127.0.0.1:14580"
	PX4_SIM_MODEL=none "$BUILD/bin/px4" -d -s "$BUILD/etc/init.d-posix/rcS" "$BUILD/etc"
	;;
*)
	echo "usage: $0 {build|run}" >&2; exit 2;;
esac
