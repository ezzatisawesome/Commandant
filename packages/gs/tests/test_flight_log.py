"""The flight log is only worth having if something else can read it.

Every test here that matters reads the log back with pymavlink rather than
asserting bytes landed on disk: "we wrote 400 records" is a claim about this
code, and "MAVExplorer can replay it" is a claim about the thing we actually
need. Only the second one survives a bad day in the field.
"""

from __future__ import annotations

import os
import struct
import time

os.environ.setdefault("MAVLINK20", "1")

from pymavlink import mavutil                                    # noqa: E402
from pymavlink.dialects.v20 import common as m                   # noqa: E402

from gs.flightlog import FlightLog                               # noqa: E402


def _frames(n: int, start_boot: int = 1000) -> list[bytes]:
    """Real encoded MAVLink 2 frames, not stand-in bytes: the reader we are
    testing against parses them, so anything less tests nothing."""
    mav = m.MAVLink(None, srcSystem=1, srcComponent=1)
    out = []
    for i in range(n):
        msg = m.MAVLink_global_position_int_message(
            start_boot + i * 100, int(37.4e7), int(-122.1e7),
            100_000, 50_000, 0, 0, 0, 18_000)
        out.append(msg.pack(mav))
    return out


def _drain(log: FlightLog) -> None:
    """Wait for the writer thread to catch up, then flush to disk."""
    for _ in range(200):
        if log._q.empty():
            break
        time.sleep(0.01)
    log.stop()


def test_a_log_replays_through_pymavlink(tmp_path):
    """The whole point: open the file with the same library a ground station
    would, and get the messages back."""
    log = FlightLog(tmp_path).start()
    for f in _frames(50):
        log.write(f)
    _drain(log)

    conn = mavutil.mavlink_connection(str(log.path))
    boots = []
    while True:
        msg = conn.recv_match(type="GLOBAL_POSITION_INT", blocking=False)
        if msg is None:
            break
        boots.append(msg.time_boot_ms)
    assert len(boots) == 50, f"replayed {len(boots)} of 50"
    assert boots == [1000 + i * 100 for i in range(50)], "frames came back altered"


def test_timestamps_are_recoverable_and_ascending(tmp_path):
    log = FlightLog(tmp_path).start()
    for f in _frames(20):
        log.write(f)
        time.sleep(0.002)
    _drain(log)

    raw = log.path.read_bytes()
    stamps, off = [], 0
    while off < len(raw):
        stamps.append(struct.unpack(">Q", raw[off:off + 8])[0])
        length = raw[off + 8 + 1]          # MAVLink 2: len is the 2nd byte
        off += 8 + 12 + length             # header(10)+payload+crc(2)
    assert len(stamps) == 20
    assert stamps == sorted(stamps), "a log that goes backwards cannot be replayed"
    assert all(s > 1_577_836_800_000_000 for s in stamps), "not microseconds since epoch"


def test_a_wall_clock_step_cannot_rewind_the_log(monkeypatch, tmp_path):
    """The Pi has no RTC. When NTP finally answers, time.time() STEPS -- and a
    log whose timestamps jump backwards has a hole no reader can straighten
    out. Stamps come from one anchor plus monotonic deltas for this reason."""
    log = FlightLog(tmp_path)
    first = log.stamp_us()
    monkeypatch.setattr(time, "time", lambda: 0.0)   # clock yanked backwards
    second = log.stamp_us()
    assert second >= first, "a wall-clock step rewound the log"


def test_a_full_queue_drops_records_instead_of_blocking_the_link(tmp_path):
    """The alternative is back-pressure into the MAVLink receive loop, i.e. a
    disk stall quietly becoming a telemetry stall. Dropping is the lesser
    failure, and it is counted so nobody has to guess whether it happened."""
    log = FlightLog(tmp_path, queue_max=4)
    # Never started: nothing drains the queue, so it fills immediately.
    started = time.monotonic()
    for f in _frames(200):
        log.write(f)
    assert time.monotonic() - started < 1.0, "write() blocked on a full queue"
    assert log.dropped >= 190, f"only dropped {log.dropped}"


def test_a_disk_error_stops_logging_without_stopping_gs(tmp_path):
    log = FlightLog(tmp_path).start()
    log.write(_frames(1)[0])
    time.sleep(0.05)

    class Exploding:
        def write(self, *_a): raise OSError("No space left on device")
        def flush(self): pass
        def tell(self): return 0
        def close(self): pass

    log._fh = Exploding()
    log.write(_frames(1)[0])
    time.sleep(0.2)
    assert log.error is not None and "No space" in log.error
    assert not log.enabled, "kept queueing into a dead disk"
    log.write(_frames(1)[0])        # must not raise
    log.stop()


def test_rotation_keeps_the_directory_under_its_cap(tmp_path):
    """A hub that fills its SD card cannot write the log that would explain
    why it stopped flying."""
    log = FlightLog(tmp_path, max_file_bytes=2000, max_total_bytes=6000,
                    flush_interval_s=0.01)
    log.start()
    for f in _frames(400):
        log.write(f)
    _drain(log)

    files = list(tmp_path.glob("commandant-*.tlog"))
    total = sum(p.stat().st_size for p in files)
    assert log.rotations > 1, "never rotated"
    assert log.pruned > 0, "never pruned"
    # The cap is enforced at rotation, so the live file may carry it over by
    # one file's worth -- bounded, which is the property that matters.
    assert total <= 6000 + 2000 + 300, f"{total} bytes over a 6000 cap"


def test_an_unset_clock_is_named_as_such_not_dated_1970(monkeypatch, tmp_path):
    monkeypatch.setattr(time, "time", lambda: 1000.0)   # no RTC, never synced
    log = FlightLog(tmp_path).start()
    assert not log.clock_was_set
    assert "nortc" in log.path.name, log.path.name
    log.stop()
