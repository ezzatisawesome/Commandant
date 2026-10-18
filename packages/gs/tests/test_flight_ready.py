"""Hypothesis probes: what stops gs from being plug-and-play against a real PX4.

Each test here was written to FAIL first, as evidence for a specific fault, and
then to pin the fix. The faults are the ones that only show up when the link is
a real radio rather than localhost UDP, or when PX4 is driven by HITL rather
than by the sim's own JSON feed.
"""

from __future__ import annotations

import socket
import threading
import time
from types import SimpleNamespace

import pytest
from pymavlink import mavutil

from gs import bridge as bridgemod
from gs.bridge import Bridge

m = mavutil.mavlink


class RecordingMav:
    def __init__(self, on_send=None):
        self.sent: list[tuple[str, tuple]] = []
        self._on_send = on_send

    def __getattr__(self, name):
        if name.endswith("_send"):
            def _send(*args):
                if self._on_send:
                    self._on_send(name)
                self.sent.append((name, args))
            return _send
        raise AttributeError(name)


class RecordingConn:
    def __init__(self, on_send=None):
        self.mav = RecordingMav(on_send)
        self.closed = False

    def recv_match(self, blocking=True, timeout=0.5):
        time.sleep(0.01)
        return None

    def close(self):
        self.closed = True


def _msg(mtype: str, src=(1, 1), **fields):
    ns = SimpleNamespace(**fields)
    ns.get_type = lambda: mtype
    ns.get_srcSystem = lambda: src[0]
    ns.get_srcComponent = lambda: src[1]
    return ns


def _heartbeat(**over):
    f = dict(type=m.MAV_TYPE_FIXED_WING, autopilot=m.MAV_AUTOPILOT_PX4,
             base_mode=0, custom_mode=1 << 16, system_status=m.MAV_STATE_ACTIVE)
    f.update(over)
    return _msg("HEARTBEAT", **f)


def _bridge(**kw):
    kw.setdefault("mavlink_endpoint", "udpin:127.0.0.1:1")
    b = Bridge(**kw)

    class Loop:
        def call_soon_threadsafe(self, fn, *a):
            pass
    b._loop = Loop()
    return b


def _capturing_loop(sink: list):
    """A stand-in for the asyncio loop that records whatever the mav thread
    schedules. `_broadcast` hands over a JSON string; the ack emitters hand over
    a dict -- decode the former so a test can treat both as dicts."""
    import json as _json

    class Loop:
        def call_soon_threadsafe(self, fn, *a):
            if a and isinstance(a[0], str):
                try:
                    sink.append(_json.loads(a[0]))
                    return
                except ValueError:
                    pass
            if a:
                sink.append(a[0])
    return Loop()


# --- H1: gs never identifies itself to PX4 as a ground station --------------

def test_h1_gs_sends_a_gcs_heartbeat():
    """PX4 decides a GCS is connected by receiving HEARTBEATs from it
    (MavlinkReceiver::handle_message_heartbeat -> telemetry_status
    .heartbeat_type_gcs -> commander's data_link_check). A GCS that never
    heartbeats is, to PX4, a GCS that was never there: it logs "Data link
    lost", and with NAV_DLL_ACT set -- which is the norm for any flight past
    line of sight -- it runs the datalink-loss failsafe mid-mission. Every
    real GCS (QGC, MAVProxy, MP) emits 1 Hz. gs must too."""
    b = _bridge()
    conn = RecordingConn()
    b._service_heartbeat(conn)
    hb = [s for s in conn.mav.sent if s[0] == "heartbeat_send"]
    assert len(hb) == 1, "no GCS heartbeat was ever transmitted"
    _, args = hb[0]
    assert args[0] == m.MAV_TYPE_GCS
    assert args[1] == m.MAV_AUTOPILOT_INVALID, "a GCS must not claim to be an autopilot"


def test_h1_gcs_heartbeat_is_rate_limited_to_1hz():
    b = _bridge()
    conn = RecordingConn()
    for _ in range(50):          # the mav loop calls the servicers ~2 Hz..200 Hz
        b._service_heartbeat(conn)
    assert len([s for s in conn.mav.sent if s[0] == "heartbeat_send"]) == 1


# --- H2: stream requests ignore how much bandwidth the link actually has ----

@pytest.mark.parametrize("endpoint,budgeted", [
    ("udpin:0.0.0.0:14550", False),          # localhost/WiFi: plenty
    ("serial:/dev/ttyUSB0:57600", True),     # SiK radio: ~5 kB/s, shared
])
def test_h2_stream_rate_is_budgeted_for_the_transport(endpoint, budgeted):
    """ACTUATOR_OUTPUT_STATUS is a ~140-byte message. gs asks for it, WIND_COV
    and POSITION_TARGET_GLOBAL_INT at a hardcoded 25 Hz. Over a 57600-baud SiK
    link (~5 kB/s of usable goodput, already carrying PX4's own GCS stream)
    that single request alone is ~3.5 kB/s. The link saturates, the radio drops
    frames, and *commands* are what gets lost -- the opposite of what a GCS is
    for. The requested interval has to come from a bandwidth budget."""
    b = _bridge(mavlink_endpoint=endpoint)
    conn = RecordingConn()
    b._request_message(conn, 1, 1, bridgemod.MSG_ACTUATOR_OUTPUT_STATUS)
    sent = [s for s in conn.mav.sent if s[0] == "command_long_send"]
    assert sent, "no SET_MESSAGE_INTERVAL was sent"
    interval_us = sent[0][1][5]
    hz = 1e6 / interval_us
    if budgeted:
        assert hz <= 5.0, f"asked PX4 for {hz:g} Hz of a 140-byte message over a 57600 radio"
    else:
        assert hz >= 10.0, f"needlessly throttled a fat-pipe link to {hz:g} Hz"


# --- H3: transport writes happen while the telemetry lock is held -----------

def test_h3_no_mavlink_write_happens_under_the_telemetry_lock():
    """`_on_mav` does its whole dispatch inside `with self._lock`, and several
    branches transmit from there (mission item sends, mission acks, message
    requests). On UDP a send is a memcpy, so this never showed. On the hub the
    link is a serial port: a write that blocks for even 100 ms holds the lock,
    and the 25 Hz WS broadcast -- which takes the same lock -- stalls the whole
    asyncio loop. WS pings stop with it, so every console disconnects while the
    aircraft is fine. The lock protects `latest`; it must not span I/O."""
    held: list[str] = []

    def on_send(name):
        if not b._lock.acquire(blocking=False):
            held.append(name)
        else:
            b._lock.release()

    b = _bridge()
    conn = RecordingConn(on_send)
    b._vehicle = (1, 1)
    # A heartbeat with no actuator data yet triggers the three _request_message sends.
    b._on_mav(conn, _heartbeat())
    # A mission upload answering the autopilot's item request.
    b._mission = {"op": "upload", "id": "u1", "mtype": 0, "rtype": "mission",
                  "ack_type": "mission_ack", "count": 1, "last": 0, "tries": 0,
                  "items": [bridgemod.mission_item_fields(0, {"kind": "waypoint",
                                                              "lat": 1.0, "lon": 2.0, "alt": 30})]}
    b._on_mav(conn, _msg("MISSION_REQUEST_INT", seq=0, mission_type=0))
    assert held == [], f"these transmitted while holding the telemetry lock: {held}"


# --- H4: the sim's JSON feed outranks a live autopilot ----------------------

