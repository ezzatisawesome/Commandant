# gs — Commandant ground-station daemon

Standalone Python daemon (pymavlink, **no MAVSDK**) that owns the MAVLink link to
PX4 and exposes a thin WS/HTTP contract to the `console` UI. It holds the
command-authority and protocol state machines (arm/mode, params, missions) and
the SIL-rehearsal gateway. See [`../../docs/roadmap.md`](../../docs/roadmap.md).

Why a separate process (not inside Next): a hot-reloading web framework must
never own arm/disarm or a mission upload.

## Dev

```bash
cd packages/gs
uv venv && uv pip install -e ".[dev]"   # or: python -m venv .venv && pip install -e ".[dev]"
python -m gs --help
```

## Architecture (target)

```
PX4 SITL ─udp─> mavlink-router ─┬─> AircraftSim mavlink_io
                                ├─> gs (this daemon) ─WS/HTTP─> console UI
                                └─> (QGC, optional)
```

Reuses the arm / set_mode / takeoff / battery-injection patterns from
`AircraftSim/src/px4/mavlink_io.py`.
