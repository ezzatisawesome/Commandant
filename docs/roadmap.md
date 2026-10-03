# Commandant — Implementation Roadmap

Status: **draft** · Last updated: 2026-10-02

Turning Commandant from an ingest-only telemetry viewer into a real
QGroundControl-replacement GCS for the solar aircraft.

## Scope boundary (the two-plane rule)

Commandant owns the aircraft as a **flying vehicle** — flight/ops plane, MAVLink,
flight-rate. It does **not** write to power-system firmware (BMS, PowerBoard,
MPPT); that lives on the **T&M plane** and is Guppi's authority. See
`../AircraftSim/docs/ecosystem.md`.

- **Missions** → 100% Commandant.
- **Params** → split by owner: **PX4/autopilot params → Commandant** (MAVLink
  `PARAM_SET`); **power-system firmware params → Guppi** (agent-gated NATS relay).
- **Display** → both tools may *read* any telemetry. Ownership is about *who writes*.

Decision rule for any new feature: *does it change how it flies, or how a
component behaves under test?* Flies → Commandant/MAVLink. Component → Guppi/NATS.

## Target

SITL now, real aircraft later. Build against AircraftSim's PX4 SITL but keep the
link layer transport-general (UDP now; TCP/serial/radio-ready) so the same GCS
flies the real vehicle unchanged.

Reliability is the whole point: the connection / heartbeat / param-sync /
mission-handshake state machines are where a GCS's flakiness lives. We own these
state machines (pymavlink, not MAVSDK — see Architecture), so **every one gets
deterministic, tested handling against SITL** — this is non-negotiable, not a
nicety.

## Architecture

The link + command logic moves **out of the Next.js server** (`instrumentation.ts`)
into a **standalone, long-lived Python daemon** on **pymavlink**. A web framework
that hot-reloads must never own arm/disarm or a mission upload. The Cesium UI
becomes a thin client of the daemon over WebSocket/HTTP.

Commandant is now a **monorepo**:

```
Commandant/
  package.json            (npm workspace root)
  packages/
    console/              (Next + Cesium UI — thin client; was the repo root)
    gs/                   (Python pymavlink ground-station daemon)
  docs/roadmap.md
```

Decisions locked:
- **Language/core: Python + pymavlink. No MAVSDK.** We own the protocol state
  machines deliberately, so they can be made deterministic and tested against the
  sim. Reuse the arm / set_mode / takeoff / battery-injection patterns already in
  AircraftSim `src/px4/mavlink_io.py`.
- **Routing: no mavlink-router needed for SITL** (revised after inspection).
  AircraftSim's PX4 container already *dual-unicasts*: offboard → host `:14540`
  (the sim's `mavlink_io`) and a dedicated GCS stream → host `:14550` (the gs
  daemon), via `PX4_OFFBOARD_TARGET` / `PX4_GCS_TARGET` in `docker/entrypoint.sh`.
  The fan-out already happens at the PX4 level, so gs just binds `:14550`.
  mavlink-router is **deferred** to when a real radio delivers a single stream, or
  a second consumer (e.g. QGC alongside gs) must share one stream.
- **SIL-rehearsal is its own phase** (Phase 3): a command is not real-aircraft-
  eligible until it has been replayed against AircraftSim. Python colocation makes
  the daemon able to drive the sim directly for rehearsal.

```
PX4 SITL ─udp─> mavlink-router ─┬─> AircraftSim mavlink_io  (sim's own link)
                                ├─> Commandant daemon (pymavlink) ─WS/HTTP─> Cesium UI
                                └─> (QGC, optional, side-by-side)

command path:  UI → daemon → [authority gate] → [SIL-rehearsal vs AircraftSim] → pymavlink TX (+ACK) → router → PX4
```

The daemon's responsibilities: link/transport management, telemetry fan-out to
the UI, command ingress + authority gate, the protocol state machines (arm/mode,
param sync, mission), and the SIL-rehearsal gateway.

## Deployment — the hub

The field deployment is a **Raspberry Pi "hub"** that is both the ground station
and the base station. Turn the plane on; turn the hub on; join the hub's WiFi on
any phone/laptop; open the page; **you just see the plane, live.** No login, no
setup, multiple viewers at once.

```
   plane  ──radio/serial──►  HUB (Raspberry Pi)  ──WiFi──►  phones / laptops
                             • gs daemon (owns the radio link)        browser →
                             • serves the console web app             commandant.local
                             • standalone WiFi AP (hostapd)           → /flight, live
                             • mDNS: commandant.local (avahi)
```