def test_h4_json_feed_cannot_overwrite_a_live_autopilots_flight_state(ports):
    """The flightlink JSON feed is documented as the sim's *no-PX4* path, but
    nothing enforces that. In HITL both are live, and `_json_loop` writes
    lat/lon/alt/attitude/mode/armed straight over whatever MAVLink just put
    there, with no TTL and no arbitration -- the two sources interleave and the
    aircraft visibly jitters between the autopilot's estimate and the sim's
    truth. Worse, `armed`/`mode` from the sim can contradict the autopilot the
    operator is commanding. Once a vehicle is locked, MAVLink owns flight
    state; JSON keeps only what MAVLink has no carrier for (the power model)."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=b._json_loop, daemon=True).start()
    conn = RecordingConn()
    b._on_mav(conn, _heartbeat(base_mode=128, custom_mode=(4 << 16) | (4 << 24)))
    b._on_mav(conn, _msg("GLOBAL_POSITION_INT", time_boot_ms=1000,
                         lat=374000000, lon=-1221000000, alt=120000, hdg=9000,
                         vx=1500, vy=0, vz=0))
    assert b.latest["mode"] == "AUTO.MISSION" and b.latest["armed"] is True

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blob = (b'{"lat": 0.5, "lon": 0.5, "alt": 9999.0, "mode": "MANUAL", '
            b'"armed": false, "genW": 123.0, "irradiance": 900.0}')
    for _ in range(60):
        s.sendto(blob, ("127.0.0.1", ports["json"]))
        if b.latest.get("genW") == 123.0:
            break
        time.sleep(0.05)
    assert b.latest.get("genW") == 123.0, "JSON feed never ingested"

    # Power-model keys: JSON is the only source, so they land.
    assert b.latest["irradiance"] == 900.0
    # Flight state: the autopilot is live and owns it.
    assert b.latest["lat"] == pytest.approx(37.4), "sim JSON overwrote the autopilot's position"
    assert b.latest["alt"] == pytest.approx(120.0)
    assert b.latest["mode"] == "AUTO.MISSION", "sim JSON overwrote the autopilot's mode"
    assert b.latest["armed"] is True, "sim JSON overwrote the autopilot's armed state"


def test_h4_json_still_owns_everything_with_no_autopilot():
    """The no-PX4 rig must be unchanged: with no vehicle locked, JSON is the
    only source of truth and still drives the full frame."""
    b = _bridge()
    assert b._vehicle is None
    assert b._json_owns("lat") and b._json_owns("mode") and b._json_owns("genW")
    b._vehicle = (1, 1)
    assert b._json_owns("genW") and not b._json_owns("lat")


# --- H5: the vehicle lock survives a reopen onto a different vehicle --------

def test_h5_vehicle_lock_is_released_when_the_link_is_reopened():
    """`_vehicle` locks onto the first autopilot heartbeat and -- before this --
    never let go. That is right for rejecting a companion computer on a live
    link, and wrong across a reopen: unplug the USB autopilot, attach the radio
    to an aircraft with a different MAV_SYS_ID, and every message from it is
    dropped by the `src != self._vehicle` guard. gs then shows a permanently
    `connecting` link with a healthy radio and no way out but a restart -- which
    is exactly the failure autodetect exists to prevent. A reopen is a new
    link, so it starts with no vehicle."""
    b = _bridge(mavlink_endpoint="udpin:127.0.0.1:1")
    conn = RecordingConn()
    b._on_mav(conn, _heartbeat())
    assert b._vehicle == (1, 1)
    b._on_reopen()
    assert b._vehicle is None, "a reopened link is still bound to the old vehicle"
    # The new aircraft, on a different sysid, is now heard.
    b._on_mav(conn, _msg("HEARTBEAT", src=(7, 1), type=m.MAV_TYPE_FIXED_WING,
                         autopilot=m.MAV_AUTOPILOT_PX4, base_mode=128,
                         custom_mode=1 << 16, system_status=m.MAV_STATE_ACTIVE))
    assert b._vehicle == (7, 1)
    assert b.latest["armed"] is True
    assert b.tsys == 7, "commands would still be addressed to the old vehicle"


# --- plug-and-play: one daemon, PX4 / HITL / aircraft, no configuration -----

def _fake_autopilot(port: int, stop: threading.Event, as_gcs: bool = False):
    """A minimal PX4 stand-in: heartbeats at 10 Hz to a UDP port, nothing else.
    This is the only thing autodetect is allowed to depend on, deliberately --
    it is what SITL, a HITL rig and a real airframe all have in common."""
    conn = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}",
                                      source_system=1, source_component=1)

    def run():
        while not stop.is_set():
            if as_gcs:
                conn.mav.heartbeat_send(m.MAV_TYPE_GCS, m.MAV_AUTOPILOT_INVALID, 0, 0,
                                        m.MAV_STATE_ACTIVE)
            else:
                conn.mav.heartbeat_send(m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4,
                                        0, 1 << 16, m.MAV_STATE_ACTIVE)
            time.sleep(0.1)
    threading.Thread(target=run, daemon=True).start()


def test_autodetect_finds_an_autopilot_on_udp(ports):
    stop = threading.Event()
    _fake_autopilot(ports["mav"], stop)
    try:
        candidates = ["serial:/dev/does-not-exist:57600",
                      f"udpin:127.0.0.1:{ports['mav']}"]
        assert bridgemod.detect_endpoint(candidates) == f"udpin:127.0.0.1:{ports['mav']}"
    finally:
        stop.set()


def test_autodetect_ignores_a_ground_station_on_the_wire(ports):
    """A second GCS (or gs's own heartbeat echoed by mavlink-router) heartbeats
    too. Locking onto it would give a green link to no aircraft at all."""
    stop = threading.Event()
    _fake_autopilot(ports["mav"], stop, as_gcs=True)
    try:
        assert bridgemod.detect_endpoint([f"udpin:127.0.0.1:{ports['mav']}"]) is None
    finally:
        stop.set()


def test_autodetect_never_exits_when_nothing_is_flying_yet(monkeypatch):
    """The hub boots with the plane. If the autopilot is not up yet, gs must
    fall back to PX4's default UDP port and keep listening -- and re-probe on
    the next reopen -- rather than give up at startup."""
    monkeypatch.setattr(bridgemod, "detect_endpoint", lambda *a, **k: None)
    b = _bridge(mavlink_endpoint=bridgemod.AUTODETECT)
    assert b._resolve_endpoint() == bridgemod.NET_CANDIDATES[0]


def test_link_budget_follows_the_transport_autodetect_actually_found(monkeypatch):
    """Under `auto` the transport -- and so the bandwidth -- is only known after
    the probe. The budget has to be recomputed there, or a radio found by
    autodetect gets asked for the fat-pipe rates (fault H2, via the back door)."""
    monkeypatch.setattr(bridgemod, "detect_endpoint",
                        lambda *a, **k: "serial:/dev/ttyUSB0:57600")
    monkeypatch.setattr(bridgemod, "open_connection", lambda *a, **k: RecordingConn())
    b = _bridge(mavlink_endpoint=bridgemod.AUTODETECT)
    assert b.link_budget_bps == bridgemod.NET_BUDGET_BPS   # the `auto` placeholder
    b._open_with_retry()
    assert b.active_endpoint == "serial:/dev/ttyUSB0:57600"
    assert b.link_budget_bps == pytest.approx(57600 / 10 * bridgemod.SERIAL_GOODPUT_FRACTION)
    conn = RecordingConn()
    b._request_message(conn, 1, 1, bridgemod.MSG_ACTUATOR_OUTPUT_STATUS)
    sent = next(s for s in conn.mav.sent if s[0] == "command_long_send")
    hz = 1e6 / sent[1][5]
    assert hz <= 5.0


# --- the whole claim, end to end --------------------------------------------

class FakePX4:
    """A PX4 stand-in that is deliberately indistinguishable from HITL or the
    real airframe: it heartbeats, streams a position, answers COMMAND_LONG with
    a COMMAND_ACK, and records what the GCS sent it. Nothing in it knows or
    cares which of the three it is pretending to be -- that is the property
    under test."""

    def __init__(self, gs_port: int):
        self.conn = mavutil.mavlink_connection(
            f"udpout:127.0.0.1:{gs_port}", source_system=1, source_component=1)
        self.gcs_heartbeats = 0
        self.commands: list[int] = []
        self.stream_requests: dict[int, int] = {}
        self.armed = False
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._tx, daemon=True).start()
        threading.Thread(target=self._rx, daemon=True).start()
        return self

    def stop(self):
        self._stop.set()

    def _tx(self):
        boot = 0
        while not self._stop.is_set():
            boot += 100
            self.conn.mav.heartbeat_send(
                m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4,
                128 if self.armed else 0, (4 << 16) | (4 << 24), m.MAV_STATE_ACTIVE)
            self.conn.mav.global_position_int_send(
                boot, 374000000, -1221000000, 120000, 9000, 1500, 0, 0, 9000)
            time.sleep(0.1)

    def _rx(self):
        while not self._stop.is_set():
            msg = self.conn.recv_match(blocking=True, timeout=0.2)
            if msg is None:
                continue
            t = msg.get_type()
            if t == "HEARTBEAT" and msg.type == m.MAV_TYPE_GCS:
                self.gcs_heartbeats += 1
            elif t == "COMMAND_LONG":
                if msg.command == m.MAV_CMD_SET_MESSAGE_INTERVAL:
                    self.stream_requests[int(msg.param1)] = int(msg.param2)
                    continue
                self.commands.append(msg.command)
                if msg.command == m.MAV_CMD_COMPONENT_ARM_DISARM:
                    self.armed = bool(msg.param1)
                self.conn.mav.command_ack_send(msg.command, m.MAV_RESULT_ACCEPTED)


def test_plug_and_play_end_to_end(ports, monkeypatch):
    """Point nothing at anything: `--mavlink auto`, one autopilot on the wire,
    and a console that connects to the default WS port. Assert the four things
    that have to hold for the daemon to be flight-ready against PX4, a HITL rig
    or the aircraft, with the same binary and no configuration:

      1. the transport is discovered, not configured;
      2. PX4 hears a GCS heartbeat, so it never declares the data link lost;
      3. telemetry reaches the console, attributed to the MAVLink source;
      4. a command round-trips and the vehicle's state changes because of it.
    """
    import asyncio
    import json as _json

    import websockets

    monkeypatch.setattr(bridgemod, "SERIAL_CANDIDATES", ())
    monkeypatch.setattr(bridgemod, "NET_CANDIDATES", (f"udpin:127.0.0.1:{ports['mav']}",))
    px4 = FakePX4(ports["mav"]).start()
    b = Bridge(mavlink_endpoint=bridgemod.AUTODETECT,
               json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=b._mav_loop, daemon=True).start()

    async def scenario():
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            # (1) discovered the transport on its own.
            for _ in range(60):
                if b.active_endpoint == f"udpin:127.0.0.1:{ports['mav']}":
                    break
                await asyncio.sleep(0.1)
            assert b.active_endpoint == f"udpin:127.0.0.1:{ports['mav']}"

            # (3) live telemetry, from MAVLink, with the link called alive.
            frame = None
            for _ in range(80):
                got = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                if got.get("type") == "telemetry" and got.get("linkState") == "alive":
                    frame = got
                    break
            assert frame is not None, "no live telemetry frame"
            assert frame["lat"] == pytest.approx(37.4)
            assert frame["mode"] == "AUTO.MISSION"
            assert frame["dataAgeMs"] is not None and frame["dataAgeMs"] < 2000

            # (2) PX4 is hearing from us. Without this it declares "Data link
            #     lost" and, with NAV_DLL_ACT set, failsafes out of the mission.
            for _ in range(40):
                if px4.gcs_heartbeats >= 2:
                    break
                await asyncio.sleep(0.1)
            assert px4.gcs_heartbeats >= 2, "PX4 never heard a GCS heartbeat from gs"

            # (4) a command round-trips, and the vehicle actually changed.
            await ws.send(_json.dumps({"type": "claim", "id": "k1"}))
            await ws.send(_json.dumps({"type": "command", "id": "a1", "name": "arm"}))
            ack = None
            for _ in range(80):
                got = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                if got.get("type") == "ack" and got.get("id") == "a1":
                    ack = got
                    break
            assert ack is not None and ack["ok"] is True, f"arm not acked: {ack}"
            assert m.MAV_CMD_COMPONENT_ARM_DISARM in px4.commands
            assert px4.armed is True
            for _ in range(40):
                got = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                if got.get("type") == "telemetry" and got.get("armed"):
                    break
            assert got.get("armed") is True, "the console never saw the vehicle arm"

            # And the extra streams were requested at the fat-pipe rate, since
            # this transport is UDP (the radio case is covered by H2).
            assert px4.stream_requests, "no SET_MESSAGE_INTERVAL reached PX4"
            assert all(iv == 40000 for iv in px4.stream_requests.values()), px4.stream_requests
        serve.cancel()

    try:
        asyncio.run(scenario())
    finally:
        px4.stop()


# --- H6: the MAVLink 2 dialect must not depend on import order -------------

def test_h6_v2_only_messages_exist_whatever_the_import_order():
    """`mavutil.mavlink` is bound to a dialect module when mavutil is imported,
    so gs's `MAVLINK20=1` only took effect if gs got there first. Import
    pymavlink before gs -- which the rehearsal gateway will do the moment it
    pulls in AircraftSim -- and the whole daemon runs on the v1 dialect. It does
    not error: ACTUATOR_OUTPUT_STATUS and WIND_COV just do not exist, so the
    actuator PWMs and the EKF wind estimate are silently never populated. This
    test is the import-order canary; `bridge` rebinds the dialect explicitly.
    (The reordering of this file's own imports is what surfaced it.)"""
    import subprocess
    import sys
    code = (
        "from pymavlink import mavutil\n"              # v1 dialect binds here
        "from gs import bridge\n"
        "assert bridge.mavutil.mavlink.__name__.endswith('v20.all'), "
        "bridge.mavutil.mavlink.__name__\n"
        "assert bridge.MSG_ACTUATOR_OUTPUT_STATUS == 375\n"
        "assert bridge.MSG_WIND_COV == 231\n"
        "assert bridge.message_bytes(375) > 100\n"
        "print('ok')\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert "ok" in out.stdout


# --- H7: a stalled mission upload restarted from scratch -------------------

def _upload(b, conn, n=10):
    items = [{"kind": "waypoint", "lat": 37.0 + i * 1e-4, "lon": -122.0, "alt": 50}
             for i in range(n)]
    b._mission_queue.put({"kind": "push", "id": "m1", "items": items,
                          "mtype": bridgemod.MAV_MISSION_TYPE_MISSION,
                          "rtype": "mission", "ack_type": "mission_ack"})
    b._service_missions(conn)
    return items


def test_h7_a_stalled_upload_retransmits_one_item_not_the_whole_mission(monkeypatch):
    """Mid-upload, a stall means exactly one packet was lost -- the autopilot's
    MISSION_REQUEST_INT, or our MISSION_ITEM_INT answering it. Re-sending
    MISSION_COUNT makes the autopilot discard everything and restart at seq 0,
    so one lost frame costs the whole mission again and MISSION_MAX_TRIES is
    spent retransmitting items that already arrived. MEASURED against a
    3.4 kB/s / 120 ms link at 5 % loss: a 40-item upload burned all three
    kickoffs and took 9.4 s, i.e. it succeeded with zero margin."""
    monkeypatch.setattr(bridgemod, "MISSION_OP_TIMEOUT_MS", 0)
    b = _bridge()
    conn = RecordingConn()
    _upload(b, conn)
    assert [s[0] for s in conn.mav.sent] == ["mission_count_send"]

    # The autopilot works through seq 0..3, then goes quiet.
    for seq in range(4):
        b._on_mav_protocol(conn, 0, "MISSION_REQUEST_INT",
                           _msg("MISSION_REQUEST_INT", seq=seq, mission_type=0))
    assert b._mission["last_seq"] == 3
    conn.mav.sent.clear()

    # The stall retry must retransmit seq 3, not restart the transfer. (Zero the
    # progress clock rather than sleep, so the test is not a timing race.)
    b._mission["last"] = 0
    b._service_missions(conn)
    assert [s[0] for s in conn.mav.sent] == ["mission_item_int_send"], \
        "a lost frame restarted the whole upload"
    assert conn.mav.sent[0][1][2] == 3, "retransmitted the wrong sequence number"
    # And the progress already made is not thrown away.
    assert b._mission is not None and b._mission["count"] == 10


def test_h7_mission_count_is_still_resent_when_the_kickoff_went_unanswered(monkeypatch):
    """The one case re-sending MISSION_COUNT is right for: the autopilot never
    acknowledged the kickoff, so there is no transfer in progress to resume."""
    monkeypatch.setattr(bridgemod, "MISSION_OP_TIMEOUT_MS", 0)
    b = _bridge()
    conn = RecordingConn()
    _upload(b, conn)
    conn.mav.sent.clear()
    b._mission["last"] = 0
    b._service_missions(conn)
    assert [s[0] for s in conn.mav.sent] == ["mission_count_send"]


def test_h7_upload_still_gives_up_eventually(monkeypatch):
    """Bounded retries survive the change: a vehicle that stops answering must
    still produce a timeout ack rather than a mission op pending forever."""
    monkeypatch.setattr(bridgemod, "MISSION_OP_TIMEOUT_MS", 0)
    acks = []
    b = _bridge()

    class Loop:
        def call_soon_threadsafe(self, fn, *a):
            acks.append(a[0])
    b._loop = Loop()
    conn = RecordingConn()
    _upload(b, conn)
    b._on_mav_protocol(conn, 0, "MISSION_REQUEST_INT",
                       _msg("MISSION_REQUEST_INT", seq=0, mission_type=0))
    for _ in range(bridgemod.MISSION_MAX_TRIES + 2):
        if b._mission is not None:
            b._mission["last"] = 0
        b._service_missions(conn)
    assert b._mission is None
    assert acks and acks[-1]["text"] == "timeout" and acks[-1]["ok"] is False


def test_h7_a_restart_loop_cannot_run_forever(monkeypatch):
    """The failure mode behind H7, pinned as a class.

    `tries` resets to 0 on every bit of progress, which is the right way to
    bound a *stall* -- and is exactly how the pre-fix retry livelocked: the
    MISSION_COUNT retry made the autopilot restart at seq 0, that request
    counted as progress, the budget reset, and round it went. MEASURED at 5 %
    loss on a 3.4 kB/s / 120 ms link: 39 restarts, no completion in 90 s, and
    no timeout ever reported. An upload that neither finishes nor fails is
    worse than one that fails, because the operator has nothing to act on.

    Simulated here by feeding progress-at-seq-0 after every retry, which is
    what a restarting autopilot looks like from gs's side."""
    monkeypatch.setattr(bridgemod, "MISSION_OP_TIMEOUT_MS", 0)
    acks = []
    b = _bridge()

    class Loop:
        def call_soon_threadsafe(self, fn, *a):
            acks.append(a[0])
    b._loop = Loop()
    conn = RecordingConn()
    _upload(b, conn, n=10)

    for _ in range(200):                      # pre-fix this never terminates
        if b._mission is None:
            break
        b._mission["last"] = 0
        b._mission["last_seq"] = None         # the restart threw progress away
        b._service_missions(conn)
        # The autopilot, having restarted, asks for seq 0 again -> "progress".
        b._on_mav_protocol(conn, 0, "MISSION_REQUEST_INT",
                           _msg("MISSION_REQUEST_INT", seq=0, mission_type=0))
    assert b._mission is None, "the upload neither completed nor failed"
    assert acks[-1]["ok"] is False
    assert acks[-1]["text"] == "timeout (restart loop)"
    kickoffs = len([s for s in conn.mav.sent if s[0] == "mission_count_send"])
    assert kickoffs <= bridgemod.MISSION_MAX_TRIES + 1, kickoffs


# --- H8: every duration was computed from the wall clock --------------------

class SteppedClock:
    """A `time.time` that jumps, the way NTP does on a machine with no RTC."""

    def __init__(self, delta_s: float):
        self.delta_s = delta_s
        self.real = time.time

    def __call__(self):
        return self.real() + self.delta_s


def test_h8_a_wall_clock_step_cannot_make_a_dead_link_look_alive(ports, monkeypatch):
    """The field hub is a Raspberry Pi with no RTC: it boots with a stale or
    zero clock and steps the moment it gets NTP, a GPS fix, or the operator sets
    the date. Every duration in gs was a wall-clock subtraction, so a BACKWARD
    step made `now - last_mav_at` negative, which is `< STALE_MS`, which is
    `alive`. MEASURED pre-fix on a frame that had just arrived: a 1 h backward
    step gave `linkState="alive", dataAgeMs=-3600000`, and it would keep saying
    so for an hour -- the stale-aircraft-shown-as-live failure this daemon
    exists to prevent, reintroduced through the clock.

    Here the autopilot goes silent AND the clock steps back an hour. Real
    elapsed time is what must decide, so the link has to go `lost`."""
    monkeypatch.setattr(bridgemod, "STALE_MS", 200)
    monkeypatch.setattr(bridgemod, "LOST_MS", 400)
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])
    conn = RecordingConn()

    async def scenario():
        import asyncio
        import json as _json

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            b._on_mav(conn, _heartbeat())            # one frame, then silence
            got = await _recv_telemetry(ws, lambda g: g.get("linkState") == "alive")
            assert got is not None, "never reported alive"

            monkeypatch.setattr(time, "time", SteppedClock(-3600.0))
            await asyncio.sleep(0.8)                 # real time well past LOST_MS
            seen = []
            for _ in range(20):
                f = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                if f.get("type") == "telemetry":
                    seen.append(f)
            assert seen, "no frames after the step"
            for f in seen:
                assert f["dataAgeMs"] is None or f["dataAgeMs"] >= 0, \
                    f"negative data age: {f['dataAgeMs']}"
            assert seen[-1]["linkState"] == "lost", \
                f"a dead link reported {seen[-1]['linkState']!r} after a backward clock step"
            assert seen[-1]["connected"] is False
        serve.cancel()

    import asyncio
    asyncio.run(scenario())


async def _recv_telemetry(ws, pred, tries=60):
    import asyncio
    import json as _json
    for _ in range(tries):
        try:
            got = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
        except asyncio.TimeoutError:
            continue
        if got.get("type") == "telemetry" and pred(got):
            return got
    return None


def test_h8_a_wall_clock_step_does_not_expire_in_flight_commands(monkeypatch):
    """The other direction, and measured rather than assumed.

    A forward step -- the usual one, since a hub without an RTC boots in the
    past and catches up -- makes `now - last_send_ms` huge, so the retry fires
    immediately. It does NOT abort the command: the retry re-bases
    `last_send_ms` to the new clock, after which everything is consistent
    again. MEASURED pre-fix: a single step (1 h, 1 day, either sign) costs
    exactly ONE spurious retransmit on the command path and then self-heals.

    So this is the minor half of H8 -- a duplicate COMMAND_LONG on a link whose
    bandwidth is already the constraint, and a duplicate `arm` is idempotent.
    The serious half is link health, which never re-bases; see the test above.
    Worth pinning anyway: a retry budget should be spent on real seconds, and a
    clock that steps repeatedly (a slewing or flapping ntpd) multiplies it."""
    acks = []
    b = _bridge()

    class Loop:
        def call_soon_threadsafe(self, fn, *a):
            acks.append(a[0])
    b._loop = Loop()
    conn = RecordingConn()
    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM,
                      "params": [1, 0, 0, 0, 0, 0, 0]})
    b._service_commands(conn)                        # first send
    assert len([s for s in conn.mav.sent if s[0] == "command_long_send"]) == 1

    monkeypatch.setattr(time, "time", SteppedClock(3600.0))
    for _ in range(5):
        b._service_commands(conn)
    assert acks == [], f"a clock step expired a live command: {acks}"
    assert "c1" in b._pending
    # And it is still only one send: no retry is due either, since no real time
    # has passed. The retry budget is real seconds, not clock seconds.
    assert len([s for s in conn.mav.sent if s[0] == "command_long_send"]) == 1


