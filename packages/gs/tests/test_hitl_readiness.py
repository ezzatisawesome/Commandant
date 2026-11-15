"""Faults found reviewing gs against thror's HITL recordings (2026-11-04).

Each test fails on the code before the fix. The two marked MEASURED come
straight from thror's logs: the ACKs from `logs/commandant-20261025-143436.tlog`
and the sun clock from its `.jsonl` sidecar and `gs.log`.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from types import SimpleNamespace

from gs import bridge as bridgemod
from gs import relay as relaymod
from gs.bridge import Bridge, json_value_ok, param_echo_matches
from pymavlink import mavutil

from test_robustness import FakeConn, _bridge_with_loop

m = mavutil.mavlink


def _ack(command: int, result: int, target_system: int = 0, target_component: int = 0):
    ns = SimpleNamespace(command=command, result=result,
                         target_system=target_system, target_component=target_component)
    ns.get_type = lambda: "COMMAND_ACK"
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns


def _results(emitted):
    return [e[1][0] for e in emitted if e[1] and isinstance(e[1][0], dict) and "ok" in e[1][0]]


# --- COMMAND_ACK attribution ------------------------------------------------

def test_ack_addressed_to_another_sender_does_not_resolve_ours(monkeypatch):
    """MEASURED: on HITL the host (sysid 100) shares gs's link, so its ACKs arrive too --
    21 "arm denied" in one HITL session. One must not answer the operator's arm."""
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._cmd_queue.put({"id": "arm", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM, "params": [1] + [0] * 6})
    b._service_commands(conn)
    b._on_mav(conn, _ack(m.MAV_CMD_COMPONENT_ARM_DISARM, m.MAV_RESULT_DENIED, 100, 1))
    assert "arm" in b._pending and _results(emitted) == []
    b._on_mav(conn, _ack(m.MAV_CMD_COMPONENT_ARM_DISARM, m.MAV_RESULT_ACCEPTED,
                         bridgemod.GCS_SYSTEM, bridgemod.GCS_COMPONENT))
    assert _results(emitted)[-1]["ok"] is True and b._pending == {}


def test_untargeted_ack_still_resolves(monkeypatch):
    """target 0 is a broadcast ACK (and what older stacks send): still ours."""
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._cmd_queue.put({"id": "c", "mav_cmd": m.MAV_CMD_DO_SET_MODE, "params": [0] * 7})
    b._service_commands(conn)
    b._on_mav(conn, _ack(m.MAV_CMD_DO_SET_MODE, m.MAV_RESULT_ACCEPTED))
    assert _results(emitted)[-1]["ok"] is True


def test_echo_of_a_retried_arm_does_not_resolve_the_next_disarm(monkeypatch):
    monkeypatch.setattr(bridgemod, "CMD_RETRY_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    arm = m.MAV_CMD_COMPONENT_ARM_DISARM
    b._cmd_queue.put({"id": "arm", "mav_cmd": arm, "params": [1] + [0] * 6})
    b._service_commands(conn)
    b._service_commands(conn)            # the ACK was slow: arm sent twice
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_ACCEPTED))       # resolves the arm
    assert _results(emitted)[-1]["ok"] is True
    b._cmd_queue.put({"id": "disarm", "mav_cmd": arm, "params": [0] * 7})
    b._service_commands(conn)
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_ACCEPTED))       # the retried ARM's echo
    assert "disarm" in b._pending, "an arm's echo resolved the disarm"
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_DENIED))          # the disarm's own verdict
    assert _results(emitted)[-1] == {**_results(emitted)[-1], "id": "disarm", "ok": False}


# --- the JSON feed ----------------------------------------------------------

def test_sim_sun_clock_is_accepted():
    """MEASURED: the value flightlink sent on thror, refused on every frame."""
    assert json_value_ok("sunEpochMs", 1782072615644.1213)
    assert not json_value_ok("sunEpochMs", -5.0)


def test_huge_json_integer_is_refused_not_raised():
    assert json_value_ok("alt", 10 ** 400) is False


