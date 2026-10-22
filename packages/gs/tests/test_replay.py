"""A recorded flight, flown again through the daemon that recorded it.

The design point worth protecting: replay does NOT reimplement the decode. It
feeds recorded frames through the same `_on_mav` and `_apply_json` the live link
uses, so the vehicle lock, the stream ages, the ownership arbitration and the
reboot discriminator all behave identically. A second decoder -- here or in the
browser -- would eventually disagree with the first, and a replay that disagrees
with the flight is worse than having no replay at all.
"""

from __future__ import annotations

import json
import os
import struct
from pathlib import Path

os.environ.setdefault("MAVLINK20", "1")

from pymavlink.dialects.v20 import common as m                   # noqa: E402

from gs.flightlog import FlightLog                               # noqa: E402
from gs.replay import _NullConn, merged, replay                  # noqa: E402

from test_flight_ready import _bridge, _capturing_loop           # noqa: E402


def _write_log(tmp_path, n=5, with_json=True):
    """A real log, written by the real recorder."""
    log = FlightLog(tmp_path, fsync_interval_s=0).start()
    mav = m.MAVLink(None, srcSystem=1, srcComponent=1)
    for i in range(n):
        hb = m.MAVLink_heartbeat_message(
            m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, 0, 3)
        log.write(hb.pack(mav))
        pos = m.MAVLink_global_position_int_message(
            1000 + i * 100, int(37.4e7) + i * 1000, int(-122.1e7),
            120_000, 100_000, 0, 0, 0, 18_000)
        log.write(pos.pack(mav))
        if with_json:
            log.write_json(json.dumps({"genW": 100 + i, "windN": 2.0}).encode())
    log.stop()
    return log.path


def test_a_recorded_flight_replays_through_the_live_code_path(tmp_path):
    path = _write_log(tmp_path, n=5)
    events: list = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    b.replaying = True
    replay(b, path, speed=1000.0)          # no waiting about

    assert b._vehicle == (1, 1), "the recorded heartbeats did not lock a vehicle"
    assert b.latest["lat"] > 37.4, "position never arrived"
    assert b.latest["genW"] == 104, "the JSON sidecar was not replayed"
    assert b.handler_errors == 0


def test_both_halves_interleave_by_their_recorded_timestamps(tmp_path):
    """The sidecar carries what MAVLink has no carrier for -- the solar and
    power model, the sim's wind -- so replaying the tlog alone would replay the
    flight with the aircraft's own power story missing."""
    path = _write_log(tmp_path, n=4)
    records = merged(path)
    kinds = {k for _, k, _ in records}
    assert kinds == {"mav", "json"}, kinds
    stamps = [r[0] for r in records]
    assert stamps == sorted(stamps), "records are not in recorded order"


def test_a_replay_transmits_nothing(tmp_path):
    """There is no vehicle to answer, and a replay that armed one would be a
    remarkable bug. The connection handed to the ingest path swallows sends."""
    conn = _NullConn()
    conn.mav.command_long_send(1, 1, 400, 0, 1, 0, 0, 0, 0, 0, 0)
    conn.mav.param_request_list_send(1, 1)
    conn.write(b"anything")                # must not raise, must do nothing


def test_every_frame_says_it_is_a_replay(tmp_path):
    """Announced once, a console that reloads or joins halfway through would
    read a recorded flight as the present one."""
    b = _bridge()
    b.replaying = True
    frame = b._frame() if hasattr(b, "_frame") else None
    if frame is None:              # built inside the broadcast loop
        import inspect
        src = inspect.getsource(type(b))
        assert 'frame["replay"] = True' in src
        assert "if self.replaying:" in src
    else:
        assert frame.get("replay") is True


def test_a_replay_does_not_record_itself(tmp_path):
    """Recording a replay would be recording our own echo, and it would also
    prune the real logs to make room for it."""
    b = _bridge(log_dir=str(tmp_path))
    assert b.flight_log is not None
    path = _write_log(tmp_path / "src", n=2)
    import threading
    b._serve = lambda: None                # do not start a websocket here
    try:
        b.run_replay(str(path))
    except Exception:
        pass
    assert b.flight_log is None, "a replay kept recording"


def test_a_damaged_record_does_not_stop_the_replay(tmp_path):
    """A log that was being written when the power went off ends mid-record."""
    path = _write_log(tmp_path, n=3)
    raw = path.read_bytes()
    path.write_bytes(raw + struct.pack(">Q", 1) + b"\x00\x01\x02")
    events: list = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    replay(b, path, speed=1000.0)
    assert b._vehicle == (1, 1), "the good records before the damage were lost"


def test_a_px4_event_in_a_recording_is_decoded_on_replay(tmp_path):
    """Live, PX4 EVENTs decoded fine. On replay they vanished: pymavlink leaves
    source 0/0 on a message it cannot name, and the vehicle filter dropped
    them. The frame is the real one recorded when PX4 refused a mission."""
    log = FlightLog(tmp_path, fsync_interval_s=0).start()
    mav = m.MAVLink(None, srcSystem=1, srcComponent=1)
    log.write(m.MAVLink_heartbeat_message(m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, 0, 3).pack(mav))
    log.write(bytes.fromhex("fd0d00007c01019a010091168101746b05001a000000638af1"))
    log.stop()

    events: list = []
    b = _bridge(events_meta=str(Path(__file__).parent / "fixtures" / "px4_events_min.json"))
    b._loop = _capturing_loop(events)
    replay(b, log.path, speed=1000.0)
    texts = [e for e in events if e.get("type") == "statustext"]
    assert texts, "the event never reached the console"
    assert texts[0]["text"] == "Mission rejected: Landing waypoint/pattern required"
    assert texts[0]["event"] == "navigator_mis_land_missing"


