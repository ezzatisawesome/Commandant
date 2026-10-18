# Commandant

Flight/ops visualization for the solar airplane — a QGroundControl-style UI that
renders the aircraft as a 3D model on a Cesium globe, driven by live telemetry.
Built with **Next.js + React + Cesium + nanostores** (matching the Guppi platform
stack). The satellite-tracking view lives at `/satellites`.

## How it runs

Two processes plus the simulator. The **gs daemon** (`packages/gs`, Python +
pymavlink) owns the MAVLink link, the command/param/mission state machines, and
serves telemetry over a WebSocket. The **console** (`packages/console`, Next +
Cesium) is a thin client of that socket.

```
PX4 / sim ──MAVLink udp:14550──► gs daemon ──WebSocket :8790──► browser (/flight)
           ──JSON udp:14555────┘  (sim's no-PX4 flightlink path, merged in)
```

## Run

Terminal 1 — the daemon:

```sh
cd packages/gs
uv venv && uv pip install -e ".[dev]"        # first time
uv run python -m gs                           # autodetect in, ws://0.0.0.0:8790 out
```

Ask a running daemon what it decided — the field question, answered over ssh
rather than needing a browser:

```sh
uv run python -m gs --status          # or --ws-port, if it serves another
```

It prints the transport autodetect found, the budget derived from it, the param
strategy that follows, the vehicle sysid it locked onto, per-stream ages, what
is in flight, and the two things it survives silently: how often it has reopened
the link and how many handler exceptions it has swallowed. Both mean it is
working *and* telling you something.

`--mavlink` defaults to `auto`: gs probes the serial devices an autopilot shows
up on (PX4 over USB, then a telemetry radio), then `udp:14550` and `tcp:5760`,
and takes the first that heartbeats as an autopilot. **It cannot tell, and does
not care, whether that is PX4 SITL, a HITL rig or the aircraft** — the same
binary, no configuration, for all three. If nothing is up yet it listens on
`:14550` and re-probes on every reopen, so powering the plane on, or swapping
USB for the radio, needs no restart. Pass an explicit endpoint
(`--mavlink serial:/dev/ttyUSB0:57600`) to skip the probe.

The stream rates gs asks PX4 for follow the transport it found: full rate over
UDP/TCP/USB, and a bandwidth budget over a telemetry radio, where asking for
25 Hz costs more than the link has and the thing that gets dropped is your next
command.

Terminal 2 — the console:

```sh
npm install                                   # first time; also copies Cesium assets
npm run dev                                   # Next app on :4300
```

Terminal 3 — PX4 SITL, and Terminal 4 — the sim (both in `AircraftSim`):

```sh
# PX4 in Docker. First run compiles PX4 (~30 min, once); later runs are cached.
PX4_DIR=../mojave-px4 docker compose up px4

# the host side, which flies it. The aircraft must be named explicitly.
uv run python -m src run --rig px4_autopilot --aircraft run_h6ue --seconds 600
```

For a flight meant to run for days, use the supervised path instead, which also
disables PX4's 850 MB/hour flight log and the lockstep deadlock:

```sh
uv run python scripts/perpetual_flight.py --lat 37.3985511 --lon -122.148853 \
    --ground-alt 111 --agl 122 --radius 805
```

Open http://localhost:4300 → redirects to `/flight` and autoconnects. In the
field the console is served by the Pi hub and the WS endpoint is host-relative
(`commandant.local`), so no configuration is needed on a phone or laptop.

## Two deployments of one app

| Build | Where | Authority |
|---|---|---|
| **cockpit** (default) | the field hub, over its own WiFi | full command authority |
| **view** (`NEXT_PUBLIC_MODE=view`) | `commandant.guppidev.com` | read-only by construction |

The hosted viewer watches a relay the hub pushes to, outbound only. It is
read-only at three independent layers: the relay never reads a viewer's socket,
never writes to the publisher's, and the view build refuses to transmit at its
single send chokepoint. Nothing on the internet can reach an aircraft. See
[`docs/hosting.md`](docs/hosting.md) and [`packages/relay`](packages/relay).