def test_json_feed_survives_a_frame_that_raises(ports, monkeypatch):
    b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
               json_port=ports["json"], ws_port=ports["ws"])
    seen = []
    real = b._apply_json

    def apply(obj):
        seen.append(obj)
        if obj.get("boom"):
            raise RuntimeError("bad frame")
        real(obj)

    monkeypatch.setattr(b, "_apply_json", apply)
    threading.Thread(target=b._json_loop, daemon=True).start()
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for frame in ({"boom": True}, {"alt": 12.0}):
        time.sleep(0.2)
        tx.sendto(json.dumps(frame).encode(), ("127.0.0.1", ports["json"]))
    deadline = time.time() + 3
    while len(seen) < 2 and time.time() < deadline:
        time.sleep(0.05)
    assert len(seen) == 2, "the JSON thread died on the first frame"
    assert b.json_errors == 1


# --- param echo ---------------------------------------------------------------

def test_param_echo_is_compared_as_float32():
    stored = __import__("struct").unpack("<f", __import__("struct").pack("<f", 25000.1))[0]
    assert param_echo_matches(stored, 25000.1)          # was a false "rejected"
    assert not param_echo_matches(5e-5, 1e-4)           # was a false "set"
    assert param_echo_matches(1.0, 1.0)


# --- the 25 Hz loop -----------------------------------------------------------

def test_broadcast_tick_exception_does_not_end_the_daemon(ports, monkeypatch):
    b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
               json_port=ports["json"], ws_port=ports["ws"])
    calls = []

    def tick():
        calls.append(1)
        if len(calls) == 1:
            raise TypeError("not JSON serialisable")

    monkeypatch.setattr(b, "_broadcast_tick", tick)

    async def scenario():
        task = asyncio.create_task(b._serve())
        await asyncio.sleep(0.6)
        alive = not task.done()
        task.cancel()
        return alive

    assert asyncio.run(scenario())
    assert len(calls) > 3 and b.broadcast_errors == 1


# --- relay uplink ---------------------------------------------------------------

def test_relay_resends_link_and_plan_after_a_reconnect(monkeypatch):
    """The relay clears what it retained when the publisher drops; the next
    connection must give it back the plan and the link state."""
    connects: list[list[str]] = []

    class FakeWS:
        def __init__(self):
            self.sent: list[str] = []

        async def send(self, payload):
            self.sent.append(payload)

    class FakeConnect:
        def __init__(self, *a, **k):
            self.ws = FakeWS()

        async def __aenter__(self):
            connects.append(self.ws.sent)
            return self.ws

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(relaymod.websockets, "connect", FakeConnect)
    monkeypatch.setattr(relaymod, "RECONNECT_MIN_S", 0.0)
    pub = relaymod.RelayPublisher("wss://x/publish", "t", hz=50, flight_id="f")
    pumps = []

    async def pump(ws):
        pumps.append(ws)
        if len(pumps) == 1:
            pub._enqueue(json.dumps({"type": "mission", "count": 2, "items": []}), "event")
            pub._enqueue(json.dumps({"type": "link", "state": "alive"}), "link")
            raise ConnectionError("keepalive ping timeout")
        raise asyncio.CancelledError

    monkeypatch.setattr(pub, "_pump", pump)

    async def scenario():
        try:
            await pub.run()
        except asyncio.CancelledError:
            pass

    asyncio.run(scenario())
    second = [json.loads(p)["type"] for p in connects[1]]
    assert second == ["flight", "mission", "link"]


# --- the mission protocol on a shared link --------------------------------------

HOST = 100      # the AircraftSim host's sysid on thror


def _mmsg(mtype: str, target_system: int = 0, **fields):
    ns = SimpleNamespace(target_system=target_system, target_component=0,
                         mission_type=m.MAV_MISSION_TYPE_MISSION, **fields)
    ns.get_type = lambda: mtype
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns


def _item(seq: int, target_system: int = 0):
    return _mmsg("MISSION_ITEM_INT", target_system, seq=seq, command=m.MAV_CMD_NAV_WAYPOINT,
                 frame=6, param1=0.0, param2=0.0, param3=0.0, param4=0.0,
                 x=374000000, y=-1221500000, z=120.0)


