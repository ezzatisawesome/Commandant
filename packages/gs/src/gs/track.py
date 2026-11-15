"""The run so far, kept so a console that connects late still sees it.

The console draws the flown path, the commanded path and its sparklines from
the frames it has received since it loaded. Reload the page, or open a second
one, and all of that was gone: a fresh tab saw the aircraft where it was now
and nothing of where it had been. gs is the one process that has seen every
frame of the run, so it keeps a bounded copy and hands it to each client as
it connects (one `history` message, ws-contract.md), before live telemetry.

The run ends where the vehicle's does: a reboot (every SITL run starts a new
PX4; the HITL rig reboots the board) clears it, so a new run never inherits
the last one's track.

Thinned the way the console thins its own trail (console src/stores/aircraft.store.ts
-- TRAIL_MIN_STEP_M, TRAIL_JUMP_M, TRAIL_MAX, HISTORY_INTERVAL_MS, HISTORY_MAX),
so a replayed track and a live one are the same polyline. Those numbers are
the console's; they are restated here because the two packages share no code.
"""

from __future__ import annotations

import math
import threading
from typing import Any, Optional

TRACK_MIN_STEP_M = 2.0       # a new vertex only once the aircraft has moved this far
TRACK_JUMP_M = 2000.0        # a single frame this far from the last is a glitch: dropped
TRACK_MAX = 3000             # points per path
HISTORY_INTERVAL_MS = 250    # one frame per this, for the sparklines
HISTORY_MAX = 480            # ~2 minutes of them

_EARTH_R_M = 6371000.0

Point = list  # [lat, lon, alt]


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(v)


def _has_fix(lat: Any, lon: Any) -> bool:
    """Both finite and not the (0, 0) sentinel an uninitialised frame carries."""
    return _finite(lat) and _finite(lon) and (abs(lat) > 1e-4 or abs(lon) > 1e-4)


def _dist_m(a: Point, b: Point) -> float:
    """Straight-line metres between two [lat, lon, alt] points (local flat earth:
    exact enough at the 2 m / 2 km scales it decides between)."""
    lat0 = math.radians((a[0] + b[0]) / 2)
    dn = math.radians(b[0] - a[0]) * _EARTH_R_M
    de = math.radians(b[1] - a[1]) * _EARTH_R_M * math.cos(lat0)
    return math.sqrt(dn * dn + de * de + (b[2] - a[2]) ** 2)


def _append(path: list[Point], p: Point) -> None:
    if path:
        d = _dist_m(path[-1], p)
        if d > TRACK_JUMP_M or d < TRACK_MIN_STEP_M:
            return
    path.append(p)
    if len(path) > TRACK_MAX:
        del path[: len(path) - TRACK_MAX]


class RunTrack:
    """The current run's flown path, commanded path and recent frames."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._flown: list[Point] = []
        self._target: list[Point] = []
        self._frames: list[dict] = []
        self._last_frame_up: Optional[int] = None

    def add(self, frame: dict) -> None:
        """One broadcast telemetry frame. Only a live link's frames count: a
        stale frame repeats the last position and would only pad the history."""
        if not frame.get("connected"):
            return
        with self._lock:
            up = frame.get("upMs")
            if (self._last_frame_up is None or not _finite(up)
                    or up - self._last_frame_up >= HISTORY_INTERVAL_MS):
                self._last_frame_up = up if _finite(up) else None
                self._frames.append(frame)
                if len(self._frames) > HISTORY_MAX:
                    del self._frames[: len(self._frames) - HISTORY_MAX]
            alt = frame.get("alt")
            if not (_has_fix(frame.get("lat"), frame.get("lon")) and _finite(alt)):
                return
            _append(self._flown, [frame["lat"], frame["lon"], alt])
            # The setpoint at the aircraft's altitude, as the console draws it.
            if _has_fix(frame.get("targetLat"), frame.get("targetLon")):
                _append(self._target, [frame["targetLat"], frame["targetLon"], alt])

    def clear(self) -> None:
        with self._lock:
            self._flown, self._target, self._frames = [], [], []
            self._last_frame_up = None

    def message(self) -> dict:
        """The `history` message a newly connected client gets first."""
        with self._lock:
            return {"type": "history", "track": list(self._flown),
                    "target": list(self._target), "frames": list(self._frames)}