def test_h8_mission_and_param_retries_are_also_real_seconds(monkeypatch):
    """Same shape on the param and mission paths: a clock step must not spend a
    retry. (It did not abort them pre-fix either -- their watermarks re-base on
    the first retry too -- so what is pinned here is the spurious retransmit,
    which over a radio is the part that costs something.)"""
    b = _bridge()
    b._loop = type("L", (), {"call_soon_threadsafe": lambda *a: None})()
    conn = RecordingConn()
    _upload(b, conn, n=5)
    b._param_queue.put({"kind": "set", "id": "p1", "name": "FW_AIRSPD_TRIM",
                        "value": 15.0, "ptype": m.MAV_PARAM_TYPE_REAL32})
    b._service_params(conn)
    assert "FW_AIRSPD_TRIM" in b._param_set_pending
    baseline = len(conn.mav.sent)

    monkeypatch.setattr(time, "time", SteppedClock(86400.0))   # a full day
    for _ in range(5):
        b._service_missions(conn)
        b._service_params(conn)
    assert len(conn.mav.sent) == baseline, \
        f"a clock step cost {len(conn.mav.sent) - baseline} spurious retransmit(s)"
    assert b._mission is not None and "FW_AIRSPD_TRIM" in b._param_set_pending


def test_h8_frame_carries_a_wall_timestamp_and_a_monotone_one(ports):
    """`t` stays the wall clock -- that is the contract, and it is what a human
    and a log read. `upMs` is the clock a client should difference."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])

    async def scenario():
        import asyncio
        import json as _json

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            frames = []
            for _ in range(8):
                f = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                if f.get("type") == "telemetry":
                    frames.append(f)
            assert len(frames) >= 4
            wall_now = int(time.time() * 1000)
            assert abs(frames[-1]["t"] - wall_now) < 5000, "`t` is not a wall clock"
            ups = [f["upMs"] for f in frames]
            assert ups == sorted(ups), f"upMs is not monotone: {ups}"
            assert ups[0] < 60_000, "upMs should be ms since the daemon started"
        serve.cancel()

    import asyncio
    asyncio.run(scenario())


# --- H13: gs forwarded a fence it could prove was not a fence ---------------

def _push_fence(b, conn, items):
    """Queue a fence_push and run one service tick. Returns the ack dict, or
    None if the upload actually started."""
    acks = []
    b._loop = type("L", (), {"call_soon_threadsafe":
                             lambda s, fn, *a: acks.append(a[0])})()
    b._mission_queue.put({"kind": "push", "id": "f1", "items": items,
                          "mtype": bridgemod.MAV_MISSION_TYPE_FENCE,
                          "rtype": "fence", "ack_type": "fence_ack"})
    b._service_missions(conn)
    return acks[0] if acks else None


def _poly(n, kind="fence_inclusion", claim=None):
    return [{"kind": kind, "lat": 37.40 + i * 0.01, "lon": -122.20,
             **({"params": {"vertexCount": claim}} if claim is not None else {})}
            for i in range(n)]


@pytest.mark.parametrize("n", [1, 2])
def test_h13_a_polygon_fence_needs_three_vertices(n):
    """`param1` on a fence vertex is, per MAVLink, how many vertices PX4 should
    read as belonging to this polygon. Two points bound no area, so a 1- or
    2-vertex "polygon" is not a fence. gs forwarded it anyway and the operator
    got `accepted` -- told they have a geofence when they have nothing. The
    whole point of a fence is that it is there when something else has gone
    wrong, so "accepted" has to mean it."""
    b = _bridge()
    ack = _push_fence(b, RecordingConn(), _poly(n, claim=n))
    assert ack is not None and ack["ok"] is False, \
        f"a {n}-vertex polygon was accepted as a fence"
    assert "3" in ack["text"] and "vert" in ack["text"].lower(), ack["text"]
    assert b._mission is None


def test_h13_vertex_count_is_derived_by_gs_not_trusted_from_the_client():
    """gs is the authority on the wire -- it serves the console, and anything
    else that ever speaks this protocol. A client that omits `vertexCount`
    (an older console) made gs send param1=0 for every vertex, which tells PX4
    the polygon has no vertices. Derive it from the actual run instead."""
    b = _bridge()
    conn = RecordingConn()
    ack = _push_fence(b, conn, _poly(4))          # no vertexCount supplied
    assert ack is None, f"a valid 4-vertex fence was rejected: {ack}"
    assert b._mission is not None
    assert [f["param1"] for f in b._mission["items"]] == [4.0] * 4


def test_h13_a_client_that_disagrees_about_the_count_is_refused_not_guessed_at():
    """If the client's claim and the geometry disagree, the two ends disagree
    about what the fence IS. gs derives the right number, but says so rather
    than silently substituting it -- on a geofence, quietly uploading something
    other than what was asked for is its own failure."""
    b = _bridge()
    ack = _push_fence(b, RecordingConn(), _poly(3, claim=7))
    assert ack is not None and ack["ok"] is False
    assert "7" in ack["text"] and "3" in ack["text"], ack["text"]


def test_h13_a_zero_radius_circle_is_not_a_fence():
    b = _bridge()
    for radius in (0, -5):
        ack = _push_fence(b, _bridge() and RecordingConn(),
                          [{"kind": "fence_circle_inclusion", "lat": 37.4,
                            "lon": -122.2, "params": {"radius": radius}}])
        assert ack is not None and ack["ok"] is False, f"radius {radius} accepted"
        assert "radius" in ack["text"].lower(), ack["text"]


def test_h13_two_separate_polygons_each_get_their_own_count():
    """Contiguous same-kind runs are separate polygons, which is how MAVLink
    carries more than one fence shape in a flat list."""
    b = _bridge()
    conn = RecordingConn()
    items = _poly(3, "fence_inclusion") + _poly(4, "fence_exclusion")
    ack = _push_fence(b, conn, items)
    assert ack is None, ack
    assert [f["param1"] for f in b._mission["items"]] == [3.0] * 3 + [4.0] * 4


def test_h13_a_valid_fence_and_a_mission_are_both_unaffected():
    """The guard is fence-shaped: it must not touch an ordinary mission, whose
    items have no vertexCount and whose count of 1 is perfectly legal."""
    b = _bridge()
    conn = RecordingConn()
    ack = _push_fence(b, conn, _poly(3, claim=3))
    assert ack is None and b._mission is not None
    b._mission = None
    acks = []
    b._loop = type("L", (), {"call_soon_threadsafe":
                             lambda s, fn, *a: acks.append(a[0])})()
    b._mission_queue.put({"kind": "push", "id": "m1",
                          "items": [{"kind": "waypoint", "lat": 1, "lon": 2, "alt": 30}],
                          "mtype": bridgemod.MAV_MISSION_TYPE_MISSION,
                          "rtype": "mission", "ack_type": "mission_ack"})
    b._service_missions(conn)
    assert acks == [] and b._mission is not None, "a 1-item mission was rejected"


# --- H14: a param refresh starved the commands on a narrow link ------------

def _param_value(idx, count, name=None, value=1.0):
    return _msg("PARAM_VALUE", param_id=(name or f"P_{idx:03d}").encode(),
                param_value=value, param_type=m.MAV_PARAM_TYPE_REAL32,
                param_index=idx, param_count=count)


def _names(conn):
    return [s[0] for s in conn.mav.sent]


def test_h14_a_narrow_link_paces_the_param_fetch_instead_of_flooding():
    """PARAM_REQUEST_LIST hands the pacing to the autopilot, which then sends
    ~1000 values as fast as the link will carry. On localhost that is free. On a
    3.4 kB/s SiK link it is the whole link for ten seconds, and MEASURED: an
    `arm` issued one second into a refresh took 3.02 s and came back ok=False --
    it exhausted its retries and reported `timeout` on a healthy link. The same
    sequence on UDP acks in 0.09 s, which is why this never showed.

    On a narrow link gs issues the reads itself, so the rate is its own."""
    b = _bridge(mavlink_endpoint="serial:/dev/ttyUSB0:57600")
    conn = RecordingConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)
    assert "param_request_list_send" not in _names(conn), \
        "flooded a telemetry radio with PARAM_REQUEST_LIST"
    assert _names(conn) == ["param_request_read_send"], _names(conn)
    assert conn.mav.sent[0][1][3] == 0, "the bootstrap read should be index 0"


def test_h14_a_fat_pipe_still_uses_the_fast_path():
    """The flood is the right answer when the link can carry it: it is one
    message out and the autopilot streams at full speed. SITL, HITL and PX4 over
    USB must be untouched."""
    for endpoint in ("udpin:0.0.0.0:14550", "tcp:127.0.0.1:5760",
                     "serial:/dev/ttyACM0:921600"):
        b = _bridge(mavlink_endpoint=endpoint)
        conn = RecordingConn()
        b._param_queue.put({"kind": "refresh"})
        b._service_params(conn)
        assert _names(conn) == ["param_request_list_send"], (endpoint, _names(conn))


def test_h14_paced_mode_learns_the_count_then_walks_the_indices(monkeypatch):
    monkeypatch.setattr(bridgemod, "PARAM_READ_RETRY_MS", 0)
    b = _bridge(mavlink_endpoint="serial:/dev/ttyUSB0:57600")
    b._loop = type("L", (), {"call_soon_threadsafe": lambda *a: None})()
    conn = RecordingConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)                       # bootstrap read of index 0
    assert b._param_count == 0

    # Index 0 answers, carrying the total.
    b._on_mav_protocol(conn, bridgemod._mono_ms(), "PARAM_VALUE", _param_value(0, 12))
    assert b._param_count == 12
    conn.mav.sent.clear()

    # Now it walks the rest, a bounded burst per tick.
    b._param_paced_at = 0
    b._service_params(conn)
    reads = [s[1][3] for s in conn.mav.sent if s[0] == "param_request_read_send"]
    assert reads, "paced mode stopped asking"
    assert len(reads) <= bridgemod.PARAM_READ_BURST, f"burst of {len(reads)}"
    assert 0 not in reads, "re-requested an index already received"
    assert all(1 <= i < 12 for i in reads), reads


def test_h14_paced_mode_completes_and_marks_done(monkeypatch):
    monkeypatch.setattr(bridgemod, "PARAM_READ_RETRY_MS", 0)
    events = []
    b = _bridge(mavlink_endpoint="serial:/dev/ttyUSB0:57600")
    b._loop = _capturing_loop(events)
    conn = RecordingConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)
    for idx in range(6):
        b._on_mav_protocol(conn, bridgemod._mono_ms(), "PARAM_VALUE", _param_value(idx, 6))
        b._param_paced_at = 0
        b._service_params(conn)
    done = [e for e in events if e.get("type") == "param_progress" and e.get("done")]
    assert done, f"never emitted a done marker: {events}"
    assert done[-1]["received"] == 6 and done[-1].get("error") is None
    assert b._param_refresh_active is False
    values = [it["name"] for e in events if e.get("type") == "params" for it in e["items"]]
    assert len(values) == 6, values


def test_h14_paced_mode_gives_up_loudly_if_nothing_answers(monkeypatch):
    """A refresh that gets no answers must fail with an error marker, not poll
    the radio forever."""
    monkeypatch.setattr(bridgemod, "PARAM_PACED_STALL_MS", 0)
    events = []
    b = _bridge(mavlink_endpoint="serial:/dev/ttyUSB0:57600")
    b._loop = _capturing_loop(events)
    conn = RecordingConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)
    for _ in range(3):
        b._param_last_rx_ms = 0        # deterministic stall, no sleeping
        b._service_params(conn)
    err = [e for e in events if e.get("error")]
    assert err, f"polled forever instead of failing: {events}"
    assert err[-1]["error"] == "timeout"
    assert b._param_refresh_active is False


def test_h14_param_read_rate_comes_from_the_budget():
    slow = bridgemod.param_read_hz(3456)        # 57600 SiK
    fast = bridgemod.param_read_hz(1_000_000)   # UDP
    assert 10 < slow < 60, slow
    assert fast > slow
    # It must leave most of the link alone.
    pv = bridgemod.message_bytes(m.MAVLINK_MSG_ID_PARAM_VALUE)
    assert slow * pv <= 3456 * bridgemod.PARAM_LINK_SHARE + 1


def test_h14_a_pinned_link_budget_survives_a_reopen(monkeypatch):
    """mavlink-router in front of a radio makes the link look like UDP, so an
    inferred budget says "fat pipe" and gs makes every fat-pipe choice. The pin
    is the operator correcting that, and a reopen must not discard it."""
    monkeypatch.setattr(bridgemod, "open_connection", lambda *a, **k: RecordingConn())
    b = Bridge(mavlink_endpoint="udpin:0.0.0.0:14550", budget_bps=3456)
    assert b.link_budget_bps == 3456
    b._open_with_retry()
    assert b.link_budget_bps == 3456, "a reopen threw the pin away"
    conn = RecordingConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)
    assert "param_request_list_send" not in _names(conn)
    # And the stream rates follow the pin too.
    b._request_message(conn, 1, 1, bridgemod.MSG_ACTUATOR_OUTPUT_STATUS)
    hz = 1e6 / next(s for s in conn.mav.sent if s[0] == "command_long_send")[1][5]
    assert hz <= 5.0, hz


def test_h8b_a_zero_watermark_still_means_long_ago(monkeypatch):
    """A bug the monotonic switch introduced, caught by the H14 pin test.

    `0` is the "never happened" sentinel for every watermark here. Under the
    wall clock `now - 0` was ~1.7e12 ms, so "never" always read as "long ago"
    and every `now - last >= TIMEOUT` test fired. Measured from daemon start,
    `now - 0` is just the uptime -- so for the daemon's first second "never"
    reads as "just now" and everything is suppressed: no first GCS heartbeat,
    a command queued at startup not transmitted, the stream requests skipped.

    Everything below is what a daemon does in its first few milliseconds."""
    assert bridgemod._mono_ms() >= bridgemod._MONO_ORIGIN_MS
    for timeout in (bridgemod.GCS_HEARTBEAT_MS, bridgemod.CMD_RETRY_MS,
                    bridgemod.PARAM_BATCH_MS, bridgemod.PARAM_SET_TIMEOUT_MS,
                    bridgemod.MISSION_OP_TIMEOUT_MS, bridgemod.PARAM_GAP_QUIET_MS,
                    bridgemod.PARAM_READ_RETRY_MS, bridgemod.PARAM_PACED_STALL_MS):
        assert bridgemod._mono_ms() - 0 >= timeout, timeout

    b = _bridge()
    conn = RecordingConn()
    # The first heartbeat goes out now, not a second from now.
    b._service_heartbeat(conn)
    assert [s[0] for s in conn.mav.sent] == ["heartbeat_send"]

    # A command queued in the first instants is transmitted in the first instants.
    conn.mav.sent.clear()
    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM,
                      "params": [1, 0, 0, 0, 0, 0, 0]})
    b._service_commands(conn)
    assert [s[0] for s in conn.mav.sent] == ["command_long_send"], \
        "a command queued at startup was not sent"

    # And a stream request is not throttled as though it had just been made.
    conn.mav.sent.clear()
    b._request_message(conn, 1, 1, bridgemod.MSG_WIND_COV)
    assert [s[0] for s in conn.mav.sent] == ["command_long_send"], \
        "the startup stream request was throttled against a never-sent watermark"


# --- H16: a PX4 reboot was silent, and left stale state on screen ----------

def _gpi(boot_ms, lat=374000000):
    return _msg("GLOBAL_POSITION_INT", time_boot_ms=boot_ms, lat=lat,
                lon=-1221000000, alt=120000, hdg=9000, vx=0, vy=0, vz=0)


def _rebooted_bridge(events):
    b = _bridge(mavlink_endpoint="serial:/dev/ttyUSB0:57600")
    b._loop = _capturing_loop(events)
    conn = RecordingConn()
    b._vehicle = (1, 1)
    b._on_mav(conn, _gpi(600_000))        # ten minutes of uptime
    return b, conn


def _reboot(b, conn):
    b._on_mav(conn, _gpi(120))            # uptime restarts


def test_h16_a_vehicle_reboot_is_announced():
    """On the bench and in HITL this happens constantly -- every restart, every
    flash. The backward uptime jump was already tolerated (the frame is kept
    rather than dropped as reordered) but nothing was told about it, so a
    console went on showing pre-reboot state."""
    events = []
    b, conn = _rebooted_bridge(events)
    _reboot(b, conn)
    reboots = [e for e in events if e.get("type") == "vehicle_reboot"]
    assert reboots, f"a reboot went unannounced: {[e.get('type') for e in events]}"
    assert reboots[0]["bootMs"] == 120
    # Still tracking the vehicle afterwards -- a reboot is not a lost link.
    b._on_mav(conn, _gpi(400))
    assert b.latest["bootMs"] == 400


def test_h16_a_reboot_does_not_fire_on_ordinary_forward_time():
    events = []
    b, conn = _rebooted_bridge(events)
    for boot in (600_100, 600_200, 700_000, 1_000_000):
        b._on_mav(conn, _gpi(boot))
    assert not [e for e in events if e.get("type") == "vehicle_reboot"]


def test_h16_in_flight_work_is_abandoned_with_the_real_reason():
    """Every in-flight handshake was a conversation with a process that no
    longer exists. Left alone each sits until its own timeout and reports
    `timeout`, which tells the operator the link is bad when the truth is that
    the vehicle rebooted -- a different problem with a different action."""
    events = []
    b, conn = _rebooted_bridge(events)

    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM,
                      "params": [1, 0, 0, 0, 0, 0, 0]})
    b._service_commands(conn)
    b._param_queue.put({"kind": "refresh"})
    b._param_queue.put({"kind": "set", "id": "p1", "name": "FW_AIRSPD_TRIM",
                        "value": 15.0, "ptype": m.MAV_PARAM_TYPE_REAL32})
    b._service_params(conn)
    _upload(b, conn, n=4)
    assert b._pending and b._param_refresh_active and b._param_set_pending and b._mission

    _reboot(b, conn)

    assert b._pending == {}, "a command stayed pending against a vehicle that rebooted"
    assert b._param_refresh_active is False
    assert b._param_set_pending == {}
    assert b._mission is None

    texts = [e.get("text") or e.get("error") for e in events]
    assert texts.count("vehicle rebooted") >= 4, texts
    assert "timeout" not in texts, "reported a timeout for a reboot"
    reboot = next(e for e in events if e.get("type") == "vehicle_reboot")
    assert "command" in reboot["aborted"]
    assert "param refresh" in reboot["aborted"]
    assert "mission upload" in reboot["aborted"]


def test_h16_the_extra_streams_are_re_requested_after_a_reboot():
    """The new instance is back on PX4's defaults and never saw our
    SET_MESSAGE_INTERVALs, so the throttle that stops us re-asking has to be
    cleared or the actuator and wind streams never come back."""
    events = []
    b, conn = _rebooted_bridge(events)
    b._request_message(conn, 1, 1, bridgemod.MSG_WIND_COV)
    assert bridgemod.MSG_WIND_COV in b._last_req_at
    conn.mav.sent.clear()
    b._request_message(conn, 1, 1, bridgemod.MSG_WIND_COV)
    assert conn.mav.sent == [], "the per-message throttle is not working"

    _reboot(b, conn)
    conn.mav.sent.clear()
    b._request_message(conn, 1, 1, bridgemod.MSG_WIND_COV)
    assert [s[0] for s in conn.mav.sent] == ["command_long_send"], \
        "the stream request stayed throttled across a reboot"


# --- H17: the vehicle's uptime counter wraps on a long flight --------------

BOOT_WRAP = 2 ** 32   # time_boot_ms is uint32 ms


def test_h17_a_uptime_wrap_is_not_a_reboot():
    """`time_boot_ms` is uint32 milliseconds, so it wraps at 49.7 days. This
    airframe is a solar aircraft meant to stay up for days to weeks, so the
    wrap is a flight event, not a theoretical one.

    At the wrap the counter jumps from ~2^32 to near zero, which is exactly what
    a reboot looks like to the H16 detector -- and the reboot handler abandons
    every in-flight handshake and tells the console to throw away its param
    cache. Doing that to a healthy aircraft 49.7 days into a flight, with a
    warning saying it rebooted, is worse than saying nothing."""
    events = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    conn = RecordingConn()
    b._vehicle = (1, 1)

    b._on_mav(conn, _gpi(BOOT_WRAP - 20, lat=374000000))
    assert b.latest["bootMs"] == BOOT_WRAP - 20
    b._on_mav(conn, _gpi(30, lat=374100000))        # wrapped

    assert not [e for e in events if e.get("type") == "vehicle_reboot"], \
        "an uptime wrap was reported as a reboot"
    # The frame itself must still be taken: the aircraft is flying.
    assert b.latest["bootMs"] == 30
    assert b.latest["lat"] == pytest.approx(37.41)


def test_h17_a_wrap_does_not_abandon_in_flight_work():
    events = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    conn = RecordingConn()
    b._vehicle = (1, 1)
    b._on_mav(conn, _gpi(BOOT_WRAP - 20))
    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM,
                      "params": [1, 0, 0, 0, 0, 0, 0]})
    b._service_commands(conn)
    _upload(b, conn, n=3)

    b._on_mav(conn, _gpi(30))
    assert "c1" in b._pending, "a wrap cancelled a live command"
    assert b._mission is not None, "a wrap cancelled a live mission upload"


def test_h17_a_real_reboot_near_the_wrap_is_still_a_reboot():
    """The discriminator must not become a blanket excuse: a vehicle that
    reboots while its uptime happens to be mid-range still has to be caught."""
    events = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    conn = RecordingConn()
    b._vehicle = (1, 1)
    b._on_mav(conn, _gpi(BOOT_WRAP // 2))     # ~25 days of uptime
    b._on_mav(conn, _gpi(30))                 # restarted, not wrapped
    assert [e for e in events if e.get("type") == "vehicle_reboot"], \
        "a reboot at 25 days of uptime was mistaken for a wrap"


# --- H18: does a long-lived daemon accumulate? ------------------------------

def test_h18_per_session_bookkeeping_stays_bounded(monkeypatch):
    """This daemon is meant to run for the length of a flight, and the flights
    are measured in days. Every registry it keeps per command / param / mission
    / client has to come back to empty, or a week of ordinary operation is a
    leak. Driven here with 400 rounds of churn."""
    monkeypatch.setattr(bridgemod, "CMD_RETRY_MS", 0)
    monkeypatch.setattr(bridgemod, "MISSION_OP_TIMEOUT_MS", 0)
    monkeypatch.setattr(bridgemod, "PARAM_SET_TIMEOUT_MS", 0)
    sink: list = []
    b = _bridge()
    b._loop = _capturing_loop(sink)
    conn = RecordingConn()
    b._vehicle = (1, 1)

    for i in range(400):
        # a command that gets answered
        b._cmd_queue.put({"id": f"c{i}", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM,
                          "params": [1, 0, 0, 0, 0, 0, 0]})
        b._service_commands(conn)
        b._on_mav_protocol(conn, bridgemod._mono_ms(), "COMMAND_ACK",
                           _msg("COMMAND_ACK", command=m.MAV_CMD_COMPONENT_ARM_DISARM,
                                result=m.MAV_RESULT_ACCEPTED))
        # a command that never gets answered, so it has to expire
        b._cmd_queue.put({"id": f"x{i}", "mav_cmd": m.MAV_CMD_NAV_LAND,
                          "params": [0] * 7})
        for _ in range(bridgemod.CMD_MAX_TRIES + 1):
            b._service_commands(conn)
        # a param set that is echoed, and one that is not
        b._param_queue.put({"kind": "set", "id": f"p{i}", "name": "FW_AIRSPD_TRIM",
                            "value": float(i), "ptype": m.MAV_PARAM_TYPE_REAL32})
        b._service_params(conn)
        b._on_mav_protocol(conn, bridgemod._mono_ms(), "PARAM_VALUE",
                           _param_value(65535, 1, "FW_AIRSPD_TRIM", float(i)))
        b._param_queue.put({"kind": "set", "id": f"q{i}", "name": "MIS_TAKEOFF_ALT",
                            "value": float(i), "ptype": m.MAV_PARAM_TYPE_REAL32})
        for _ in range(bridgemod.PARAM_SET_MAX_TRIES + 1):
            b._service_params(conn)
        # a mission upload that times out
        _upload(b, conn, n=3)
        for _ in range(bridgemod.MISSION_MAX_TRIES + 2):
            if b._mission is not None:
                b._mission["last"] = 0
            b._service_missions(conn)
        # a telemetry frame, so `latest` is exercised too
        b._on_mav(conn, _gpi(1000 + i * 100))

    assert b._pending == {}, f"{len(b._pending)} commands left pending"
    assert b._param_set_pending == {}, f"{len(b._param_set_pending)} param sets left"
    assert b._mission is None
    # A partial batch awaiting its flush is correct, not a leak: the invariant
    # is that it is bounded by the batch size, not that it is empty.
    assert len(b._param_batch) <= bridgemod.PARAM_BATCH_MAX, len(b._param_batch)
    assert len(b._last_req_at) <= 8, b._last_req_at
    assert len(b._param_req_at) <= 1024, len(b._param_req_at)
    # `latest` is a fixed set of telemetry fields, not a per-event accumulator.
    assert len(b.latest) < 80, sorted(b.latest)


def test_h18_a_client_that_vanishes_does_not_leak_its_ack_route(monkeypatch):
    """`_pending_clients` maps a command id to the socket that asked, so the
    verdict goes back to the right tab. A tab that closes mid-command (a phone
    going to sleep on the hub's WiFi, constantly) must not leave its entry
    behind -- over a week of reconnects that is the registry growing without
    anything to flush it."""
    monkeypatch.setattr(bridgemod, "CMD_RETRY_MS", 0)
    sink: list = []
    b = _bridge()
    b._loop = _capturing_loop(sink)
    conn = RecordingConn()
    class DeadWS:
        async def send(self, _payload):
            raise ConnectionError("tab closed")

    for i in range(200):
        b._pending_clients[f"c{i}"] = DeadWS()
        b._cmd_queue.put({"id": f"c{i}", "mav_cmd": m.MAV_CMD_NAV_LAND,
                          "params": [0] * 7})
        for _ in range(bridgemod.CMD_MAX_TRIES + 1):
            b._service_commands(conn)
    # The mav thread resolved every one (as a timeout) and handed the asyncio
    # side a verdict per id. Run the real delivery -- the send fails, because the
    # tab is gone, and the route must still be released.
    assert b._pending == {}
    assert len(b._pending_clients) == 200
    import asyncio as _aio

    async def drain():
        for event in sink:
            await b._deliver_ack(event)
    _aio.run(drain())
    assert b._pending_clients == {}, \
        f"{len(b._pending_clients)} ack routes left behind by closed tabs"


# --- H19: a stopped stream kept being redrawn as a live reading ------------

def test_h19_each_message_group_carries_its_own_age(ports):
    """`dataAgeMs` answers "is the aircraft still talking". It cannot answer "is
    this number still true", because a frame's fields arrive on different
    messages at different rates -- and three of them are messages gs had to ASK
    for, which a rebooted or reconfigured autopilot just stops sending.

    When a stream stops, its last value stays in `latest` and is re-broadcast in
    every frame, indistinguishable from a live one. An airspeed sensor failure
    takes EKF2's wind estimate with it, and the operator goes on being shown the
    last wind the aircraft ever saw as the current wind. On an aircraft that
    stays up on wind and sun, that is the worst number on the panel to be
    quietly wrong."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])
    conn = RecordingConn()
    b._vehicle = (1, 1)

    async def scenario():
        import asyncio
        import json as _json

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            # Position and wind both arrive; then the wind stream stops while
            # position keeps coming -- a live link with one dead stream.
            b._on_mav(conn, _msg("WIND_COV", wind_x=3.0, wind_y=1.0, wind_z=0.1,
                                 var_horiz=0.08, var_vert=0.05))
            b._on_mav(conn, _gpi(1000))
            got = await _recv_telemetry(ws, lambda g: "ages" in g)
            assert got is not None, "no frame carried per-group ages"
            assert set(got["ages"]) >= {"wind", "position"}, got["ages"]
            assert got["ages"]["wind"] < 2000
            first_wind_age = got["ages"]["wind"]

            await asyncio.sleep(0.6)
            for boot in (1100, 1200, 1300):          # position only
                b._on_mav(conn, _gpi(boot))
            later = await _recv_telemetry(
                ws, lambda g: g.get("ages", {}).get("position", 9e9) < 400
                and g.get("ages", {}).get("wind", 0) > first_wind_age + 400)
            assert later is not None, "the wind age never grew while position stayed fresh"
            # The value is still there -- gs does not invent a gap -- but it is
            # now explicitly old, which is what a client needs to say so.
            assert later["windSpeed"] == pytest.approx(math.hypot(3.0, 1.0))
            assert later["linkState"] == "alive"
            assert later["dataAgeMs"] < 1000, "the LINK is fine; only one stream stopped"
        serve.cancel()

    import asyncio
    import math
    asyncio.run(scenario())


def test_h19_a_group_never_seen_is_absent_not_zero(ports):
    """"no wind estimate yet" and "a wind estimate from four minutes ago" are
    different things, and a client has to be able to tell which it has."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])
    conn = RecordingConn()
    b._vehicle = (1, 1)

    async def scenario():
        import asyncio

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            b._on_mav(conn, _gpi(1000))
            got = await _recv_telemetry(ws, lambda g: "ages" in g)
            assert got is not None
            assert "position" in got["ages"]
            assert "wind" not in got["ages"], "reported an age for a stream never seen"
            assert "gps" not in got["ages"]
        serve.cancel()

    import asyncio
    asyncio.run(scenario())


def test_h19_ages_reset_when_the_link_is_reopened():
    """A reopen may be a different aircraft (H5). Its streams have their own
    history, and carrying the old one over would date the new vehicle's data to
    the previous one's."""
    b = _bridge()
    conn = RecordingConn()
    b._vehicle = (1, 1)
    b._on_mav(conn, _msg("GPS_RAW_INT", fix_type=3, satellites_visible=14))
    assert "gps" in b._src_at
    b._on_reopen()
    assert b._src_at == {}


# --- H20: "Take command" could not take command ----------------------------

async def _claim(ws, cid, **extra):
    import asyncio
    import json as _json
    await ws.send(_json.dumps({"type": "claim", "id": cid, **extra}))
    for _ in range(40):
        try:
            got = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
        except asyncio.TimeoutError:
            continue
        if got.get("type") == "ack" and got.get("id") == cid:
            return got
    return None


def test_h20_a_second_console_can_take_command_when_it_says_it_is_doing_that(ports):
    """gs grants authority to the first claimer and holds it until that socket
    drops. The hub's whole premise is "join the WiFi, open the page", so several
    people do -- and whoever loaded first holds command. A phone in someone's
    pocket with the page open keeps answering gs's 5 s pings, so its socket
    never drops and the pilot at the laptop cannot get authority: gs rejects
    every command, mission upload and param write from them. The console grew a
    "Take command" button for exactly this, but it re-sent a plain `claim`,
    which gs refused for the same reason -- a button that could not do the thing
    it was named after. The only cure was to find the other person.

    A plain claim must still NOT steal authority (a page loading in a browser
    must never take it from someone actively flying). An explicit takeover is
    different: the operator pressed a button that says so."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])

    async def scenario():
        import asyncio

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        url = f"ws://127.0.0.1:{ports['ws']}"
        async with websockets.connect(url) as a, websockets.connect(url) as c:
            assert (await _claim(a, "a1"))["ok"] is True

            # A plain claim from the second console is refused, as it must be.
            refused = await _claim(c, "c1")
            assert refused["ok"] is False and refused["text"] == "not commander"

            # An explicit takeover succeeds.
            took = await _claim(c, "c2", force=True)
            assert took is not None and took["ok"] is True, f"takeover refused: {took}"
            assert b._commander is not None

            # And the console that lost it is TOLD, so its UI can grey out
            # instead of silently having every command rejected.
            notice = None
            for _ in range(40):
                try:
                    got = await asyncio.wait_for(a.recv(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                import json as _json
                msg = _json.loads(got)
                if msg.get("type") == "commander":
                    notice = msg
                    break
            assert notice is not None, "the displaced console was never told"
            assert notice["held"] is False
        serve.cancel()

    import asyncio
    asyncio.run(scenario())


def test_h20_a_takeover_makes_the_new_console_the_one_that_can_command(ports):
    """Authority has to actually move, not just be reported as moved."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])

    async def scenario():
        import asyncio
        import json as _json

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        url = f"ws://127.0.0.1:{ports['ws']}"
        async with websockets.connect(url) as a, websockets.connect(url) as c:
            await _claim(a, "a1")
            await _claim(c, "c1", force=True)
            # The old commander's command is now refused...
            await a.send(_json.dumps({"type": "command", "id": "x1", "name": "rtl"}))
            got = await _recv_type(a, "ack", "x1")
            assert got["ok"] is False and got["text"] == "not commander"
            # ...and the new one's is accepted onto the mav thread.
            await c.send(_json.dumps({"type": "command", "id": "y1", "name": "rtl"}))
            await asyncio.sleep(0.2)
            assert "y1" in b._pending_clients
        serve.cancel()

    import asyncio
    asyncio.run(scenario())


async def _recv_type(ws, mtype, mid=None, tries=40):
    import asyncio
    import json as _json
    for _ in range(tries):
        try:
            got = _json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
        except asyncio.TimeoutError:
            continue
        if got.get("type") == mtype and (mid is None or got.get("id") == mid):
            return got
    return None


def test_h20_a_plain_claim_still_never_steals_authority(ports):
    """The regression that matters: a page loading must not take command from
    someone who is flying. Several reloads and reconnects, none of which asked."""
    b = _bridge(json_port=ports["json"], ws_port=ports["ws"])

    async def scenario():
        import asyncio

        import websockets
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        url = f"ws://127.0.0.1:{ports['ws']}"
        async with websockets.connect(url) as a:
            await _claim(a, "a1")
            for i in range(3):
                async with websockets.connect(url) as other:
                    got = await _claim(other, f"o{i}")
                    assert got["ok"] is False, "a plain claim stole command authority"
            # The original still holds it.
            assert (await _claim(a, "a2"))["ok"] is True
        serve.cancel()

    import asyncio
    asyncio.run(scenario())