def _pull(b):
    b._mission_queue.put({"kind": "pull", "id": "p", "mtype": m.MAV_MISSION_TYPE_MISSION,
                          "rtype": "mission", "ack_type": "mission_ack"})


def _readbacks(emitted):
    """Broadcasts hand the loop (payload_json, kind)."""
    return [json.loads(a[0]) for name, a in emitted
            if name == "_do_broadcast" and a[1] == "mission"]


def test_host_mission_request_is_not_answered_during_our_upload(monkeypatch):
    """MEASURED on thror's shared HITL link: 11 host uploads' MISSION_REQUESTs reached gs."""
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._mission_queue.put({"kind": "push", "id": "u", "items": [{"kind": "rtl"}],
                          "mtype": m.MAV_MISSION_TYPE_MISSION, "rtype": "mission", "ack_type": "mission_ack"})
    b._service_missions(conn)
    b._on_mav(conn, _mmsg("MISSION_REQUEST_INT", HOST, seq=0))
    assert not [s for s in conn.mav.sent if s[0] == "mission_item_int_send"]
    b._on_mav(conn, _mmsg("MISSION_ACK", HOST, type=m.MAV_MISSION_ACCEPTED))
    assert b._mission is not None, "the host's MISSION_ACK finished our upload"


def test_host_readback_items_do_not_fill_ours(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    _pull(b)
    b._service_missions(conn)
    b._on_mav(conn, _mmsg("MISSION_COUNT", HOST, count=1))
    b._on_mav(conn, _item(0, HOST))
    assert b._mission["count"] is None and b._mission["items"] == {}


def test_download_ignores_items_before_count_and_past_it(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    _pull(b)
    b._service_missions(conn)
    b._on_mav(conn, _item(0))                    # before MISSION_COUNT
    b._on_mav(conn, _mmsg("MISSION_COUNT", count=2))
    b._on_mav(conn, _item(0))
    b._on_mav(conn, _item(5))                    # past count
    assert _readbacks(emitted) == [], "declared complete with item 1 missing"
    b._on_mav(conn, _item(1))
    (rb,) = _readbacks(emitted)
    assert rb["count"] == 2 and len(rb["items"]) == 2


# --- reopen -----------------------------------------------------------------------

def test_reopen_tries_the_link_that_was_working_first(monkeypatch, tmp_path):
    dev = tmp_path / "ttyACM0"
    dev.write_text("")
    b = Bridge(mavlink_endpoint=bridgemod.AUTODETECT)
    b.active_endpoint = f"{dev}"
    b._opened_at_ms = 100
    b.last_mav_at = 200                              # it delivered data
    assert b._reopen_endpoint() == f"{dev}"
    b.last_mav_at = 50                               # opened, never delivered
    assert b._reopen_endpoint() is None
    b.last_mav_at = 200
    dev.unlink()                                     # unplugged
    assert b._reopen_endpoint() is None
    pinned = Bridge(mavlink_endpoint="udpin:0.0.0.0:14550")
    pinned.last_mav_at = 200
    assert pinned._reopen_endpoint() is None         # nothing to prefer: never probes


def test_reopen_does_not_reprobe_a_working_link(monkeypatch):
    b = Bridge(mavlink_endpoint=bridgemod.AUTODETECT)
    b.active_endpoint, b._opened_at_ms, b.last_mav_at = "udpin:0.0.0.0:14550", 1, 2
    probed = []
    monkeypatch.setattr(bridgemod, "detect_endpoint", lambda *a: probed.append(1) or None)
    monkeypatch.setattr(bridgemod, "open_connection", lambda e, baud: SimpleNamespace(write=lambda buf: None, e=e))
    conn = b._open_with_retry()
    assert conn.e == "udpin:0.0.0.0:14550" and probed == []


# --- the daemon's own log ---------------------------------------------------------

def test_log_lines_are_stamped_once_each():
    from gs.__main__ import _StampedLines
    import io
    sink = io.StringIO()
    out = _StampedLines(sink)
    print("[gs] one", file=out)
    print("[gs] two\n[gs] three", file=out)
    lines = sink.getvalue().splitlines()
    assert len(lines) == 3
    assert all(l[4] == "-" and l[10] == "T" and l[19:21] == " [" for l in lines), lines


# --- a second set of the same parameter -----------------------------------------

def _pv(name: bytes, value: float, idx: int = 65535):
    ns = SimpleNamespace(param_id=name, param_value=value, param_type=9,
                         param_index=idx, param_count=10)
    ns.get_type = lambda: "PARAM_VALUE"
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns


def test_a_superseded_param_set_is_answered_and_its_echo_is_not_a_rejection(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    for sid, v in (("s1", 4.0), ("s2", 5.0)):
        b._param_queue.put({"kind": "set", "id": sid, "name": "X", "value": v, "ptype": 9})
        b._service_params(conn)
    acks = lambda: [a[0] for name, a in emitted if name == "_emit_param_ack"]
    assert [(a["id"], a["ok"]) for a in acks()] == [("s1", False)]
    assert "superseded" in acks()[0]["text"]
    b._param_set_pending["X"]["tries"] = 1
    b._on_mav(conn, _pv(b"X", 4.0))            # the FIRST set's echo
    assert len(acks()) == 1 and "X" in b._param_set_pending
    b._on_mav(conn, _pv(b"X", 5.0))
    assert (acks()[-1]["id"], acks()[-1]["ok"]) == ("s2", True)


# --- the flight log's writer thread ---------------------------------------------

def test_a_non_disk_error_disables_the_log_visibly(tmp_path):
    from gs.flightlog import FlightLog
    log = FlightLog(tmp_path).start()

    class Closed:
        def write(self, *_a): raise ValueError("I/O operation on closed file.")
        def flush(self): pass
        def tell(self): return 0
        def close(self): pass
        def fileno(self): return -1

    log._fh = Closed()
    log.write(b"\xfd" + bytes(20))
    deadline = time.time() + 2
    while log.enabled and time.time() < deadline:
        time.sleep(0.02)
    assert not log.enabled and "closed file" in (log.error or "")
    assert log._thread.is_alive(), "the writer thread died instead of reporting"
    log.stop()


# --- relay uplink backpressure ----------------------------------------------------

def test_relay_holds_telemetry_back_while_the_uplink_is_backlogged(monkeypatch):
    sent = []

    class Transport:
        size = relaymod.TELEMETRY_BACKLOG_BYTES + 1

        def get_write_buffer_size(self):
            return self.size

    class WS:
        transport = Transport()

        async def send(self, p):
            sent.append(p)

    pub = relaymod.RelayPublisher("wss://x/publish", "t", hz=100)
    ws = WS()

    async def scenario():
        pub._loop = asyncio.get_running_loop()
        pub._wake = asyncio.Event()
        task = asyncio.create_task(pub._pump(ws))
        pub._enqueue('{"type":"statustext","text":"a"}', "event")
        pub._enqueue('{"type":"telemetry","n":1}', "telemetry")
        await asyncio.sleep(0.15)
        held = list(sent)
        ws.transport.size = 0
        await asyncio.sleep(0.15)
        task.cancel()
        return held

    held = asyncio.run(scenario())
    assert held == ['{"type":"statustext","text":"a"}'], "events are never held back"
    assert sent[-1] == '{"type":"telemetry","n":1}'


# --- a reply after the timeout ----------------------------------------------------

def _timed_out_arm(monkeypatch):
    monkeypatch.setattr(bridgemod, "CMD_RETRY_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    arm = m.MAV_CMD_COMPONENT_ARM_DISARM
    b._cmd_queue.put({"id": "arm", "mav_cmd": arm, "params": [1] + [0] * 6})
    for _ in range(bridgemod.CMD_MAX_TRIES + 1):
        b._service_commands(conn)
    assert _results(emitted)[-1]["text"] == "timeout"
    return b, emitted, conn, arm


def test_a_late_reply_is_told_to_the_operator_not_given_to_the_next_command(monkeypatch):
    b, emitted, conn, arm = _timed_out_arm(monkeypatch)
    b._cmd_queue.put({"id": "arm2", "mav_cmd": arm, "params": [1] + [0] * 6})
    b._service_commands(conn)
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_ACCEPTED))       # the first arm, late
    assert "arm2" in b._pending
    notes = [json.loads(a[0]) for name, a in emitted
             if name == "_do_broadcast" and a[1] == "statustext"]
    assert notes and "late reply to MAV_CMD_COMPONENT_ARM_DISARM" in notes[-1]["text"]
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_ACCEPTED))       # arm2's own
    assert _results(emitted)[-1]["id"] == "arm2" and _results(emitted)[-1]["ok"] is True