Set `NEXT_PUBLIC_CESIUM_KEY` (Cesium Ion token) in `packages/console/.env` for
globe imagery. `NEXT_PUBLIC_MAVLINK_WS_ENDPOINT` overrides the WS endpoint for a
split dev setup. The console↔gs message contract is `docs/ws-contract.md`.

## Tests

```sh
cd packages/gs      && uv run pytest -q   # 150 — protocol state machines vs a fake PX4
cd packages/relay   && uv run pytest -q   # 17 — fan-out, slow-viewer shedding, read-only guarantee
cd packages/cli     && uv run --group dev pytest -q   # 19 — hub installer, the systemd units, the lifecycle verbs
cd packages/console && npm test           # 394 — stores, WS client, validation (vitest)
cd packages/console && npm run typecheck
```

Everything checkable without an aircraft, in one command — this is the gate to
run before a SITL session, a HITL session, or a flight:

```sh
npm run preflight           # suites, typecheck, production build, frame diff
npm run preflight:soak      # and the simulated-radio rehearsals (~2 min)
```

It stops at the first failure and prints that stage's tail. It exists because
the gate was seven commands, and a seven-command gate gets run as two — and
because checking a suite by grepping its summary line misses a suite that passes
every test and still exits non-zero, which is how two unhandled rejections hid
in the console suite until this script checked the exit code.

Two things the unit suites cannot ask, both against a simulated autopilot behind
a simulated telemetry radio (bandwidth, latency, packet loss) — which is where
the timeout and retry constants actually get exercised. Both are stochastic and
slow, so neither is in the suite; run them after touching a state machine or a
timing constant.

**Does the whole day work?** Walks the operator's own sequence once, in order —
link up, take command, read params, write one, upload a geofence and read it
back, upload a mission and read it back, arm, AUTO.MISSION, progress,
fly-to-here, RTL, disarm — and reports what each step cost. Exits non-zero if
any step fails, so it can gate a release.

```sh
cd packages/gs && uv run python scripts/day_in_the_life.py          # 57600 SiK
uv run python scripts/day_in_the_life.py --net                      # fat pipe
uv run python scripts/day_in_the_life.py --loss 0.08                # a worse day
```

Against a **real** autopilot — PX4 SITL, a HITL rig, or the aircraft on the
bench — point it with `--attach` and it runs the same steps with the same
pass/fail. That the stand-in is indistinguishable from the real thing is what
makes this the same test:

```sh
uv run python scripts/day_in_the_life.py --attach auto --net        # find it
uv run python scripts/day_in_the_life.py --attach udpin:0.0.0.0:14550 --net
uv run python scripts/day_in_the_life.py --attach serial:/dev/ttyACM0:115200
```

**Did a refactor change the frame?** The emitted frame is the console's
contract, and it is built by a long branch that gets restructured. This feeds one
identical MAVLink sequence into the working tree and into any git ref, and diffs
the resulting frame field by field. Non-zero if a pre-existing field changed;
new fields are reported, not failed.

```sh
cd packages/gs && uv run python scripts/frame_diff.py              # vs HEAD~1
uv run python scripts/frame_diff.py --ref 657fe0f                  # vs any ref
```

**Where does it break?** Hammers one operation at a time to find the boundary.

```sh
cd packages/gs && uv run python scripts/radio_soak.py        # 57600 SiK, 5% loss
uv run python scripts/radio_soak.py --loss 0.1 --items 60    # and a worse day
```

A production build also asserts what the browser needs, which a dev build cannot:

```sh
cd packages/console && npm run build
find .next/static/chunks -name '*.js' -exec node --check {} \;   # must be silent
```

## Layout

```
src/
  app/                 # routes: / (→ /flight), /flight, /satellites
  components/          # Globe (shared) + flight/ and satellites/ islands
  stores/ services/    # nanostores state + telemetry/satellite data sources
  services/telemetry.ts  # WebSocket client of the gs daemon
public/
  models/              # solar-airplane.glb (placeholder until real airframe export)
  cesium/              # Cesium runtime assets (generated, gitignored)
```