Decisions:
- **Plane ↔ hub = radio/serial** → this is the `gs` transport abstraction
  (UDP/TCP/**serial**); on the Pi, `gs` attaches to the radio, not localhost UDP.
- **Hub ↔ clients = WiFi + browser.** `gs` binds `0.0.0.0`; the console's WS
  endpoint must be **host-relative** (`window.location.hostname`), so any client on
  the hub WiFi reaches the hub's `gs`. (Dev still falls back to localhost.)
- **Standalone AP** (hostapd/dnsmasq) — works in a remote field, no infrastructure.
- **mDNS hostname** `commandant.local` (avahi) — how clients get in. (Captive
  portal considered and deferred.)
- **Zero-config UX:** connect → `commandant.local` → root redirects to `/flight`
  → telemetry autoconnects → the plane is on the globe. No auth.
- **Hub/ops workstream** (new): hostapd + dnsmasq AP config, avahi hostname,
  systemd units to autostart `gs` and the served console on boot, console built
  for production and served on the Pi. Mostly Pi config — scaffolded here,
  validated on real hardware.

---

## Phase 0 — Standalone Python link daemon + link manager (foundation)

Everything downstream needs the daemon, a TX path, and a robust link. The current
bridge (`src/lib/bridge/bridge.ts`) is RX-only and lives inside Next.

- [x] **Stand up the Python daemon** as a separate process; port the current
      RX + `SET_MESSAGE_INTERVAL` behavior off `bridge.ts`. Reuse
      `AircraftSim/src/px4/mavlink_io.py` patterns. *(gs/bridge.py; MAVLink→WS and
      JSON→WS paths tested.)*
- [x] ~~mavlink-router in front~~ — **not needed for SITL**; PX4 dual-unicasts
      (:14540 sim, :14550 gs). Deferred to real-radio / second-consumer.
- [x] **WS contract** daemon ↔ Cesium UI (`docs/ws-contract.md`): tagged
      telemetry out + `command`/`claim` in, `ack`/`link` back. In-Next bridge
      disabled (`instrumentation.ts` is a no-op).
- [x] **Link manager.** connecting/alive(<2s)/stale(<5s)/lost; `linkState` on
      every frame + `link` on transitions; console indicator + auto-reconnect.
- [ ] **Transport abstraction.** UDP today; interface ready for TCP/serial so
      real-radio is a config change, not a rewrite. Multi-endpoint capable.
      *(still pending — the one unticked foundation item.)*
- [x] **Command ACK tracking.** `COMMAND_LONG` for arm/disarm/set_mode; 3 tries
      @1s then `ack{timeout}`; matched `COMMAND_ACK` routed to the originating
      client. Thread-safe TX funnelled onto the mav thread.
- [x] **Authority discipline.** Single-commander via `claim`. No cross-plane reach.
- [~] **Test harness.** Synthetic-MAVLink decode + command/ack + link-state tests
      green (packages/gs/tests). **Live PX4 end-to-end still unconfirmed** — the
      container builds PX4 from source (~10–20 min) and overran the 240s boot
      timeout; re-run the smoke after a one-time warm build (cached-build fast path).

## Phase 1 — Command authority

Control verbs. Small, high-value, and the prerequisite for missions.

- [ ] Arm / disarm — `MAV_CMD_COMPONENT_ARM_DISARM` via `COMMAND_LONG`. (Reuse
      `mavlink_io.py`.)
- [ ] Set flight mode (Manual / Stabilized / Auto / Loiter / RTL / Offboard) —
      `SET_MODE` / `COMMAND_LONG`. Reuse mode decode already in `bridge.ts`.
- [ ] Takeoff / Land / RTL / Hold buttons — `MAV_CMD_NAV_TAKEOFF` / `_LAND` /
      `_RETURN_TO_LAUNCH` / `_LOITER_UNLIM`.
- [ ] "Fly to here" — click globe → guided reposition (`MAV_CMD_DO_REPOSITION`).
      Note: on PX4 **fixed-wing** this is loiter-at-point, not a quad-style goto —
      build the UI/expectation accordingly.
- [ ] Command UI: action bar + confirm-on-dangerous, ACK/failure feedback,
      disabled states driven by link + armed + mode.
- [ ] `STATUSTEXT` log panel — surface PX4 warnings/errors/failsafe to the operator.
- [ ] Health/status: EKF, GPS fix + sats, battery warning, failsafe state —
      ingest `SYS_STATUS`, `GPS_RAW_INT`, `EKF_STATUS_REPORT`.

## Phase 2 — PX4 parameters (view + edit live)

"View PX4 variables and edit them on the fly." Turns the read-only
`/api/airframe` panel into a live, writable editor.

- [ ] Fetch full param set — `PARAM_REQUEST_LIST` → stream of `PARAM_VALUE`;
      hand-roll the missing-param / re-request sync robustly (index/count
      tracking, timeout, retransmit). Tested against SITL.
- [ ] Searchable, filterable param table: name, value, type, units/min/max/desc.
      Metadata (units/min/max/description) is **not** on the MAVLink wire — source
      it from PX4's bundled `parameters.json`. Decide: bundle it, or ship
      value-only first.
- [ ] Edit + write live — `PARAM_SET`, confirm via echoed `PARAM_VALUE`; dirty
      indicators; reject/rollback on mismatch.
- [ ] Diff vs airframe defaults (reuse the airframe init script already read via
      `/api/airframe`); highlight changed-from-default.
- [ ] Param snapshots: save / load / compare sets to file (local persistence).

## Phase 3 — SIL-rehearsal gateway

Per ecosystem §3.1, a hard contract: no uplinked command touches real hardware
until it has been replayed against AircraftSim SITL and passed. Built as its own
phase; the Phase 1/2 verbs (and Phase 4 missions) register with it.

- [ ] Rehearsal harness: daemon can drive an AircraftSim SITL run and apply a
      pending command/param/mission to it (Python colocation makes this direct).
- [ ] Verdict contract: a command is `rehearsed-ok` / `rehearsed-fail` with the
      sim's evidence, surfaced in the UI before any real-aircraft send.
- [ ] Authority tie-in: real-aircraft targets require a fresh passing rehearsal;
      SITL targets bypass (the target *is* the sim).
- [ ] Register each command verb (arm/mode/param-set/mission-upload) as it lands.

## Phase 4 — Mission planning on the fly

Create, edit, upload, and watch missions execute. All Commandant.

- [ ] Waypoint authoring on the Cesium globe: click-to-add, drag-to-move.
- [ ] Waypoint table: lat/lon/alt/speed/loiter; reorder; delete; per-item type
      (takeoff, waypoint, loiter time/turns/unlim, RTL, land) via
      `MISSION_ITEM_INT` frame/command fields.
- [ ] **Upload** — hand-rolled `MISSION_COUNT` → `MISSION_REQUEST_INT` →
      `MISSION_ITEM_INT` → `MISSION_ACK` handshake (out-of-order requests,
      re-request, timeout, NAK decode). The most error-prone protocol; heaviest
      test coverage, and it routes through SIL-rehearsal.
- [ ] **Download / read back** current mission — `MISSION_REQUEST_LIST`.
- [ ] Live progress: highlight current item, distance-to-next —
      `MISSION_CURRENT`, `MISSION_ITEM_REACHED`. (Setpoint trail already exists.)
- [ ] Edit mid-flight & re-upload without full restart; set-current item.
- [ ] Later: geofence + rally points (`MAV_MISSION_TYPE_FENCE` / `_RALLY`).

## Phase 5 — Configurable display

"Seeing data and adjusting what's shown." Pure viewer-side, no control stakes.
The solar/power/MPPT dashboard already exists; this generalizes the rest.

- [ ] Add/remove/reorder HUD panels & fields (extends `FlightHUD.tsx` + store).
- [ ] Chart any telemetry field, not a fixed set — generalize the `series()`
      sparkline helper over the whole frame.
- [ ] On-demand stream control: turn MAVLink messages on/off and set rate from
      the UI — generalize the existing `SET_MESSAGE_INTERVAL` TX.
- [ ] Multi-plot, time-window select, pause-and-scrub (extend history store).
- [ ] Layout presets (flight-test / power-debug / mission view), persisted.

---

## Deferred (post-MVP)

- Flight log download & playback / scrub — `LOG_REQUEST_*`.
- Telemetry recording to disk + replay into the same UI.
- Multi-vehicle (bridge currently assumes a single sysid).
- Video feed panel.

## Open decisions

- ~~Daemon repo location~~ — **resolved**: monorepo in Commandant,
  `packages/gs` (Python) + `packages/console` (UI). Rehearsal imports the sim.
- PX4 param metadata: bundle `parameters.json` now, or value-only first.

## Key files

UI paths are under `packages/console/`; the daemon lives in `packages/gs/`.

| Concern | File |
|---|---|
| Current bridge (to be replaced by the daemon) | `src/lib/bridge/bridge.ts` |
| Reuse: existing pymavlink link (arm/mode/takeoff/battery) | `../AircraftSim/src/px4/mavlink_io.py` |
| WS client → store (repoint at the daemon) | `src/services/telemetry.ts` |
| Telemetry state | `src/stores/aircraft.store.ts` |
| Frame type | `src/types/app.d.ts` |
| HUD / instruments | `src/components/flight/FlightHUD.tsx` |
| Globe scene (waypoints go here) | `src/components/flight/Aircraft.tsx`, `src/components/Globe.tsx` |
| Airframe config (→ live param editor) | `src/app/api/airframe/route.ts` |
| Ports / endpoints | `src/lib/envs.ts` |
