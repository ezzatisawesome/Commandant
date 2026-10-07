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
- `dataAgeMs` (int | null): age of the newest **vehicle** data. `null` before any
  arrives.

**Link health is attributed per source, and this matters.** gs takes two feeds:
MAVLink from the autopilot, and the sim's flightlink JSON. Only MAVLink speaks
for the vehicle. A single shared "last message" timestamp once let a live JSON
power feed report `linkState:"alive"` for an hour while PX4's MAVLink was dead
and gs re-broadcast one frozen fix — 839 consecutive frames with identical
lat/lon/alt/roll, only the frame timestamp advancing. So:

- once any MAVLink vehicle has been seen, **only** MAVLink freshness sets
  `linkState` and `dataAgeMs`;
- on a pure flightlink run (no PX4), the JSON feed is genuinely the only source
  and drives both.

A client should treat a large `dataAgeMs` as "these numbers describe the past"
even while `linkState` is still `alive`; the console shows a red `stale Ns` badge
past 3 s.

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
- `final` (optional, default true): `false` marks an interim notice relayed from a
  `MAV_RESULT_IN_PROGRESS` ack; the real verdict follows under the same `id`.

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
  fire-and-forget. A `MAV_RESULT_IN_PROGRESS` (5) ack stops the retries and
  extends the wait (15 s) for the final result.
- **JSON safety:** gs never emits `NaN`/`Infinity` (the browser's `JSON.parse`
  rejects them); a non-finite float is sent as `null`.
- **Transport:** if the MAVLink link fails to open (radio not plugged in, TCP
  peer down) or errors repeatedly, gs reopens it with backoff instead of dying;
  the link state goes `lost` meanwhile.
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
{ "type": "params", "items": [ { "name": "FW_AIRSPD_TRIM", "value": 15.0, "ptype": 9, "index": 42, "count": 900 }, "..." ] }
{ "type": "param_progress", "received": 850, "count": 900 }
{ "type": "param_progress", "received": 900, "count": 900, "done": true }
{ "type": "param_progress", "received": 612, "count": 900, "done": true, "error": "timeout" }
{ "type": "param_ack", "id": "<uuid>", "name": "FW_AIRSPD_TRIM", "value": 15.0, "ok": true, "text": "set" }
```
- `param_refresh` → `PARAM_REQUEST_LIST`; `PARAM_VALUE`s are **coalesced into
  `params` batches** (≤64 items or ~50 ms, whichever first) so a ~1000-param list
  is a few dozen WS messages, not a thousand. Index/count are tracked and gaps are
  re-requested after the stream goes quiet; after 10 fruitless sweeps gs gives up
  and sends `param_progress {done:true, error:"timeout"}`. Every `params` batch
  precedes the `done` marker. (A single `param` message is still accepted by the
  console for back-compat.)
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

### Geofence + rally (Phase 4 extension)
Same handshake, generalized by **`mission_type`** (`MAV_MISSION_TYPE_FENCE`=1,
`MAV_MISSION_TYPE_RALLY`=2). Item kinds + MAV_CMD:

| kind                     | MAV_CMD                              | params                    |
|--------------------------|-------------------------------------|---------------------------|
| `fence_inclusion`        | `NAV_FENCE_POLYGON_VERTEX_INCLUSION`| vertexCount (p1), lat, lon|
| `fence_exclusion`        | `NAV_FENCE_POLYGON_VERTEX_EXCLUSION`| vertexCount (p1), lat, lon|
| `fence_circle_inclusion` | `NAV_FENCE_CIRCLE_INCLUSION`        | radius (p1), lat, lon     |
| `fence_circle_exclusion` | `NAV_FENCE_CIRCLE_EXCLUSION`        | radius (p1), lat, lon     |
| `rally`                  | `NAV_RALLY_POINT`                   | lat, lon, alt             |

console → gs: `fence_push {id,items}` / `fence_pull` / `rally_push {id,items}` /
`rally_pull`.
gs → console: `fence {count,items}` / `rally {count,items}` /
`fence_ack {id,ok,result,text}` / `rally_ack {id,ok,result,text}`.
(Polygon vertices of one inclusion/exclusion set share the same `vertexCount` and
are consecutive, per the MAVLink fence convention.)

## Param metadata (Phase 2 completion)
PX4's `parameters.json` (name/shortDesc/longDesc/min/max/units/type/default) is
bundled with the console and matched to live `param` values by name — units,
range validation, and help text. Not on the MAVLink wire.

## The relay leg (hosted viewer)

`packages/relay` serves the hosted viewer (`commandant.guppidev.com` on
Vercel, streaming from `wss://commandant-relay.fly.dev/`). The hub publishes the SAME
messages defined above, outbound, to `wss://…/publish` with a bearer token;
browsers subscribe at `wss://…/` and receive them verbatim.

```
 hub (gs --relay) ──wss /publish──► relay ──wss / ──► browsers (NEXT_PUBLIC_MODE=view)
```

- **Telemetry is republished at 5 Hz**, not 25: an internet viewer cannot perceive
  more and a field hotspot should not pay for it. `--relay-hz` tunes it.
- **Latest-wins for telemetry, ordered for events.** A telemetry frame queued
  while the uplink is down is replaced by the next; statustext and readbacks keep
  their order up to a bounded queue.
- **`flight`** is the one message only the relay leg carries:
  `{ "type": "flight", "id": "flight-20261006-1812", "startedAt": 1730000000000 }`.
- **Late joiners** get the retained `telemetry`, `link`, `mission`, `fence`,
  `rally` and `flight` immediately on connect, so a page load draws at once.
- **A missing hub** is reported to viewers as `link {state:"lost"}` rather than
  freezing the last frame, which would read as a live aircraft.

Direction is absolute: **no message travels from a viewer toward the hub.** Viewer
sockets are never read, the publisher socket is never written, and the view build
refuses to transmit. See `packages/relay/README.md`.

## Authority confirm (polish)
`claim` may carry an `id`; gs replies with an `ack {id, ok, text:"commander"|"not
commander"}` so the console can show whether it holds command authority.
