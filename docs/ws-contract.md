# Commandant WS contract (console ↔ gs)

Status: **draft** · The single interface between the `console` UI and the `gs`
daemon over `ws://localhost:8790`. Both sides build against this. All messages are
JSON. Messages are discriminated by a `type` field.

## gs → console

### `telemetry` (every ~40 ms, 25 Hz)
The existing telemetry frame, now tagged and link-annotated. All telemetry fields
from the Phase 0 frame remain unchanged (`lat`, `lon`, `alt`, `roll`, `pitch`,
`yaw`, `airspeed`, `throttle`, `aileron`, `elevator`, `voltage`, `current`,
`mode`, `armed`, `targetLat`, …, `genW`, `loadW`, `sunEpochMs`, `connected`, `t`).

```json
{ "type": "telemetry", "t": 1730000000000, "connected": true,
  "linkState": "alive", "lat": 37.4, "mode": "AUTO.LOITER", "...": "..." }
```

- `linkState`: `"connecting" | "alive" | "stale" | "lost"`.
- `connected` (bool) is kept for back-compat; `connected == (linkState === "alive")`.

### `link` (on state change; optional, telemetry also carries `linkState`)
```json
{ "type": "link", "state": "stale", "lastMsgMs": 1730000000000 }
```

### `ack` (response to a command)
```json
{ "type": "ack", "id": "<command id>", "ok": true, "result": 0, "text": "accepted" }
```
- `id` echoes the command's `id`.
- `result`: MAV_RESULT code when from a `COMMAND_ACK` (0 = ACCEPTED), else -1.
- `ok`: convenience bool (`result === 0`, or a local accept/reject).
- `text`: human-readable (e.g. `"not commander"`, `"timeout"`, `"accepted"`).

## console → gs

### `command`
```json
{ "type": "command", "id": "<uuid>", "name": "arm", "args": {} }
```

| name       | args                                   | MAVLink                                             |
|------------|----------------------------------------|----------------------------------------------------|
| `arm`      | `{ "force": false }`                   | `COMMAND_LONG` `MAV_CMD_COMPONENT_ARM_DISARM` p1=1  |
| `disarm`   | `{ "force": false }`                   | `COMMAND_LONG` `MAV_CMD_COMPONENT_ARM_DISARM` p1=0  |
| `set_mode` | `{ "main": 4, "sub": 3 }` (e.g. LOITER)| `COMMAND_LONG` `MAV_CMD_DO_SET_MODE`                |

Reuse the exact command shapes in `AircraftSim/src/px4/mavlink_io.py`
(`arm`, `set_mode`, targets system 1 / component 1).

### `claim` (authority)
```json
{ "type": "claim" }
```
Marks this WS connection as the single active commander. gs accepts `command`
messages only from the current commander; others get `ack` with
`ok:false, text:"not commander"`. First claimer wins until it disconnects; a new
`claim` after disconnect takes over. (SITL-simple; refine later.)

## gs behavior

- **ACK tracking:** after TX, await the matching `COMMAND_ACK` (by command id),
  retry up to 3× at ~1 s, then `ack` with `ok:false, text:"timeout"`. Never
  fire-and-forget.
- **Link manager:** track last-message time; `alive` while fresh (<2 s), `stale`
  past that, `lost` after a longer gap / socket loss, `connecting` before first
  message. Emit `linkState` on every telemetry frame and a `link` message on
  transitions.
- **Authority:** single commander (see `claim`). No cross-plane reach (never
  touches Guppi / power-system firmware).

---

# Extensions (Phase 1 / 2 / 5)

## More commands (console → gs `command`)
Same `{type:"command", id, name, args}` envelope + `ack` response. Shapes mirror
`AircraftSim/src/px4/mavlink_io.py` where present.

| name         | args                       | MAVLink                                    |
|--------------|----------------------------|--------------------------------------------|
| `takeoff`    | `{ "alt": 30 }`            | `COMMAND_LONG` `MAV_CMD_NAV_TAKEOFF` (p7=alt, lat/lon NaN) |
| `land`       | `{}`                       | `MAV_CMD_NAV_LAND`                         |
| `rtl`        | `{}`                       | `MAV_CMD_NAV_RETURN_TO_LAUNCH`             |
| `hold`       | `{}`                       | `MAV_CMD_NAV_LOITER_UNLIM` (or set_mode AUTO.LOITER) |
| `reposition` | `{ "lat", "lon", "alt" }`  | `MAV_CMD_DO_REPOSITION` ("fly to here"; FW = loiter-at-point) |