def test_lost_replies_cost_the_retry_one_resend_not_its_outcome(monkeypatch):
    b, emitted, conn, arm = _timed_out_arm(monkeypatch)    # its ACKs were LOST
    b._cmd_queue.put({"id": "arm2", "mav_cmd": arm, "params": [1] + [0] * 6})
    b._service_commands(conn)
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_ACCEPTED))       # arm2's 1st: swallowed
    b._service_commands(conn)                               # resend
    b._on_mav(conn, _ack(arm, m.MAV_RESULT_ACCEPTED))
    assert _results(emitted)[-1]["id"] == "arm2" and _results(emitted)[-1]["ok"] is True


# --- autodetect on a HITL bench -------------------------------------------------

def test_autodetect_skips_a_port_another_process_holds(tmp_path, monkeypatch):
    dev = tmp_path / "ttyACM0"
    dev.write_text("")
    free = tmp_path / "ttyUSB0"
    free.write_text("")
    proc = tmp_path / "proc"
    (proc / "4242" / "fd").mkdir(parents=True)          # the JSBSim bridge
    (proc / "4242" / "fd" / "7").symlink_to(dev)
    (proc / "self-ish").mkdir()                          # non-pid entries ignored
    assert bridgemod.device_in_use(str(dev), str(proc))
    assert not bridgemod.device_in_use(str(free), str(proc))
    assert not bridgemod.device_in_use(str(dev), str(tmp_path / "no-proc"))  # macOS: unknown = free

    monkeypatch.setattr(bridgemod, "SERIAL_CANDIDATES", [(str(tmp_path / "tty*"), 57600)])
    monkeypatch.setattr(bridgemod, "device_in_use",
                        lambda d, proc_root="/proc": d == str(dev))
    cands = bridgemod.candidate_endpoints()
    assert f"serial:{free}:57600" in cands and not any(str(dev) in c for c in cands)


