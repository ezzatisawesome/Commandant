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

Terminal 3 — drive it from the sim (in `AircraftSim`):

```sh
uv run python -m sim run --with autopilot     # PX4 SITL (real MAVLink)
uv run python -m sim run --with flight --commandant --clock realtime   # flightdyn, no PX4
```

Open http://localhost:4300 → redirects to `/flight` and autoconnects. In the
field the console is served by the Pi hub and the WS endpoint is host-relative
(`commandant.local`), so no configuration is needed on a phone or laptop.

Set `NEXT_PUBLIC_CESIUM_KEY` (Cesium Ion token) in `packages/console/.env` for
globe imagery. `NEXT_PUBLIC_MAVLINK_WS_ENDPOINT` overrides the WS endpoint for a
split dev setup. The console↔gs message contract is `docs/ws-contract.md`.

## Tests

```sh
cd packages/gs && uv run pytest -q            # daemon: protocol state machines against a fake PX4
cd packages/console && npm test               # console: stores, WS client, validation (vitest)
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
