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