# --- event metadata from the vehicle (MAVLink FTP) --------------------------------

import lzma
import struct as _struct
from gs import ftp as ftpmod
from test_events import FIX, FRAME_REFUSAL


class FakePx4Ftp:
    """PX4's mavlink_ftp.cpp semantics: reply seq = request seq + 1, a resent
    request gets the last reply again, ONE session, EOF as a NAK."""

    def __init__(self, files: dict[str, bytes], drop_every: int = 0):
        self.files, self.drop_every = files, drop_every
        self.fd: bytes | None = None
        self.last_req_seq: int | None = None
        self.last_reply: bytes | None = None
        self.replies = 0
        self.ops: list[int] = []

    def _reply(self, seq, opcode, req_op, data=b"", offset=0):
        # PayloadHeader: seq, session, opcode, size, req_opcode, burst_complete, pad, offset
        head = _struct.pack("<HBBBBBxI", seq + 1, 0, opcode, len(data), req_op, 0, offset)
        return (head + data).ljust(ftpmod.PAYLOAD_LEN, b"\0")

    def handle(self, req: bytes) -> bytes | None:
        seq, session, op, size, _r, offset, data = ftpmod.parse(req)
        self.ops.append(op)
        if seq == self.last_req_seq:
            out = self.last_reply                      # a resend
        elif op == ftpmod.OP_OPEN_RO:
            path = data.decode()
            if self.fd is not None:
                out = self._reply(seq, ftpmod.RSP_NAK, op, bytes([ftpmod.ERR_NO_SESSIONS]))
            elif path not in self.files:
                out = self._reply(seq, ftpmod.RSP_NAK, op, bytes([10]))
            else:
                self.fd = self.files[path]
                out = self._reply(seq, ftpmod.RSP_ACK, op, _struct.pack("<I", len(self.fd)))
        elif op == ftpmod.OP_READ:
            chunk = self.fd[offset:offset + size] if self.fd is not None else b""
            out = (self._reply(seq, ftpmod.RSP_ACK, op, chunk, offset) if chunk
                   else self._reply(seq, ftpmod.RSP_NAK, op, bytes([ftpmod.ERR_EOF])))
        elif op == ftpmod.OP_TERMINATE:
            self.fd = None
            out = self._reply(seq, ftpmod.RSP_ACK, op)
        else:
            out = self._reply(seq, ftpmod.RSP_NAK, op, bytes([1]))
        self.last_req_seq, self.last_reply = seq, out
        self.replies += 1
        if self.drop_every and self.replies % self.drop_every == 0:
            return None                                # lost on the radio
        return out


