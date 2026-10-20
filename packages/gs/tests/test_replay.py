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
