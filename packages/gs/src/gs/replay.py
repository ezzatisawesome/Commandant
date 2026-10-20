"""Fly a recorded flight again, through the daemon that recorded it.

gs writes a `.tlog` and a `.jsonl` sidecar, and until now nothing in Commandant
could open either: "what happened on that flight" meant leaving for MAVExplorer,
which answers questions about MAVLink rather than about what the operator saw.

The decode is NOT reimplemented here, and that is the whole design. A replay
feeds the recorded frames through `Bridge._on_mav` and `Bridge._apply_json` --
the same vehicle lock, the same stale-stream ages, the same draft/vehicle
arbitration, the same reboot discriminator -- so the console sees the flight
through the code that handled it live. A second decoder, in the browser or here,
would eventually disagree with the first, and a replay that disagrees with the
flight is worse than no replay.

Nothing is transmitted. The connection handed to the ingest path swallows every
send, because there is no vehicle to answer and a replay that tried to arm one
would be a remarkable bug.
"""

from __future__ import annotations

import json
import struct
import time
from pathlib import Path
from typing import Any, Iterator

from pymavlink import mavutil

# A tlog record is an 8-byte big-endian microsecond stamp then the raw frame.
STAMP_BYTES = 8
# Long gaps are compressed rather than waited out: a log with the vehicle
# powered off for ten minutes should not make the operator sit through it.
MAX_GAP_S = 2.0


class _NullConn:
    """Accepts and discards every send. See the module docstring."""

    def __init__(self) -> None:
        self.mav = self

    def __getattr__(self, _name: str) -> Any:
        return lambda *a, **k: None


def _mav_records(path: Path) -> Iterator[tuple[int, Any]]:
    """(stamp_us, message) from a tlog, in file order.

    pymavlink reads this format directly; the stamps are read separately
    because its own clock handling is not what we are pacing from."""
    conn = mavutil.mavlink_connection(str(path))
    raw = path.read_bytes()
    off = 0
    while off + STAMP_BYTES < len(raw):
        stamp = struct.unpack(">Q", raw[off:off + STAMP_BYTES])[0]
        # MAVLink 2: magic, len, ... — the length byte gives the payload size.
        body = raw[off + STAMP_BYTES:]
        if not body:
            break
        magic = body[0]
        if magic == 0xFD:
            total = 12 + body[1]
        elif magic == 0xFE:
            total = 8 + body[1]
        else:
            off += 1            # resync on a damaged record
            continue
        frame = body[:total]
        off += STAMP_BYTES + total
        msg = conn.mav.decode(bytearray(frame)) if frame else None
        if msg is not None:
            yield stamp, msg


def _json_records(path: Path) -> Iterator[tuple[int, dict]]:
    if not path.exists():
        return
    for line in path.read_text(errors="replace").splitlines():
        try:
            rec = json.loads(line)
        except Exception:
            continue
        frame = rec.get("frame")
        if isinstance(frame, dict) and isinstance(rec.get("tUs"), int):
            yield rec["tUs"], frame


def merged(tlog: Path) -> list[tuple[int, str, Any]]:
    """Both halves of one flight, interleaved by their recorded timestamps.

    The sidecar carries what MAVLink has no carrier for -- the solar and power
    model, the sim's wind -- so a replay of the tlog alone would be a replay of
    the flight with the aircraft's own power story missing."""
    out: list[tuple[int, str, Any]] = []
    for stamp, msg in _mav_records(tlog):
        out.append((stamp, "mav", msg))
    for stamp, frame in _json_records(tlog.with_suffix(".jsonl")):
        out.append((stamp, "json", frame))
    out.sort(key=lambda r: r[0])
    return out


def replay(bridge: Any, tlog: str | Path, speed: float = 1.0,
           loop: bool = False) -> None:
    """Feed a recorded flight into `bridge` at its recorded cadence."""
    path = Path(tlog)
    records = merged(path)
    if not records:
        print(f"[gs] replay: nothing readable in {path}")
        return
    span = (records[-1][0] - records[0][0]) / 1e6
    print(f"[gs] replay: {len(records)} records over {span:.0f}s from {path.name}"
          f"{'' if speed == 1.0 else f' at {speed}x'}")
    conn = _NullConn()
    while True:
        prev = records[0][0]
        for stamp, kind, payload in records:
            gap = (stamp - prev) / 1e6
            prev = stamp
            if gap > 0:
                time.sleep(min(gap, MAX_GAP_S) / max(speed, 0.01))
            try:
                if kind == "mav":
                    bridge._on_mav(conn, payload)
                else:
                    # _apply_json stamps last_json_at itself, under the lock.
                    bridge._apply_json(payload)
            except Exception as exc:
                bridge.handler_errors += 1
                print(f"[gs] replay: {kind} record failed: {exc}")
        if not loop:
            break
        print("[gs] replay: looping")