def _run(job, server, steps=5000):
    now = 0
    for _ in range(steps):
        if job.finished:
            break
        req = job.request(now)
        if req is not None:
            rep = server.handle(req)
            if rep is not None:
                job.reply(rep)
        now += 300
    return job


def test_ftp_read_survives_lost_replies():
    blob = bytes(range(256)) * 70                          # 17.9 kB, > 70 chunks
    srv = FakePx4Ftp({"/etc/extras/all_events.json.xz": blob}, drop_every=3)
    job = _run(ftpmod.FtpRead("/etc/extras/all_events.json.xz"), srv)
    assert job.state == "done" and bytes(job.data) == blob
    assert srv.fd is None, "the session was left open"


def test_ftp_never_resets_another_clients_session():
    srv = FakePx4Ftp({"/x": b"abc"})
    srv.fd = b"theirs"                                      # QGC mid-transfer
    job = _run(ftpmod.FtpRead("/x"), srv)
    assert job.state == "failed" and "another client" in job.error
    assert ftpmod.OP_TERMINATE not in srv.ops and srv.fd == b"theirs"


def test_ftp_failure_after_open_closes_the_session():
    srv = FakePx4Ftp({"/x": b"a" * 1000})
    job = ftpmod.FtpRead("/x")
    job.request(0)
    job.reply(srv.handle(job._sent))                        # opened
    srv.handle = (lambda real: (lambda req: None if ftpmod.parse(req)[2] == ftpmod.OP_READ
                                else real(req)))(srv.handle)  # reads vanish
    job = _run(job, srv)
    assert job.state == "failed" and "no reply to read" in job.error
    assert srv.fd is None, "PX4's one session is still held"


def test_ftp_ignores_a_reply_that_is_not_ours():
    job = ftpmod.FtpRead("/x")
    job.request(0)
    job.reply(ftpmod.payload(99, ftpmod.RSP_ACK, size=4, data=_struct.pack("<I", 5)))
    assert job.state == "open" and job.size is None


def _ftp_conn(srv, b):
    sent = []

    class Mav:
        def file_transfer_protocol_send(self, net, tsys, tcomp, payload):
            sent.append((tsys, tcomp))
            rep = srv.handle(bytes(payload))
            if rep is not None:
                msg = SimpleNamespace(target_network=0, target_system=bridgemod.GCS_SYSTEM,
                                      target_component=bridgemod.GCS_COMPONENT, payload=list(rep))
                msg.get_type = lambda: "FILE_TRANSFER_PROTOCOL"
                msg.get_srcSystem = lambda: 1
                msg.get_srcComponent = lambda: 1
                b._on_mav_protocol(conn, 0, "FILE_TRANSFER_PROTOCOL", msg)

        def __getattr__(self, name):
            return lambda *a, **k: None

    conn = SimpleNamespace(mav=Mav())
    return conn, sent


