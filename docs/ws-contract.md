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
