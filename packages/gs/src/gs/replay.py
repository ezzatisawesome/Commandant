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
# MAVLink 2 may append a 13-byte signature block, flagged in incompat_flags.
# The framing arithmetic here omitted it, so every signed frame left the reader
# 13 bytes short and it resynced a byte at a time: MEASURED, a 20-frame signed
# log replayed as 0 records, and one signed frame in an otherwise unsigned log
# lost exactly that record. pymavlink's own walker adds the same term.
MAVLINK_IFLAG_SIGNED = 0x01
MAVLINK_SIGNATURE_BLOCK_LEN = 13


class _NullConn:
    """Accepts and discards every send. See the module docstring."""

    def __init__(self) -> None:
        self.mav = self

    def __getattr__(self, _name: str) -> Any:
        return lambda *a, **k: None


def _mav_records(path: Path) -> Iterator[tuple[int, Any]]:
    """(stamp_us, message) from a tlog, in file order, STREAMED.

    The first version read and decoded the whole file before yielding anything,
    then sorted it with the sidecar. On a real flight's recording -- 470,000
    records -- that was 301 seconds before the first frame appeared, for a
    feature whose point is to look at a flight again. Both files are already
    in time order (one writer thread stamped them), so a lazy merge needs no
    sort and starts in milliseconds."""
    conn = mavutil.mavlink_connection(str(path))
    with open(path, "rb") as fh:
        while True:
            # stamp + magic + len + the third frame byte, which on MAVLink 2
            # is incompat_flags and says whether a signature block follows.
            head = fh.read(STAMP_BYTES + 3)
            if len(head) < STAMP_BYTES + 3:
                return
            stamp = struct.unpack(">Q", head[:STAMP_BYTES])[0]
            magic, length = head[STAMP_BYTES], head[STAMP_BYTES + 1]
            incompat = head[STAMP_BYTES + 2]
            if magic == 0xFD:
                rest = 12 + length - 3
                if incompat & MAVLINK_IFLAG_SIGNED:
                    rest += MAVLINK_SIGNATURE_BLOCK_LEN
            elif magic == 0xFE:
                rest = 8 + length - 3
            else:
                # A damaged record (a log cut off mid-write): resync by one byte.
                fh.seek(-(STAMP_BYTES + 2), 1)
                continue
            body = fh.read(rest)
            if len(body) < rest:
                return
            frame = head[STAMP_BYTES:] + body
            try:
                msg = conn.mav.decode(bytearray(frame))
            except Exception:
                continue
            if msg is None:
                continue
            # pymavlink fills the header for messages it can name and leaves
            # source 0/0 on the ones it cannot, which the vehicle filter then
            # drops. The source is right there in the frame; put it back. This
            # is why PX4 EVENTs decoded live and vanished on replay.
            if msg.get_srcSystem() == 0 and magic == 0xFD and frame[5]:
                msg._header.srcSystem = frame[5]
                msg._header.srcComponent = frame[6]
            yield stamp, msg


def _json_records(path: Path) -> Iterator[tuple[int, dict]]:
    if not path.exists():
        return
    # Streamed, like the tlog half. read_text().splitlines() held the whole
    # file twice over -- the str and the list of lines both live at once --
    # and records() primes the merge with next(js), so the cost landed before
    # the first record: MEASURED, a 65 MB sidecar left 229.9 MB resident at the
    # first yield. On a 1 GB Pi that is the OOM path, and it grows with the
    # length of the flight.
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            frame = rec.get("frame")
            if isinstance(frame, dict) and isinstance(rec.get("tUs"), int):
                yield rec["tUs"], frame


def records(tlog: Path) -> Iterator[tuple[int, str, Any]]:
    """Both halves of one flight, interleaved by their recorded timestamps,
    lazily: a one-item lookahead on each file, no sort, no upfront parse.

    The sidecar carries what MAVLink has no carrier for -- the solar and power
    model, the sim's wind -- so a replay of the tlog alone would be a replay of
    the flight with the aircraft's own power story missing."""
    mav = _mav_records(tlog)
    js = _json_records(tlog.with_suffix(".jsonl"))
    m = next(mav, None)
    j = next(js, None)
    while m is not None or j is not None:
        if j is None or (m is not None and m[0] <= j[0]):
            yield m[0], "mav", m[1]
            m = next(mav, None)
        else:
            yield j[0], "json", j[1]
            j = next(js, None)


def merged(tlog: Path) -> list[tuple[int, str, Any]]:
    """The whole flight in memory. Tests use it; replay() does not."""
    return list(records(tlog))


def replay(bridge: Any, tlog: str | Path, speed: float = 1.0,
           loop: bool = False) -> None:
    """Feed a recorded flight into `bridge` at its recorded cadence."""
    path = Path(tlog)
    print(f"[gs] replay: {path.name}{'' if speed == 1.0 else f' at {speed}x'}")
    conn = _NullConn()
    while True:
        prev = None
        n = 0
        first = last = None
        # A deadline, not a per-record sleep. Sleeping the gap is open loop:
        # every sleep overshoots by the scheduler's granularity and nothing
        # claws it back, so the error grows with the record count and --speed
        # stops meaning anything. MEASURED on a 2000-record log spanning 2.00 s:
        # 2.64 s of wall time at 1x (+32%), and 0.10 s at 100x against the
        # 0.02 s it asked for -- 5x slow. Carrying a target forward absorbs
        # each overshoot into the next wait instead of accumulating it.
        target = time.monotonic()
        for stamp, kind, payload in records(path):
            n += 1
            first = first if first is not None else stamp
            last = stamp
            gap = (stamp - prev) / 1e6 if prev is not None else 0.0
            prev = stamp
            if gap > 0:
                target += min(gap, MAX_GAP_S) / max(speed, 0.01)
                delay = target - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                elif delay < -MAX_GAP_S:
                    # Hopelessly behind (a slow handler, or a suspended hub):
                    # re-anchor rather than sprinting through the rest of the
                    # flight trying to make up time that is gone.
                    target = time.monotonic()
            try:
                if kind == "mav":
                    bridge._on_mav(conn, payload)
                else:
                    # _apply_json stamps last_json_at itself, under the lock.
                    bridge._apply_json(payload)
            except Exception as exc:
                bridge.handler_errors += 1
                print(f"[gs] replay: {kind} record failed: {exc}")
        if n == 0:
            print(f"[gs] replay: nothing readable in {path}")
            return
        span = (last - first) / 1e6
        print(f"[gs] replay: {n} records over {span:.0f}s from {path.name}")
        if not loop:
            break
        print("[gs] replay: looping")