def test_gs_reads_the_vehicles_metadata_and_decodes_with_it(monkeypatch):
    monkeypatch.setattr(bridgemod, "find_metadata", lambda explicit=None: None)
    monkeypatch.delenv("GS_EVENTS_META", raising=False)
    b = Bridge()
    assert b._events is None
    b._vehicle = (1, 1)
    srv = FakePx4Ftp({bridgemod.EVENTS_META_FTP_PATH: lzma.compress(FIX.read_bytes())}, drop_every=4)
    conn, sent = _ftp_conn(srv, b)
    clock = [0]
    monkeypatch.setattr(bridgemod, "_mono_ms", lambda: clock[0])
    for _ in range(400):
        b._service_event_metadata(conn)
        clock[0] += 300
        if b._events is not None:
            break
    assert b._events_source == "vehicle" and sent[0] == (1, 1)
    assert b._events.decode(FRAME_REFUSAL)["event"] == "navigator_mis_land_missing"


def test_an_explicit_metadata_file_is_never_overridden(monkeypatch):
    monkeypatch.setenv("GS_EVENTS_META", str(FIX))
    b = Bridge()
    b._vehicle = (1, 1)
    srv = FakePx4Ftp({})
    conn, sent = _ftp_conn(srv, b)
    b._service_event_metadata(conn)
    assert sent == [] and b._events_source == "explicit"


def test_a_corrupt_transfer_is_rejected_and_retried_later(monkeypatch):
    monkeypatch.setattr(bridgemod, "find_metadata", lambda explicit=None: None)
    monkeypatch.delenv("GS_EVENTS_META", raising=False)
    b = Bridge()
    b._vehicle = (1, 1)
    good = lzma.compress(FIX.read_bytes())
    srv = FakePx4Ftp({bridgemod.EVENTS_META_FTP_PATH: good[:-40] + bytes(40)})
    conn, _ = _ftp_conn(srv, b)
    clock = [0]
    monkeypatch.setattr(bridgemod, "_mono_ms", lambda: clock[0])
    for _ in range(100):
        b._service_event_metadata(conn)
        clock[0] += 300
    assert b._events is None and b._meta_failures == 1
    assert b._meta_next_try_ms > clock[0], "retried immediately instead of backing off"


# --- a mode command is judged by the mode, not the ACK ---------------------------

AUTO_LOITER = (4 << 16) | (3 << 24)
AUTO_MISSION = (4 << 16) | (4 << 24)


def _hb(custom_mode: int):
    ns = SimpleNamespace(type=m.MAV_TYPE_FIXED_WING, autopilot=m.MAV_AUTOPILOT_PX4,
                         base_mode=128 | 1, custom_mode=custom_mode,
                         system_status=m.MAV_STATE_ACTIVE, mavlink_version=3)
    ns.get_type = lambda: "HEARTBEAT"
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns


def _text(severity: int, text: str):
    ns = SimpleNamespace(severity=severity, text=text, id=0, chunk_seq=0)
    ns.get_type = lambda: "STATUSTEXT"
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns


def _set_mission(b, conn):
    b._cmd_queue.put({"id": "s1", "mav_cmd": m.MAV_CMD_DO_SET_MODE,
                      "params": [float(m.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED), 4, 4, 0, 0, 0, 0]})
    b._service_commands(conn)
    b._on_mav(conn, _ack(m.MAV_CMD_DO_SET_MODE, m.MAV_RESULT_ACCEPTED))


def test_an_accepted_mode_switch_that_px4_then_refuses_is_reported_as_refused(monkeypatch):
    """MEASURED on PX4 1.16 SITL: ACCEPTED, then "Switching to Mission is
    currently not available", and the vehicle stayed in AUTO.LOITER."""
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    _set_mission(b, conn)
    first = _results(emitted)[-1]
    assert first["final"] is False and "waiting for AUTO.MISSION" in first["text"]
    b._on_mav(conn, _text(m.MAV_SEVERITY_CRITICAL, "Switching to Mission is currently not available"))
    b._on_mav(conn, _hb(AUTO_LOITER))
    monkeypatch.setattr(bridgemod, "MODE_VERIFY_MS", 0)
    b._mode_verify["s1"]["until"] = 0
    b._service_commands(conn)
    verdict = _results(emitted)[-1]
    assert verdict["id"] == "s1" and verdict["ok"] is False and verdict.get("final", True)
    assert "stayed in AUTO.LOITER" in verdict["text"] and "not available" in verdict["text"]