def test_replay_starts_streaming_rather_than_reading_the_whole_file_first(tmp_path):
    """301 seconds to the first frame on a real flight's recording was the
    pre-parse-and-sort design. A generator must not need the end of the file
    to produce the beginning."""
    from gs.replay import records
    path = _write_log(tmp_path, n=50)
    it = records(path)
    first = next(it)
    assert first[1] in ("mav", "json")


class _FakeBridge:
    """Just enough bridge for the clock and the reader: replay() only calls
    these two, and a real one would time its own decode into the measurement."""

    def __init__(self) -> None:
        self.handler_errors = 0
        self.seen = 0

    def _on_mav(self, conn, msg):
        self.seen += 1

    def _apply_json(self, frame):
        self.seen += 1


def _signing_mav():
    mav = m.MAVLink(None, srcSystem=1, srcComponent=1)
    mav.signing.secret_key = bytes(range(32))
    mav.signing.link_id = 0
    mav.signing.timestamp = 1
    mav.signing.sign_outgoing = True
    return mav


def test_a_signed_mavlink2_log_replays(tmp_path):
    """The framing arithmetic had no term for the 13-byte signature block, so
    every signed frame left the reader 13 bytes short and it resynced a byte at
    a time: a 20-frame signed log replayed as 0 records. A signed link is a
    configuration option on the vehicle, not an exotic one."""
    from gs.replay import _mav_records
    path = tmp_path / "signed.tlog"
    mav = _signing_mav()
    with open(path, "wb") as fh:
        for i in range(20):
            frame = m.MAVLink_heartbeat_message(
                m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, 0, 3).pack(mav)
            assert frame[2] & 0x01, "the fixture is not actually signed"
            fh.write(struct.pack(">Q", 1_000_000 + i * 1000) + frame)

    recs = list(_mav_records(path))
    assert len(recs) == 20, f"read {len(recs)} of 20 signed frames"
    assert all(r[1].get_type() == "HEARTBEAT" for r in recs)


def test_one_signed_frame_does_not_cost_its_own_record(tmp_path):
    """Mixed is the realistic case -- signing turned on mid-session, or one
    component signing. The short read used to eat exactly that record."""
    from gs.replay import _mav_records
    path = tmp_path / "mixed.tlog"
    plain, signed = m.MAVLink(None, srcSystem=1, srcComponent=1), _signing_mav()
    with open(path, "wb") as fh:
        for i, mav in enumerate((plain, signed, plain)):
            msg = m.MAVLink_global_position_int_message(
                1000 + i * 100, int(37.4e7), int(-122.1e7),
                100_000, 50_000, 0, 0, 0, 18_000)
            fh.write(struct.pack(">Q", 1_000_000 + i * 1000) + msg.pack(mav))

    boots = [r[1].time_boot_ms for r in _mav_records(path)]
    assert boots == [1000, 1100, 1200], boots


def test_the_sidecar_is_streamed_not_slurped(tmp_path):
    """read_text().splitlines() held the file twice over, and records() primes
    the merge with next(js), so the whole cost landed before the first record:
    a 65 MB sidecar left 229.9 MB resident at the first yield, which on a 1 GB
    Pi is the OOM path. The generator must never materialise the file."""
    import tracemalloc
    from gs import replay as rp

    big = tmp_path / "big.jsonl"
    with open(big, "w") as fh:
        for i in range(60_000):
            fh.write(json.dumps({"tUs": 1_000_000 + i, "frame": {"genW": i}}) + "\n")
    size = big.stat().st_size
    assert size > 2_000_000, size

    def no_slurp(self, *a, **k):
        raise AssertionError("the sidecar was read whole")

    orig = Path.read_text
    Path.read_text = no_slurp
    try:
        tracemalloc.start()
        it = rp._json_records(big)
        assert next(it)[0] == 1_000_000
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        assert sum(1 for _ in it) == 59_999, "records were lost while streaming"
    finally:
        Path.read_text = orig
    assert peak < size // 4, f"{peak} bytes held for a {size}-byte sidecar"


def test_speed_is_honoured_rather_than_drifted_past(tmp_path):
    """The clock was open loop: it slept each gap and nothing clawed back the
    overshoot, so the error grew with the record count. MEASURED on a
    2000-record log spanning 2.00 s: 2.64 s at 1x (+32%) and 0.10 s at 100x
    against the 0.02 s asked for, 5x slow. A deadline absorbs each overshoot
    into the next wait."""
    import time as _time
    path = tmp_path / "fast.tlog"
    mav = m.MAVLink(None, srcSystem=1, srcComponent=1)
    frame = m.MAVLink_heartbeat_message(
        m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, 0, 3).pack(mav)
    n = 4000
    with open(path, "wb") as fh:
        for i in range(n):            # 1 ms apart: 4.00 s of recorded flight
            fh.write(struct.pack(">Q", 1_000_000 + i * 1000) + frame)

    b = _FakeBridge()
    t0 = _time.monotonic()
    replay(b, path, speed=200.0)      # 4.00 s of flight asks for 0.02 s
    elapsed = _time.monotonic() - t0
    assert b.seen == n, b.seen
    # Open loop spent ~0.24 s here: 4000 sleeps of 5 us, each costing the
    # scheduler's ~60 us minimum and none of it ever recovered.
    assert elapsed < 0.12, f"{elapsed:.3f}s for 0.02s of replay at 200x"
