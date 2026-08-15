# Commandant

Flight/ops visualization for the solar airplane — a QGroundControl-style UI that
renders the aircraft as a 3D model on a Cesium globe, driven by live telemetry.
Built with **Next.js + React + Cesium + nanostores** (matching the Guppi platform
stack). The satellite-tracking view lives at `/satellites`.

## One app, one command

The browser can't read the sim's UDP telemetry directly, so a small **bridge**
translates it to a WebSocket. The bridge runs *inside* the Next.js server (via
`src/instrumentation.ts`), so a single `npm run dev` starts everything:

```
sim / PX4 ──UDP──► bridge (in Next server) ──WebSocket:8080──► browser (/flight)
```

- **MAVLink (udp:14550)** — PX4's GCS stream (autopilot runs; "sim == real aircraft").
- **JSON (udp:14555)** — the sim's `flightlink` system for `flightdyn` runs (no PX4).

Either source feeds the same WebSocket; the UI is identical regardless.

## Run

```sh
npm install                 # also copies Cesium assets into public/cesium
npm run dev                 # Next app on :3000 + telemetry bridge (auto-started)
```

Then drive it from the sim (separate terminal, in `solar-airplane-sim`):

```sh
# flightdyn (no PX4):
uv run python -m sim run --with flight --commandant --clock realtime
# autopilot (real PX4/MAVLink):
uv run python -m sim run --with autopilot
```

Open http://localhost:3000 → redirects to `/flight`.

Set `NEXT_PUBLIC_CESIUM_KEY` (Cesium Ion token) in `.env` for globe imagery. The
WS endpoint is configurable via `NEXT_PUBLIC_MAVLINK_WS_ENDPOINT` (default
`ws://localhost:8080`).

## Layout

```
src/
  app/                 # routes: / (→ /flight), /flight, /satellites
  components/          # Globe (shared) + flight/ and satellites/ islands
  stores/ services/    # nanostores state + telemetry/satellite data sources
  lib/bridge/          # the MAVLink/JSON -> WebSocket bridge (runs server-side)
  instrumentation.ts   # starts the bridge on server boot
public/
  models/              # solar-airplane.glb (placeholder until real airframe export)
  cesium/              # Cesium runtime assets (generated, gitignored)
```