def test_a_mode_switch_is_confirmed_by_the_heartbeat(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    _set_mission(b, conn)
    b._on_mav(conn, _hb(AUTO_LOITER))
    assert "s1" in b._mode_verify                       # not yet
    b._on_mav(conn, _hb(AUTO_MISSION))
    verdict = _results(emitted)[-1]
    assert verdict["ok"] is True and verdict["text"] == "accepted (now AUTO.MISSION)"
    assert b._mode_verify == {}


def test_arm_is_still_answered_by_its_ack(monkeypatch):
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._cmd_queue.put({"id": "a", "mav_cmd": m.MAV_CMD_COMPONENT_ARM_DISARM, "params": [1] + [0] * 6})
    b._service_commands(conn)
    b._on_mav(conn, _ack(m.MAV_CMD_COMPONENT_ARM_DISARM, m.MAV_RESULT_ACCEPTED))
    assert _results(emitted)[-1]["ok"] is True and b._mode_verify == {}


# --- a param refresh that PX4 cuts short (it was still booting) -------------------

def test_a_cut_short_list_is_requested_again_then_filled_in_wide_batches(monkeypatch):
    """MEASURED: gs up before PX4 booted; PX4 answered the list with a fragment
    and 20-reads-per-quiet-sweep took 72 s to fill a table that floods in 0.8 s."""
    monkeypatch.setattr(bridgemod, "PARAM_GAP_QUIET_MS", 0)
    b, emitted = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    b._param_queue.put({"kind": "refresh"})
    b._service_params(conn)
    for i in (64, 65, 66):                                  # the fragment
        b._on_mav(conn, SimpleNamespace(param_id=f"P{i}".encode(), param_value=0.0, param_type=9,
                                        param_index=i, param_count=955,
                                        get_type=lambda: "PARAM_VALUE",
                                        get_srcSystem=lambda: 1, get_srcComponent=lambda: 1))
    conn.mav.sent.clear()
    time.sleep(0.002)
    b._service_params(conn)
    assert [n for n, _ in conn.mav.sent] == ["param_request_list_send"], "re-list first"
    conn.mav.sent.clear()
    time.sleep(0.002)
    b._service_params(conn)                                 # it was cut short again
    reads = [a for n, a in conn.mav.sent if n == "param_request_read_send"]
    assert len(reads) == bridgemod.PARAM_GAP_READS and not any(
        n == "param_request_list_send" for n, _ in conn.mav.sent), "re-list only once"


# --- where the aircraft is, and where it goes home to ------------------------------

def test_landed_state_and_home_reach_the_frame(monkeypatch):
    b, _ = _bridge_with_loop(monkeypatch)
    conn = FakeConn()
    ess = SimpleNamespace(landed_state=2, vtol_state=0, get_type=lambda: "EXTENDED_SYS_STATE",
                          get_srcSystem=lambda: 1, get_srcComponent=lambda: 1)
    home = SimpleNamespace(latitude=374000521, longitude=-1221501917, altitude=865500,
                           get_type=lambda: "HOME_POSITION",
                           get_srcSystem=lambda: 1, get_srcComponent=lambda: 1)
    b._on_mav(conn, ess)
    b._on_mav(conn, home)
    assert b.latest["landedState"] == "in_air"
    assert (b.latest["homeLat"], b.latest["homeLon"], b.latest["homeAlt"]) == \
        (37.4000521, -122.1501917, 865.5)
    assert {"landed", "home"} <= set(b._src_at)
    ess.landed_state = 0                                   # undefined is not a guess
    b._on_mav(conn, ess)
    assert b.latest["landedState"] is None
