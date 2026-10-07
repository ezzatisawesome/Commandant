# gs — Commandant ground-station daemon

Standalone Python daemon (pymavlink, **no MAVSDK**) that owns the MAVLink link to
the vehicle and exposes a thin WebSocket contract to the `console` UI. It holds
command authority and the protocol state machines: arm/mode/nav verbs, parameter
sync, and the mission / geofence / rally handshakes.

Why a separate process (not inside Next): a hot-reloading web framework must
never own arm/disarm or a mission upload.

Wire contract: [`../../docs/ws-contract.md`](../../docs/ws-contract.md).
Roadmap: [`../../docs/roadmap.md`](../../docs/roadmap.md).

## Run

```bash
cd packages/gs
uv venv && uv pip install -e ".[dev]"   # first time
uv run python -m gs                     # udp:14550 in, ws://0.0.0.0:8790 out
uv run python -m gs --help
```

| Flag | Default | Notes |
|---|---|---|
| `--mavlink` | `udpin:0.0.0.0:14550` | Also `udpout`/`tcp:host:port`, `serial:<dev>[:baud]`, or a bare `/dev/…` (the hub radio) |
| `--baud` | 57600 | Serial only |
| `--json-port` | 14555 | The sim's flightlink JSON feed. Optional: a port clash disables it rather than killing the daemon |
| `--ws-host` / `--ws-port` | `0.0.0.0` / 8790 | The console endpoint |
| `--relay` / `--relay-token` | off | Outbound-only publish to the public relay (`COMMANDANT_RELAY`, `COMMANDANT_RELAY_TOKEN`) |
| `--relay-hz` | 5 | Telemetry rate republished to the relay |
| `--flight-id` | UTC timestamp | Label for this flight on the relay |

## Properties worth knowing

These are load-bearing, each learned from a live failure, and each has a test.

- **A handler exception never kills the link.** Every mav-thread iteration is
  isolated and logged; a dead mav thread is indistinguishable from a dead radio
  at the console, which is the worst failure to debug.
- **Only MAVLink speaks for the vehicle.** Link health is tracked per source, so
  a live flightlink JSON feed cannot report `alive` for a dead autopilot. Frames
  carry `dataAgeMs`; see the contract.
- **Integer parameters use PX4's byte-wise encoding.** PX4 memcpy's an int32 into
  the float field, so a naive read shows `1` as `1.4e-45` and a naive write of
  `1` stores `1065353216` — which PX4 then echoes back as success.
- **One vehicle, locked on.** The first autopilot heartbeat fixes sysid/compid.
  Other sources (a second GCS, a companion) can never overwrite mode or armed
  state, and TX targets the learned ids rather than a hard-coded 1.
- **No `NaN`/`Infinity` on the wire.** `json.dumps` emits them happily and the
  browser's `JSON.parse` rejects them, so one NaN would poison every frame.
  Non-finite floats are sent as `null`.
- **The transport reopens.** A serial device that is not plugged in yet, or a
  dead TCP peer, is retried with backoff instead of killing the daemon.
- **A malformed WS message is acked, not fatal.** It used to close the socket and
  silently drop that client's command authority.
- **`PARAM_VALUE`s are coalesced** into `params` batches, so a ~1000-parameter
  refresh is a few dozen WS messages rather than a thousand.

## Tests

```bash
uv run pytest -q      # 46 tests: fake-PX4 integration + mav-thread unit tests
```

Ports come from a fixture that allocates free ones, so suites never collide.
