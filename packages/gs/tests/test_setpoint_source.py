"""Who owns the commanded-path overlay: PX4, or the sim's JSON feed?

The orange path sat 2310 m from the aircraft on a live run, holding a CONSTANT
offset while the aircraft flew 302 m. A distant destination would have closed;
an orbit would have kept a fixed CENTRE. A bias that rides along with the
aircraft means two different origins — the sim projects its setpoint about its
own home (AircraftSim systems/flightlink.py) while the position comes from PX4's
estimator about PX4's origin.

So PX4's POSITION_TARGET_GLOBAL_INT now wins whenever it is arriving, and the
JSON target is the fallback for a flightdyn-only run with no autopilot. These
tests pin that priority in both directions, because the failure it prevents is
invisible: the overlay looks plausible and simply never converges.
"""
from __future__ import annotations

import socket
import threading
import time

from gs.bridge import TARGET_SOURCE_TTL_MS, Bridge
from pymavlink import mavutil

# One port trio per test: each Bridge binds its own UDP sockets and its thread
# outlives the test, so sharing ports makes the second test silently talk to the
# first test's bridge (observed as "Address already in use" and a None target).
PORTS = {
    "beats": (14991, 14992, 8791),
    "resumes": (14993, 14994, 8792),
    "group": (14995, 14996, 8793),
}

# The sim's (wrong, origin-shifted) target, and PX4's real one.
JSON_TARGET = (37.396951, -122.164862)
MAV_TARGET = (37.3975, -122.1358)


def _bridge(which: str):
    mav, js, ws = PORTS[which]
    return Bridge(
        mavlink_endpoint=f"udpin:127.0.0.1:{mav}",
        json_port=js,
        ws_port=ws,
    ), mav, js


def _send_json(payload: dict, port: int) -> None:
    import json as _json
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(_json.dumps(payload).encode(), ("127.0.0.1", port))
    s.close()


def _mav_target(port: int) -> None:
    """Feed one usable POSITION_TARGET_GLOBAL_INT straight through the handler."""
    tx = mavutil.mavlink_connection(
        f"udpout:127.0.0.1:{port}", source_system=1, source_component=1,
    )
    tx.mav.position_target_global_int_send(
        0,
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        0,  # type_mask: nothing ignored, so the position is valid
        int(MAV_TARGET[0] * 1e7), int(MAV_TARGET[1] * 1e7), 150.0,
        0, 0, 0, 0, 0, 0, 0, 0,
    )
    tx.close()


def test_px4_setpoint_beats_the_sim_json_target():
    bridge, mav_port, js_port = _bridge("beats")
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    threading.Thread(target=bridge._json_loop, daemon=True).start()
    time.sleep(0.4)

    # The sim claims a target first — this is the one that used to win.
    _send_json({"targetLat": JSON_TARGET[0], "targetLon": JSON_TARGET[1], "targetAlt": 211.5}, js_port)
    time.sleep(0.3)
    with bridge._lock:
        assert bridge.latest.get("targetLat") == JSON_TARGET[0], "JSON is the fallback, so it applies when nothing else has spoken"

    # PX4 speaks. From here the overlay must follow the autopilot.
    _mav_target(mav_port)
    time.sleep(0.5)
    with bridge._lock:
        assert bridge.latest["targetLat"] == MAV_TARGET[0]
        assert bridge.latest["targetLon"] == MAV_TARGET[1]

    # ...and a further JSON frame must not drag it back.
    _send_json({"targetLat": JSON_TARGET[0], "targetLon": JSON_TARGET[1], "targetAlt": 211.5}, js_port)
    time.sleep(0.3)
    with bridge._lock:
        assert bridge.latest["targetLat"] == MAV_TARGET[0], "the sim's origin-shifted target must not override PX4's"
        assert bridge.latest["targetLon"] == MAV_TARGET[1]


def test_json_target_resumes_when_px4_stops_streaming():
    # A flightdyn-only run has no autopilot at all, so the JSON feed is not a
    # second opinion there — it is the only one. Dropping it outright would have
    # removed the overlay from those runs entirely.
    bridge, _mav_port, js_port = _bridge("resumes")
    with bridge._lock:
        bridge._mav_target_at = 0  # PX4 has never spoken
    threading.Thread(target=bridge._json_loop, daemon=True).start()
    time.sleep(0.3)

    _send_json({"targetLat": JSON_TARGET[0], "targetLon": JSON_TARGET[1]}, js_port)
    time.sleep(0.3)
    with bridge._lock:
        assert bridge.latest.get("targetLat") == JSON_TARGET[0]


def test_target_fields_are_accepted_as_one_group():
    # A latitude from one source and a longitude from the other is a point that
    # exists nowhere, so the three fields are taken or refused together.
    bridge, _mav_port, js_port = _bridge("group")
    threading.Thread(target=bridge._json_loop, daemon=True).start()
    time.sleep(0.3)
    with bridge._lock:
        # Pretend PX4 spoke a moment ago.
        bridge._mav_target_at = int(time.time() * 1000)
        bridge.latest["targetLat"] = MAV_TARGET[0]
        bridge.latest["targetLon"] = MAV_TARGET[1]

    _send_json({"targetLat": JSON_TARGET[0], "targetLon": JSON_TARGET[1], "targetAlt": 999.0}, js_port)
    time.sleep(0.3)
    with bridge._lock:
        assert bridge.latest["targetLat"] == MAV_TARGET[0]
        assert bridge.latest["targetLon"] == MAV_TARGET[1]
        # Not a mix: the altitude from the refused source must not leak through.
        assert bridge.latest.get("targetAlt") != 999.0


def test_the_ttl_is_long_enough_to_bridge_one_dropped_setpoint():
    # PX4 streams POSITION_TARGET at a few hertz on request. The window has to
    # outlast a gap of a few frames, or the JSON target would flicker back in
    # between them and the overlay would jump 2 km and return.
    assert TARGET_SOURCE_TTL_MS >= 1000
