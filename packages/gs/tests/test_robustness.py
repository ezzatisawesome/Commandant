"""Transport-chain robustness: the failure modes a field link actually hits.

Unit-level where possible (a fake pymavlink connection drives the mav-thread
service functions directly, no sockets), integration where the WS fan-out is
the thing under test.
"""

from __future__ import annotations

import asyncio
import json
import math
import socket
import struct
import threading
import time
from types import SimpleNamespace

import pytest
import websockets

from gs import bridge as bridgemod
from gs.bridge import Bridge, dumps
from pymavlink import mavutil

m = mavutil.mavlink


async def _recv_until(ws, predicate, tries=200, timeout=0.5):
    """Read WS messages until one matches (shared with the other test modules)."""
    for _ in range(tries):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            continue
        if predicate(msg):
            return msg
    return None


# --- JSON safety ------------------------------------------------------------

def test_dumps_never_emits_nan():
    out = dumps({"alt": float("nan"), "v": float("inf"), "ok": 1.5, "nest": [float("-inf"), 2]})
    assert "NaN" not in out and "Infinity" not in out
    back = json.loads(out)
    assert back == {"alt": None, "v": None, "ok": 1.5, "nest": [None, 2]}


def test_nan_from_json_feed_does_not_poison_frames(ports):
    """Python's json.loads accepts `NaN`; a feed that sends one must not make
    every subsequent telemetry frame unparseable in the browser."""
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._json_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.sendto(b'{"lat": 37.4, "alt": NaN}', ("127.0.0.1", ports["json"]))
            got = None
            for _ in range(30):
                raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                got = json.loads(raw)  # strict JSON: would raise on a bare NaN
                if got.get("lat") == 37.4:
                    break
            assert got is not None and got["lat"] == 37.4
            assert got["alt"] is None
        serve_task.cancel()

    asyncio.run(scenario())


# --- fake connection for mav-thread unit tests ---------------------------------

class FakeMav:
    """Records every send as (name, args); optionally raises on recv."""

    def __init__(self):
        self.sent: list[tuple[str, tuple]] = []
        self.closed = False

    def __getattr__(self, name):
        if name.endswith("_send"):
            def _send(*args):
                self.sent.append((name, args))
            return _send
        raise AttributeError(name)


class FakeConn:
    def __init__(self, recv_exc: Exception | None = None):
        self.mav = FakeMav()
        self.recv_exc = recv_exc
        self.closed = False

    def recv_match(self, blocking=True, timeout=0.5):
        if self.recv_exc:
            raise self.recv_exc
        time.sleep(0.01)
        return None

    def close(self):
        self.closed = True


def _msg(mtype: str, **fields):
    ns = SimpleNamespace(**fields)
    ns.get_type = lambda: mtype
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns


def _bridge_with_loop(monkeypatch) -> tuple[Bridge, list]:
    """A Bridge whose asyncio hand-off is captured synchronously."""
    b = Bridge()
    emitted: list = []

    class FakeLoop:
        def call_soon_threadsafe(self, fn, *args):
            emitted.append((fn.__name__, args))

    b._loop = FakeLoop()
    return b, emitted


# --- command path -----------------------------------------------------------