## Health / status (gs → console)
Merged into the `telemetry` frame (not separate messages):
- `ekfOk` (bool, from `EKF_STATUS_REPORT` flags), `gpsFix` (int, `GPS_RAW_INT.fix_type`),
  `gpsSats` (int), `failsafe` (bool), `sysHealthy` (bool, from `SYS_STATUS`),
  `batteryWarning` (string | null).

## STATUSTEXT (gs → console)
```json
{ "type": "statustext", "severity": 4, "text": "...", "t": 1730000000000 }
```
`severity` is the MAV_SEVERITY level (0 emergency … 7 debug).

## Parameters (Phase 2)
console → gs:
```json
{ "type": "param_refresh" }
{ "type": "param_set", "id": "<uuid>", "name": "FW_AIRSPD_TRIM", "value": 15.0, "ptype": 9 }
```
gs → console:
```json
{ "type": "param", "name": "FW_AIRSPD_TRIM", "value": 15.0, "ptype": 9, "index": 42, "count": 900 }
{ "type": "param_progress", "received": 850, "count": 900 }
{ "type": "param_ack", "id": "<uuid>", "name": "FW_AIRSPD_TRIM", "value": 15.0, "ok": true, "text": "set" }
```
- `param_refresh` → `PARAM_REQUEST_LIST`; stream each `PARAM_VALUE` as `param`,
  track index/count, re-request any gaps (hand-rolled, with timeout).
- `param_set` → `PARAM_SET`; confirm against the echoed `PARAM_VALUE`
  (value match) → `param_ack`; mismatch/timeout → `ok:false`.

## Stream control (Phase 5)
console → gs:
```json
{ "type": "stream", "msgId": 30, "hz": 10 }
```
→ `SET_MESSAGE_INTERVAL` (hz=0 disables). Generalizes the daemon's existing
hardcoded extra-stream requests.

## Missions (Phase 4)

A console-friendly item shape; gs maps each `kind` to a `MISSION_ITEM_INT`
(lat/lon as int 1e7, `MAV_FRAME_GLOBAL_RELATIVE_ALT_INT` for waypoints):

| kind           | MAV_CMD                    | params used                     |
|----------------|----------------------------|---------------------------------|
| `takeoff`      | `NAV_TAKEOFF`              | alt                             |
| `waypoint`     | `NAV_WAYPOINT`            | lat, lon, alt                   |
| `loiter_unlim` | `NAV_LOITER_UNLIM`        | lat, lon, alt, (radius)         |
| `loiter_time`  | `NAV_LOITER_TIME`         | lat, lon, alt, seconds, radius  |
| `loiter_turns` | `NAV_LOITER_TURNS`        | lat, lon, alt, turns, radius    |
| `rtl`          | `NAV_RETURN_TO_LAUNCH`    | —                               |
| `land`         | `NAV_LAND`                | lat, lon                        |

Item: `{ "seq": 0, "kind": "waypoint", "lat": 37.4, "lon": -122.1, "alt": 80, "params": { "radius": 60 } }`

console → gs:
```json
{ "type": "mission_push", "id": "<uuid>", "items": [ ... ] }
{ "type": "mission_pull" }
{ "type": "mission_set_current", "seq": 3 }
```
gs → console:
```json
{ "type": "mission", "count": 5, "items": [ ... ] }                 // after a pull
{ "type": "mission_progress", "phase": "upload", "seq": 3, "count": 5 }
{ "type": "mission_ack", "id": "<uuid>", "ok": true, "result": 0, "text": "accepted" }
{ "type": "mission_current", "seq": 2 }
{ "type": "mission_reached", "seq": 1 }
```

gs behavior (hand-rolled, on the mav thread; **the most error-prone protocol —
heaviest test coverage**):
- **push:** `MISSION_COUNT` → answer each `MISSION_REQUEST_INT` (out-of-order,
  retransmit, timeout) with `MISSION_ITEM_INT` → `MISSION_ACK`. Commander-gated.
- **pull:** `MISSION_REQUEST_LIST` → `MISSION_COUNT` → request each item →
  collect `MISSION_ITEM_INT` → `MISSION_ACK` → emit `mission`.
- Ingest `MISSION_CURRENT` → `mission_current`, `MISSION_ITEM_REACHED` →
  `mission_reached`. `mission_set_current` → `MISSION_SET_CURRENT`.
- `result` is the MAV_MISSION_RESULT code (0 = ACCEPTED).
