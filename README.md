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
uv run python -m gs                           # udp:14550 in, ws://0.0.0.0:8790 out
# real radio on the hub:  uv run python -m gs --mavlink serial:/dev/ttyUSB0:57600
```

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
cd packages/gs      && uv run pytest -q   # 46 — protocol state machines vs a fake PX4
cd packages/relay   && uv run pytest -q   # 10 — fan-out, and the read-only guarantee
cd packages/console && npm test           # 39 — stores, WS client, validation (vitest)
cd packages/console && npm run typecheck
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