def test_command_retries_then_times_out(monkeypatch):
    monkeypatch.setattr(bridgemod, "CMD_RETRY_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM, "params": [1, 0, 0, 0, 0, 0, 0]})
    for _ in range(bridgemod.CMD_MAX_TRIES + 1):
        b._service_commands(conn)
    sends = [s for s in conn.mav.sent if s[0] == "command_long_send"]
    assert len(sends) == bridgemod.CMD_MAX_TRIES
    # confirmation field increments per retry (MAVLink: 0, 1, 2 ...)
    assert [s[1][3] for s in sends] == list(range(bridgemod.CMD_MAX_TRIES))
    assert emitted[-1][1][0]["text"] == "timeout" and emitted[-1][1][0]["ok"] is False
    assert b._pending == {}


def test_command_in_progress_ack_extends_wait_without_resend(monkeypatch):
    monkeypatch.setattr(bridgemod, "CMD_RETRY_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_NAV_TAKEOFF, "params": [0] * 7})
    b._service_commands(conn)
    assert len(conn.mav.sent) == 1
    b._on_mav(conn, _msg("COMMAND_ACK", command=m.MAV_CMD_NAV_TAKEOFF, result=m.MAV_RESULT_IN_PROGRESS))
    # An interim (final=False) notice goes out so the console re-arms its timeout.
    assert len(emitted) == 1 and emitted[0][1][0]["final"] is False
    for _ in range(5):
        b._service_commands(conn)
    assert len(conn.mav.sent) == 1  # and no retries while in progress
    b._on_mav(conn, _msg("COMMAND_ACK", command=m.MAV_CMD_NAV_TAKEOFF, result=m.MAV_RESULT_ACCEPTED))
    assert emitted[-1][1][0]["ok"] is True and emitted[-1][1][0]["result"] == 0
    assert b._pending == {}


def test_command_in_progress_eventually_times_out(monkeypatch):
    monkeypatch.setattr(bridgemod, "CMD_IN_PROGRESS_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._cmd_queue.put({"id": "c1", "mav_cmd": m.MAV_CMD_NAV_LAND, "params": [0] * 7})
    b._service_commands(conn)
    b._on_mav(conn, _msg("COMMAND_ACK", command=m.MAV_CMD_NAV_LAND, result=m.MAV_RESULT_IN_PROGRESS))
    time.sleep(0.002)
    b._service_commands(conn)
    assert emitted[-1][1][0]["ok"] is False and "timeout" in emitted[-1][1][0]["text"]


def test_command_send_error_is_reported(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()

    def boom(*a):
        raise OSError("serial write failed")

    conn.mav.command_long_send = boom
    b._cmd_queue.put({"id": "c1", "mav_cmd": 400, "params": [0] * 7})
    b._service_commands(conn)
    assert emitted[-1][1][0]["ok"] is False and "send error" in emitted[-1][1][0]["text"]
    assert b._pending == {}


# --- param path -------------------------------------------------------------

def test_param_refresh_gives_up_after_bounded_sweeps(monkeypatch):
    monkeypatch.setattr(bridgemod, "PARAM_GAP_QUIET_MS", 0)
    monkeypatch.setattr(bridgemod, "PARAM_GAP_MAX_SWEEPS", 2)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)
    # One PARAM_VALUE of a 3-param list, then silence.
    b._on_mav(conn, _msg("PARAM_VALUE", param_id=b"A", param_value=1.0, param_type=9, param_index=0, param_count=3))
    for _ in range(6):
        time.sleep(0.001)
        b._service_params(conn)
    assert b._param_refresh_active is False
    reads = [s for s in conn.mav.sent if s[0] == "param_request_read_send"]
    assert 0 < len(reads) <= 2 * 2  # bounded: ≤ sweeps × missing
    progress = [json.loads(a[0]) for name, a in emitted if name == "_do_broadcast"]
    done = [p for p in progress if p.get("type") == "param_progress" and p.get("done")]
    assert done and done[-1]["error"] == "timeout" and done[-1]["received"] == 1
    # The one value we did get was flushed before the done marker.
    types = [p["type"] for p in progress]
    assert "params" in types and types.index("params") < types.index("param_progress")


def test_param_values_are_batched(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    n = bridgemod.PARAM_BATCH_MAX + 5
    for i in range(n):
        b._on_mav(conn, _msg("PARAM_VALUE", param_id=f"P{i}".encode(), param_value=float(i),
                             param_type=9, param_index=i, param_count=n))
    # Size-triggered flush happened once; the remainder waits for the timer.
    batches = [json.loads(a[0]) for name, a in emitted if name == "_do_broadcast"]
    batches = [p for p in batches if p["type"] == "params"]
    assert len(batches) == 1 and len(batches[0]["items"]) == bridgemod.PARAM_BATCH_MAX
    assert len(b._param_batch) == 5
    monkeypatch.setattr(bridgemod, "PARAM_BATCH_MS", 0)
    time.sleep(0.001)
    b._service_params(conn)
    assert b._param_batch == []


def test_param_set_rejected_echo_fails_fast(monkeypatch):
    """PX4 answers a refused/clamped PARAM_SET with a targeted PARAM_VALUE (index
    65535) carrying the OLD value: that must fail now, not after 3 retries."""
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._param_queue.put({"kind": "set", "id": "s1", "name": "X", "value": 5.0, "ptype": 9})
    b._service_params(conn)
    # A list-stream value for the same name (indexed, not targeted) is not a verdict.
    b._on_mav(conn, _msg("PARAM_VALUE", param_id=b"X", param_value=4.0, param_type=9, param_index=3, param_count=10))
    assert [a for name, a in emitted if name == "_emit_param_ack"] == []
    b._on_mav(conn, _msg("PARAM_VALUE", param_id=b"X", param_value=4.0, param_type=9, param_index=65535, param_count=10))
    acks = [a[0] for name, a in emitted if name == "_emit_param_ack"]
    assert acks and acks[-1]["ok"] is False and "rejected" in acks[-1]["text"]
    assert b._param_set_pending == {}


def test_param_set_matching_echo_resolves(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._param_queue.put({"kind": "set", "id": "s1", "name": "X", "value": 5.0, "ptype": 9})
    b._service_params(conn)
    b._on_mav(conn, _msg("PARAM_VALUE", param_id=b"X", param_value=5.0, param_type=9, param_index=65535, param_count=1))
    acks = [a[0] for name, a in emitted if name == "_emit_param_ack"]
    assert acks and acks[-1]["ok"] is True


def test_int32_params_use_bytewise_encoding(monkeypatch):
    """PX4 memcpy's integer params into the float field. An INT32 of 2 must
    display as 2 (not 2.8e-45) and a set of 2 must put the int bit pattern on
    the wire."""
    from gs.bridge import param_decode, param_encode
    wire = struct.unpack("<f", struct.pack("<i", 2))[0]
    assert param_decode(wire, m.MAV_PARAM_TYPE_INT32) == 2
    assert param_decode(2.5, m.MAV_PARAM_TYPE_REAL32) == 2.5
    assert struct.unpack("<i", struct.pack("<f", param_encode(2, m.MAV_PARAM_TYPE_INT32)))[0] == 2
    # -7's bit pattern is a NaN as a float, so compare bytes, not values.
    assert struct.pack("<f", param_encode(-7, m.MAV_PARAM_TYPE_INT32)) == struct.pack("<i", -7)

    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._param_queue.put({"kind": "set", "id": "s1", "name": "NAV_RCL_ACT", "value": 2, "ptype": m.MAV_PARAM_TYPE_INT32})
    b._service_params(conn)
    sent = [a for name, a in conn.mav.sent if name == "param_set_send"][-1]
    assert sent[3] == wire  # wire float carries the int's bytes
    # The echo (same bytes back) resolves the set, and the batch shows the logical value.
    b._on_mav(conn, _msg("PARAM_VALUE", param_id=b"NAV_RCL_ACT", param_value=wire,
                         param_type=m.MAV_PARAM_TYPE_INT32, param_index=65535, param_count=1))
    acks = [a[0] for name, a in emitted if name == "_emit_param_ack"]
    assert acks and acks[-1]["ok"] is True
    assert b._param_batch[-1]["value"] == 2


def test_malformed_param_set_is_acked_not_fatal(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    for bad in ({"kind": "set", "id": "p1", "name": "X", "value": "abc", "ptype": None},
                {"kind": "set", "id": "p2", "name": None, "value": 1.0},
                {"kind": "set", "id": "p3", "name": "WAY_TOO_LONG_PARAM_NAME", "value": 1.0}):
        b._param_queue.put(bad)
    b._service_params(conn)
    acks = [a[0] for name, a in emitted if name == "_emit_param_ack"]
    assert [a["id"] for a in acks] == ["p1", "p2", "p3"] and all(not a["ok"] for a in acks)
    assert conn.mav.sent == []


def test_handler_exception_does_not_kill_mav_thread(monkeypatch):
    monkeypatch.setattr(bridgemod, "LINK_REOPEN_MIN_S", 0.001)
    conn = FakeConn()
    monkeypatch.setattr(bridgemod, "open_connection", lambda e, b: conn)
    b = Bridge()
    calls = {"n": 0}

    def exploding(c):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("bug in a handler")
        if calls["n"] >= 3:
            raise SystemExit  # stop the loop
    monkeypatch.setattr(b, "_service_misc", exploding)
    t = threading.Thread(target=b._mav_loop, daemon=True)
    t.start(); t.join(timeout=3)
    assert calls["n"] >= 3 and b.handler_errors == 1


def test_foreign_heartbeats_do_not_overwrite_vehicle_state(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()

    def hb(sys_, comp, mtype, autopilot, base_mode, custom_mode):
        ns = _msg("HEARTBEAT", type=mtype, autopilot=autopilot, base_mode=base_mode,
                  custom_mode=custom_mode, system_status=m.MAV_STATE_ACTIVE)
        ns.get_srcSystem = lambda: sys_
        ns.get_srcComponent = lambda: comp
        return ns
    # A QGC heartbeat first: not a vehicle, must not lock.
    b._on_mav(conn, hb(255, 190, m.MAV_TYPE_GCS, m.MAV_AUTOPILOT_INVALID, 0, 0))
    assert b._vehicle is None and b.last_mav_at == 0
    # PX4 with a non-default sysid: lock on, armed, AUTO.LOITER.
    b._on_mav(conn, hb(7, 1, m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 128, (4 << 16) | (3 << 24)))
    assert b._vehicle == (7, 1) and b.tsys == 7
    assert b.latest["armed"] is True and b.latest["mode"] == "AUTO.LOITER"
    # A companion computer / second autopilot must not flip it.
    b._on_mav(conn, hb(42, 1, m.MAV_TYPE_ONBOARD_CONTROLLER, m.MAV_AUTOPILOT_GENERIC, 0, 0))
    b._on_mav(conn, hb(255, 190, m.MAV_TYPE_GCS, m.MAV_AUTOPILOT_INVALID, 0, 0))
    assert b.latest["armed"] is True and b.latest["mode"] == "AUTO.LOITER"
    # And commands go to the locked ids.
    b._cmd_queue.put({"id": "c1", "mav_cmd": 400, "params": [0] * 7})
    b._service_commands(conn)
    assert conn.mav.sent[-1][1][:2] == (7, 1)


def test_mission_download_nak_fails_fast(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._mission_queue.put({"kind": "pull", "mtype": 0, "rtype": "mission", "ack_type": "mission_ack"})
    b._service_missions(conn)
    b._on_mav(conn, _msg("MISSION_ACK", type=m.MAV_MISSION_DENIED, mission_type=0))
    msgs = [json.loads(a[0]) for name, a in emitted if name == "_do_broadcast"]
    assert msgs[-1]["type"] == "mission_ack" and msgs[-1]["ok"] is False and msgs[-1]["result"] == m.MAV_MISSION_DENIED
    assert b._mission is None


# --- mission path -----------------------------------------------------------

def test_mission_upload_times_out_after_bounded_retries(monkeypatch):
    monkeypatch.setattr(bridgemod, "MISSION_OP_TIMEOUT_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._mission_queue.put({"kind": "push", "id": "m1", "items": [{"kind": "rtl"}],
                          "mtype": 0, "rtype": "mission", "ack_type": "mission_ack"})
    for _ in range(bridgemod.MISSION_MAX_TRIES + 3):
        time.sleep(0.001)
        b._service_missions(conn)
    counts = [s for s in conn.mav.sent if s[0] == "mission_count_send"]
    assert len(counts) == bridgemod.MISSION_MAX_TRIES + 1  # kickoff + bounded retries
    acks = [a[0] for name, a in emitted if name == "_emit_mission_ack"]
    assert acks and acks[-1]["text"] == "timeout" and acks[-1]["ok"] is False
    assert b._mission is None


def test_second_mission_op_rejected_as_busy(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    for mid in ("m1", "m2"):
        b._mission_queue.put({"kind": "push", "id": mid, "items": [{"kind": "rtl"}],
                              "mtype": 0, "rtype": "mission", "ack_type": "mission_ack"})
    b._service_missions(conn)
    acks = [a[0] for name, a in emitted if name == "_emit_mission_ack"]
    assert [a["id"] for a in acks] == ["m2"] and acks[0]["text"] == "busy"
    assert b._mission["id"] == "m1"


def test_mission_request_for_wrong_plane_is_ignored(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._mission_queue.put({"kind": "push", "id": "m1", "items": [{"kind": "rtl"}],
                          "mtype": m.MAV_MISSION_TYPE_MISSION, "rtype": "mission", "ack_type": "mission_ack"})
    b._service_missions(conn)
    b._on_mav(conn, _msg("MISSION_REQUEST_INT", seq=0, mission_type=m.MAV_MISSION_TYPE_FENCE))
    assert not [s for s in conn.mav.sent if s[0] == "mission_item_int_send"]
    b._on_mav(conn, _msg("MISSION_REQUEST_INT", seq=0, mission_type=m.MAV_MISSION_TYPE_MISSION))
    assert [s for s in conn.mav.sent if s[0] == "mission_item_int_send"]
    b._on_mav(conn, _msg("MISSION_REQUEST_INT", seq=7, mission_type=m.MAV_MISSION_TYPE_MISSION))
    assert len([s for s in conn.mav.sent if s[0] == "mission_item_int_send"]) == 1  # out-of-range seq ignored


# --- transport reopen ---------------------------------------------------------

def test_open_retries_until_transport_appears(monkeypatch):
    monkeypatch.setattr(bridgemod, "LINK_REOPEN_MIN_S", 0.001)
    monkeypatch.setattr(bridgemod, "LINK_REOPEN_MAX_S", 0.002)
    attempts = []

    def flaky(endpoint, baud):
        attempts.append(endpoint)
        if len(attempts) < 3:
            raise OSError("no such device")
        return FakeConn()

    monkeypatch.setattr(bridgemod, "open_connection", flaky)
    b = Bridge(mavlink_endpoint="/dev/ttyUSB0")
    conn = b._open_with_retry()
    assert isinstance(conn, FakeConn) and len(attempts) == 3


def test_recv_errors_trigger_reopen(monkeypatch):
    monkeypatch.setattr(bridgemod, "LINK_REOPEN_MIN_S", 0.001)
    monkeypatch.setattr(bridgemod, "LINK_RECV_ERRORS_BEFORE_REOPEN", 3)
    conns: list[FakeConn] = []
    stop = threading.Event()

    def opener(endpoint, baud):
        c = FakeConn(recv_exc=OSError("device gone") if not conns else None)
        conns.append(c)
        if len(conns) >= 2:
            # Second connection is healthy; stop the loop shortly after.
            threading.Timer(0.05, lambda: setattr(c, "recv_exc", SystemExit)).start()
        return c

    monkeypatch.setattr(bridgemod, "open_connection", opener)
    b = Bridge()
    t = threading.Thread(target=b._mav_loop, daemon=True)
    t.start()
    t.join(timeout=3)
    assert len(conns) >= 2 and conns[0].closed is True
    assert b.link_reopens >= 1


# --- WS fan-out -------------------------------------------------------------

def test_slow_client_does_not_stall_others(ports):
    """A browser tab that stops reading (backgrounded, frozen) must not hold
    back telemetry for every other viewer on the hub WiFi."""
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._json_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        url = f"ws://127.0.0.1:{ports['ws']}"
        # Tiny receive buffer so the slow client's write side fills fast.
        # max_queue=1 + never calling recv(): the client stops reading its socket
        # once one frame is queued, so the server's writes to it back up.
        slow = await websockets.connect(url, max_queue=1)
        async with websockets.connect(url) as fast:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            t0 = time.time()
            n = 0
            # Feed 5 s of 25 Hz frames while `slow` never reads; `fast` must keep up.
            while time.time() - t0 < 1.5:
                s.sendto(json.dumps({"lat": 37.4, "airspeed": n}).encode(), ("127.0.0.1", ports["json"]))
                msg = json.loads(await asyncio.wait_for(fast.recv(), timeout=1.0))
                if msg["type"] == "telemetry":
                    n += 1
            assert n >= 20, f"fast client starved: only {n} frames in 1.5 s"
        await slow.close()
        serve_task.cancel()

    asyncio.run(scenario())


def test_client_disconnect_mid_command_is_harmless(ports):
    """Commander drops before its ack arrives: no crash, no dangling state, and
    the next client can claim."""
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        url = f"ws://127.0.0.1:{ports['ws']}"
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            await ws.send(json.dumps({"type": "command", "id": "a1", "name": "arm", "args": {}}))
        await asyncio.sleep(0.2)  # socket gone; the command is still in flight on the mav thread
        async with websockets.connect(url) as ws2:
            await ws2.send(json.dumps({"type": "claim", "id": "c2"}))
            for _ in range(20):
                msg = json.loads(await asyncio.wait_for(ws2.recv(), timeout=1.0))
                if msg.get("type") == "ack" and msg.get("id") == "c2":
                    assert msg["ok"] is True
                    break
            else:
                pytest.fail("second client could not claim after the first vanished")
        # Let the orphaned command time out; the asyncio side must not blow up.
        await asyncio.sleep(0.5)
        assert bridge._commander is None
        serve_task.cancel()

    asyncio.run(scenario())


def test_port_conflict_is_a_clean_error_not_a_traceback(ports):
    """Two gs instances is a normal operator mistake. The second must say what
    is wrong in one line, and the optional JSON feed must degrade, not crash."""
    first = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
                   json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=first._json_loop, daemon=True).start()

    async def hold():
        task = asyncio.create_task(first._serve())
        await asyncio.sleep(0.3)
        # A second daemon on the same WS port exits with an actionable message.
        second = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
                        json_port=ports["json"], ws_port=ports["ws"])
        with pytest.raises(SystemExit) as exc:
            await second._serve()
        msg = str(exc.value)
        assert "cannot serve" in msg and "--ws-port" in msg
        task.cancel()

    asyncio.run(hold())


def test_json_feed_disabled_when_its_port_is_taken(ports, capsys):
    """A clashing JSON port disables that optional feed and returns; it must not
    raise out of the thread (which read as a crash in the operator's terminal)."""
    hog = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    hog.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    hog.bind(("0.0.0.0", ports["json"]))
    try:
        b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
                   json_port=ports["json"], ws_port=ports["ws"])
        b._json_loop()  # returns rather than raising
        assert "JSON telemetry disabled" in capsys.readouterr().out
    finally:
        hog.close()


def test_json_feed_cannot_keep_the_link_green_for_a_dead_autopilot(ports, monkeypatch):
    """The failure this guards against was observed live: PX4's MAVLink died
    mid-flight, the sim's JSON power feed kept arriving, and gs reported
    linkState "alive" for an hour while re-broadcasting one frozen position.

    MAVLink is the flight link. Once a vehicle has been seen, only MAVLink
    freshness may decide link health."""
    monkeypatch.setattr(bridgemod, "STALE_MS", 200)
    monkeypatch.setattr(bridgemod, "LOST_MS", 600)
    b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
               json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=b._json_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            # A vehicle exists and is healthy.
            conn = FakeConn()
            b._on_mav(conn, _msg("HEARTBEAT", type=m.MAV_TYPE_FIXED_WING,
                                 autopilot=m.MAV_AUTOPILOT_PX4, base_mode=128,
                                 custom_mode=(4 << 16) | (3 << 24),
                                 system_status=m.MAV_STATE_ACTIVE))
            assert await _recv_until(ws, lambda x: x.get("linkState") == "alive") is not None

            # Now MAVLink dies, but the sim keeps publishing its JSON feed.
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

            async def keep_json_alive():
                for _ in range(40):
                    sock.sendto(json.dumps({"genW": 210.0, "loadW": 70.0}).encode(),
                                ("127.0.0.1", ports["json"]))
                    await asyncio.sleep(0.05)

            pump = asyncio.create_task(keep_json_alive())
            lost = await _recv_until(ws, lambda x: x.get("linkState") in ("stale", "lost"),
                                     tries=60)
            pump.cancel()
            assert lost is not None, "JSON traffic kept the vehicle link reported alive"
            assert lost["dataAgeMs"] is not None and lost["dataAgeMs"] >= 200
            # The JSON values still flow through — only the link VERDICT changed.
            assert lost.get("genW") == 210.0
        serve_task.cancel()

    asyncio.run(scenario())


def test_a_flightlink_only_run_still_reports_alive(ports, monkeypatch):
    """The no-PX4 path: with no vehicle ever seen, the JSON feed is genuinely the
    only source and must still drive link health."""
    monkeypatch.setattr(bridgemod, "STALE_MS", 400)
    b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
               json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=b._json_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(b._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.sendto(json.dumps({"lat": 37.4, "lon": -122.1}).encode(),
                        ("127.0.0.1", ports["json"]))
            assert await _recv_until(ws, lambda x: x.get("linkState") == "alive") is not None
        serve_task.cancel()

    asyncio.run(scenario())


def test_setpoint_ignored_unless_frame_and_mask_say_it_is_a_position(monkeypatch):
    """The commanded-path overlay (orange) appeared far from the actual path
    (cyan) on the globe. Two causes, both here:

      * lat_int/lon_int are degrees*1e7 ONLY in the GLOBAL frames. In
        MAV_FRAME_LOCAL_NED they are local metres, so /1e7 lands near null
        island — a few hundred metres of offset becomes tens of degrees.
      * type_mask declares which components are valid. PX4 often publishes a
        velocity setpoint with the position bits set to IGNORE, in which case
        those fields carry nothing meaningful.
    """
    b, _ = _bridge_with_loop(monkeypatch)
    conn = FakeConn()

    def target(frame, mask, lat_e7, lon_e7):
        return _msg("POSITION_TARGET_GLOBAL_INT", coordinate_frame=frame,
                    type_mask=mask, lat_int=lat_e7, lon_int=lon_e7, alt=233.0)

    # A genuine global position setpoint is used.
    b._on_mav(conn, target(m.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, 0b111111000, 373985511, -1221488530))
    assert abs(b.latest["targetLat"] - 37.3985511) < 1e-6
    assert abs(b.latest["targetLon"] - (-122.148853)) < 1e-6

    # A LOCAL_NED setpoint must be dropped, not divided by 1e7. 500 m north
    # would otherwise plot as 50 degrees of latitude.
    b._on_mav(conn, target(m.MAV_FRAME_LOCAL_NED, 0b111111000, 500_000_000, 0))
    assert "targetLat" not in b.latest, "LOCAL_NED coordinates were treated as lat/lon"

    # Re-establish a good one, then prove a position-IGNORE mask clears it rather
    # than leaving a stale overlay frozen somewhere wrong.
    b._on_mav(conn, target(m.MAV_FRAME_GLOBAL_INT, 0, 373985511, -1221488530))
    assert "targetLat" in b.latest
    b._on_mav(conn, target(m.MAV_FRAME_GLOBAL_INT, 0b000000011, 373985511, -1221488530))
    assert "targetLat" not in b.latest, "a velocity-only setpoint was plotted as a position"

    # And the stream is still considered alive either way, so gs does not spam
    # SET_MESSAGE_INTERVAL re-requests for a message it is receiving fine.
    assert b._last_target_at > 0


def test_ekf_velocity_decoding_is_physically_consistent(monkeypatch):
    """Every number gs publishes for track/groundspeed/climb must be the
    autopilot's own estimate, decoded with the right units and sign.

    The console used to reconstruct these by differencing GPS positions, which
    amplified noise. These come from GLOBAL_POSITION_INT vx/vy/vz: the EKF's
    NED velocity in cm/s, Doppler-derived.
    """
    b, _ = _bridge_with_loop(monkeypatch)
    conn = FakeConn()

    def pos(vx_cms, vy_cms, vz_cms, boot=1000):
        return _msg("GLOBAL_POSITION_INT", time_boot_ms=boot,
                    lat=373985511, lon=-1221488530, alt=233_000,
                    relative_alt=122_000, vx=vx_cms, vy=vy_cms, vz=vz_cms, hdg=9000)

    # Due north at 13 m/s: track 0, groundspeed 13, level.
    b._on_mav(conn, pos(1300, 0, 0))
    assert abs(b.latest["trackDeg"] - 0.0) < 1e-6
    assert abs(b.latest["groundspeed"] - 13.0) < 1e-9
    assert abs(b.latest["climb"] - 0.0) < 1e-9
    assert abs(b.latest["vn"] - 13.0) < 1e-9

    # Due east: track 90.
    b._on_mav(conn, pos(0, 1300, 0, boot=1100))
    assert abs(b.latest["trackDeg"] - 90.0) < 1e-6

    # South-west: track 225, and groundspeed is the vector magnitude, so a
    # 45-degree diagonal at 13 m/s per axis is 13*sqrt(2) over the ground.
    b._on_mav(conn, pos(-1300, -1300, 0, boot=1200))
    assert abs(b.latest["trackDeg"] - 225.0) < 1e-6
    assert abs(b.latest["groundspeed"] - 13.0 * math.sqrt(2)) < 1e-9

    # NED's down axis is POSITIVE down, so a climb is negative vz. Getting this
    # sign backwards would show a descent as a climb.
    b._on_mav(conn, pos(1300, 0, -250, boot=1300))
    assert abs(b.latest["climb"] - 2.5) < 1e-9, "climb sign is inverted"
    b._on_mav(conn, pos(1300, 0, 250, boot=1400))
    assert abs(b.latest["climb"] + 2.5) < 1e-9

    # Track must stay in [0, 360).
    for vx, vy in ((1300, -1300), (-1300, 1300), (0, -1300)):
        b._on_mav(conn, pos(vx, vy, 0, boot=1500))
        assert 0.0 <= b.latest["trackDeg"] < 360.0


def test_wind_cov_is_decoded_in_the_aviation_convention(monkeypatch):
    """WIND_COV carries the air's motion as NED components, i.e. the direction it
    blows TOWARD. Every wind report in aviation names the direction it blows
    FROM, so the bearing is the reciprocal. Getting this backwards puts a
    headwind on the tail."""
    b, _ = _bridge_with_loop(monkeypatch)
    conn = FakeConn()

    def wind(wx, wy, wz=0.0, var=0.25):
        return _msg("WIND_COV", time_usec=1, wind_x=wx, wind_y=wy, wind_z=wz,
                    var_horiz=var, var_vert=0.1, wind_alt=233.0,
                    horiz_accuracy=0.5, vert_accuracy=0.5)

    # Air moving NORTH at 5 m/s is a wind FROM the south (180).
    b._on_mav(conn, wind(5.0, 0.0))
    assert abs(b.latest["windSpeed"] - 5.0) < 1e-9
    assert abs(b.latest["windFromDeg"] - 180.0) < 1e-6

    # Air moving EAST is a wind from the west (270).
    b._on_mav(conn, wind(0.0, 5.0))
    assert abs(b.latest["windFromDeg"] - 270.0) < 1e-6

    # Air moving SOUTH is a wind from the north (0).
    b._on_mav(conn, wind(-5.0, 0.0))
    assert abs(b.latest["windFromDeg"] - 0.0) < 1e-6

    # Magnitude is the vector sum, not a component.
    b._on_mav(conn, wind(3.0, 4.0))
    assert abs(b.latest["windSpeed"] - 5.0) < 1e-9

    # The estimator's variance becomes a 1-sigma the UI can show, so an
    # unreliable estimate can say so rather than being believed.
    b._on_mav(conn, wind(3.0, 4.0, var=4.0))
    assert abs(b.latest["windSigma"] - 2.0) < 1e-9
    b._on_mav(conn, wind(3.0, 4.0, var=-1.0))      # garbage variance
    assert b.latest["windSigma"] == 0.0


def test_wind_triangle_identity_matches_the_estimator(monkeypatch):
    """Cross-check: the estimator's wind must satisfy the same identity the
    hand-rolled triangle used, ground = air + wind. If gs's WIND_COV decoding
    and its velocity decoding disagree, this catches it."""
    import math as _m
    # Nose north at 12 airspeed, wind from the north at 4 => 8 over the ground.
    heading, airspeed = 0.0, 12.0
    wind_from, wind_speed = 0.0, 4.0
    # Wind vector points TOWARD (from + 180).
    toward = _m.radians(wind_from + 180.0)
    wx, wy = wind_speed * _m.cos(toward), wind_speed * _m.sin(toward)
    ax = airspeed * _m.cos(_m.radians(heading))
    ay = airspeed * _m.sin(_m.radians(heading))
    gx, gy = ax + wx, ay + wy
    assert abs(_m.hypot(gx, gy) - 8.0) < 1e-9
    assert abs((_m.degrees(_m.atan2(gy, gx)) + 360) % 360 - 0.0) < 1e-6
