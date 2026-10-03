"""MAVLink + JSON -> WebSocket telemetry bridge (Phase 0).

Faithful Python/pymavlink port of the TypeScript bridge that previously ran
inside the Next server (console/src/lib/bridge/bridge.ts). Browsers can't open
raw UDP, so this attaches to PX4's GCS MAVLink stream (via mavlink-router) and
re-serves a decoded JSON telemetry frame over a WebSocket the Cesium UI reads.
It is blind to whether PX4 is driven by the sim or a real airframe -- that is
what makes "sim == real aircraft" hold.

    PX4 ──MAVLink/UDP──► [gs] ──JSON/WS:8790──► console (Cesium)
         flightlink JSON/UDP:14555 ─┘  (sim's no-PX4 path, merged into the frame)

The emitted frame shape is identical to the old bridge so the console needs no
change beyond no longer starting its own in-process bridge.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import socket
import threading
import time
from typing import Any

import websockets

# PX4 speaks MAVLink 2; ACTUATOR_OUTPUT_STATUS (375) and other v2-only messages
# are absent from pymavlink's default v1.0 dialect. Select v2.0 before importing.
os.environ.setdefault("MAVLINK20", "1")
from pymavlink import mavutil  # noqa: E402

BROADCAST_HZ = 25
STALE_MS = 2000          # no traffic for this long => link no longer "alive" (-> stale)
LOST_MS = 5000           # no traffic for this long => link "lost"
REBOOT_GAP_MS = 5000     # a backward time_boot_ms jump bigger than this = PX4 reboot
TARGET_SOURCE_TTL_MS = 2000   # JSON setpoint wins over PX4's for this long after it arrives
BATTERY_SOURCE_TTL_MS = 3000  # JSON battery wins over PX4's dummy for this long
TARGET_STALE_MS = 3000        # re-request msg 87 once the setpoint stream goes quiet

# Command TX: who we address, and the retry policy for COMMAND_ACK tracking.
TARGET_SYSTEM = 1        # PX4 autopilot
TARGET_COMPONENT = 1
CMD_MAX_TRIES = 3        # total COMMAND_LONG sends before giving up
CMD_RETRY_MS = 1000      # re-send cadence while awaiting COMMAND_ACK

# Param sync (Phase 2). The PARAM protocol is hand-rolled on the mav thread.
PARAM_PROGRESS_EVERY = 25    # emit a param_progress at most this often (by count)
PARAM_GAP_QUIET_MS = 1500    # after the list stream goes quiet, re-request missing idx
PARAM_SET_TIMEOUT_MS = 2000  # await the echoed PARAM_VALUE after a PARAM_SET
PARAM_SET_MAX_TRIES = 3

DEFAULT_SERIAL_BAUD = 57600  # typical SiK/telemetry-radio rate on the real hub

_NAN = float("nan")


def open_connection(endpoint: str, baud: int = DEFAULT_SERIAL_BAUD) -> Any:
    """Open a MAVLink link across any transport. udpin/udpout/udp/tcp pass
    straight to pymavlink; a `serial:<device>[:<baud>]` endpoint (or a bare device
    path) opens a serial port — this is the plane↔hub radio leg on the Raspberry
    Pi. One seam so the rest of the daemon is transport-agnostic."""
    if endpoint.startswith("serial:"):
        parts = endpoint.split(":")
        device = parts[1]
        rate = int(parts[2]) if len(parts) > 2 and parts[2] else baud
        return mavutil.mavlink_connection(device, baud=rate)
    # Bare device path (no udp/tcp scheme) -> serial too, at the fallback baud.
    if "://" not in endpoint and ":" not in endpoint.split("/")[-1] and (
            endpoint.startswith("/dev/") or endpoint.upper().startswith("COM")):
        return mavutil.mavlink_connection(endpoint, baud=baud)
    return mavutil.mavlink_connection(endpoint)

# PX4 message ids not in the default GCS stream; we request them QGC-style.
MSG_ACTUATOR_OUTPUT_STATUS = mavutil.mavlink.MAVLINK_MSG_ID_ACTUATOR_OUTPUT_STATUS  # 375
MSG_POSITION_TARGET_GLOBAL_INT = mavutil.mavlink.MAVLINK_MSG_ID_POSITION_TARGET_GLOBAL_INT  # 87


def build_command(name: str, args: dict[str, Any]) -> tuple[int, list[float]]:
    """Map a WS command (see docs/ws-contract.md) to a (MAV_CMD, 7 params) pair.
    Shapes mirror AircraftSim/src/px4/mavlink_io.py exactly."""
    m = mavutil.mavlink
    if name in ("arm", "disarm"):
        force = bool(args.get("force", False))
        p1 = 1.0 if name == "arm" else 0.0
        return m.MAV_CMD_COMPONENT_ARM_DISARM, [p1, 21196.0 if force else 0.0, 0, 0, 0, 0, 0]
    if name == "set_mode":
        main = int(args.get("main", 0))
        sub = int(args.get("sub", 0))
        return m.MAV_CMD_DO_SET_MODE, [float(m.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED), main, sub, 0, 0, 0, 0]
    if name == "takeoff":
        alt = float(args.get("alt", 30.0))
        # Mirrors mavlink_io.takeoff: p1..p6 = 0/NaN, p7 = target alt.
        return m.MAV_CMD_NAV_TAKEOFF, [0, 0, 0, _NAN, _NAN, _NAN, alt]
    if name == "land":
        return m.MAV_CMD_NAV_LAND, [0, 0, 0, _NAN, _NAN, _NAN, 0]
    if name == "rtl":
        return m.MAV_CMD_NAV_RETURN_TO_LAUNCH, [0, 0, 0, 0, 0, 0, 0]
    if name == "hold":
        # PX4 enters loiter via a mode switch, not NAV_LOITER_UNLIM as a verb.
        return m.MAV_CMD_DO_SET_MODE, [float(m.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED), 4, 3, 0, 0, 0, 0]
    if name == "reposition":
        # "Fly to here". On fixed-wing PX4 this is loiter-at-point, not a goto.
        # p1 ground speed (-1 = default), p2 flags (1 = switch to guided),
        # p5/6/7 = lat/lon (deg)/alt. COMMAND_LONG carries lat/lon as float deg.
        lat = float(args.get("lat", _NAN))
        lon = float(args.get("lon", _NAN))
        alt = float(args.get("alt", _NAN))
        return m.MAV_CMD_DO_REPOSITION, [-1, 1, 0, _NAN, lat, lon, alt]
    raise ValueError(f"unknown command '{name}'")


_RESULT_TEXT = {
    0: "accepted", 1: "temporarily rejected", 2: "denied",
    3: "unsupported", 4: "failed", 5: "in progress", 6: "cancelled",
}


def result_text(result: int) -> str:
    return _RESULT_TEXT.get(result, f"result {result}")


# --- Mission protocol (Phase 4) ----------------------------------------------
MAV_MISSION_TYPE_MISSION = mavutil.mavlink.MAV_MISSION_TYPE_MISSION
MISSION_OP_TIMEOUT_MS = 1500   # no handshake progress -> retry the kickoff
MISSION_MAX_TRIES = 3

_KIND_TO_CMD = {
    "takeoff": mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
    "waypoint": mavutil.mavlink.MAV_CMD_NAV_WAYPOINT,
    "loiter_unlim": mavutil.mavlink.MAV_CMD_NAV_LOITER_UNLIM,
    "loiter_time": mavutil.mavlink.MAV_CMD_NAV_LOITER_TIME,
    "loiter_turns": mavutil.mavlink.MAV_CMD_NAV_LOITER_TURNS,
    "rtl": mavutil.mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH,
    "land": mavutil.mavlink.MAV_CMD_NAV_LAND,
}
_CMD_TO_KIND = {v: k for k, v in _KIND_TO_CMD.items()}

_MISSION_RESULT_TEXT = {
    0: "accepted", 1: "error", 2: "unsupported frame", 3: "unsupported",
    4: "no space", 5: "invalid", 13: "invalid param", 14: "invalid sequence",
    15: "denied", 16: "cancelled",
}


def mission_result_text(result: int) -> str:
    return _MISSION_RESULT_TEXT.get(result, f"result {result}")


def mission_item_fields(seq: int, item: dict[str, Any]) -> dict[str, Any]:
    """Map a console mission item (see docs/ws-contract.md) to MISSION_ITEM_INT
    fields: lat/lon -> int*1e7, relative-alt frame (PX4 mission convention)."""
    m = mavutil.mavlink
    kind = item.get("kind", "waypoint")
    cmd = _KIND_TO_CMD.get(kind)
    if cmd is None:
        raise ValueError(f"unknown mission kind '{kind}'")
    p = item.get("params") or {}
    lat = item.get("lat") or 0.0
    lon = item.get("lon") or 0.0
    alt = float(item.get("alt") or 0.0)
    p1 = p2 = p3 = p4 = 0.0
    if kind == "waypoint":
        p2 = float(p.get("acceptRadius", p.get("radius", 0)) or 0)
    elif kind == "loiter_unlim":
        p3 = float(p.get("radius", 0) or 0)
    elif kind == "loiter_time":
        p1 = float(p.get("seconds", 0) or 0)
        p3 = float(p.get("radius", 0) or 0)
    elif kind == "loiter_turns":
        p1 = float(p.get("turns", 0) or 0)
        p3 = float(p.get("radius", 0) or 0)
    elif kind == "takeoff":
        p1 = float(p.get("pitch", 0) or 0)
    return {
        "frame": m.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, "command": cmd,
        "current": 1 if seq == 0 else 0, "autocontinue": 1,
        "param1": p1, "param2": p2, "param3": p3, "param4": p4,
        "x": int(round(lat * 1e7)), "y": int(round(lon * 1e7)), "z": alt,
    }


def mission_item_to_console(msg: Any) -> dict[str, Any]:
    """Reverse-map a downloaded MISSION_ITEM_INT to the console item shape."""
    kind = _CMD_TO_KIND.get(msg.command, f"cmd_{msg.command}")
    item: dict[str, Any] = {"seq": msg.seq, "kind": kind,
                            "lat": msg.x / 1e7, "lon": msg.y / 1e7, "alt": msg.z}
    params: dict[str, Any] = {}
    if kind == "waypoint" and msg.param2:
        params["acceptRadius"] = msg.param2
    if kind in ("loiter_unlim", "loiter_time", "loiter_turns") and msg.param3:
        params["radius"] = msg.param3
    if kind == "loiter_time" and msg.param1:
        params["seconds"] = msg.param1
    if kind == "loiter_turns" and msg.param1:
        params["turns"] = msg.param1
    if params:
        item["params"] = params
    return item

# --- PX4 flight-mode decode (custom_mode main/sub) ---------------------------
_MAIN = ["", "MANUAL", "ALTCTL", "POSCTL", "AUTO", "ACRO", "OFFBOARD", "STABILIZED", "RATTITUDE"]
_AUTO_SUB = ["", "READY", "TAKEOFF", "LOITER", "MISSION", "RTL", "LAND", "RTGS", "FOLLOW", "PRECLAND"]


def decode_mode(custom_mode: int) -> str:
    main = (custom_mode >> 16) & 0xFF
    sub = (custom_mode >> 24) & 0xFF
    main_name = _MAIN[main] if main < len(_MAIN) else f"MODE{main}"
    if main == 4:
        return f"AUTO.{_AUTO_SUB[sub] if sub < len(_AUTO_SUB) else sub}"
    return main_name


def pwm_pct(us: float) -> float:
    """Servo PWM pulse width (µs) -> deflection percent about 1500 µs neutral,
    ±500 µs full scale, clamped to ±100 %. Mirrors the sim's mavlink_io._norm."""
    return max(-100.0, min(100.0, ((us - 1500.0) / 500.0) * 100.0))


# Keys the flightlink JSON feed may set directly (already lat/lon-projected).
JSON_KEYS = {
    "lat", "lon", "alt", "roll", "pitch", "yaw", "airspeed", "groundspeed",
    "heading", "throttle", "elevator", "aileron", "rudder",
    "voltage", "current", "batteryRemaining", "armed", "mode",
    "genW", "loadW", "propW", "motorCurrent", "irradiance", "sunEpochMs",
    "targetLat", "targetLon", "targetAlt",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


class Bridge:
    def __init__(
        self,
        mavlink_endpoint: str = "udpin:0.0.0.0:14550",
        json_port: int = 14555,
        ws_host: str = "0.0.0.0",
        ws_port: int = 8790,
        baud: int = DEFAULT_SERIAL_BAUD,
    ) -> None:
        self.mavlink_endpoint = mavlink_endpoint
        self.json_port = json_port
        self.ws_host = ws_host
        self.ws_port = ws_port
        self.baud = baud

        self._lock = threading.Lock()
        self.latest: dict[str, Any] = {"t": 0, "connected": False}
        self.last_msg_at = 0

        # Source-arbitration / stream-health bookkeeping (mirrors the TS bridge).
        self._last_pos_boot_ms = -1
        self._json_target_at = 0
        self._json_battery_at = 0
        self._last_target_at = 0
        self._last_req_at: dict[int, int] = {}

        self._clients: set[Any] = set()

        # --- command path --------------------------------------------------
        # All pymavlink I/O happens on the mav thread. The WS (asyncio) thread
        # hands commands off through this thread-safe queue; the mav thread owns
        # `_pending` (the in-flight COMMAND_ACK registry) exclusively.
        self._cmd_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._pending: dict[str, dict[str, Any]] = {}      # mav-thread only
        self._pending_clients: dict[str, Any] = {}         # asyncio-only: id -> ws
        self._commander: Any = None                        # asyncio-only: single commander ws
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_link_state: str | None = None

        # --- param path (Phase 2) ------------------------------------------
        # Param requests (refresh/set) and fire-and-forget misc sends (stream
        # control) flow WS-thread -> mav-thread through these queues; all param
        # state below is mav-thread-owned.
        self._param_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._misc_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._param_count = 0               # expected total (from PARAM_VALUE.count)
        self._param_received: set[int] = set()
        self._param_refresh_active = False
        self._param_last_rx_ms = 0
        self._param_gap_requested = False
        self._param_last_progress = 0
        self._param_set_pending: dict[str, dict[str, Any]] = {}  # name -> set job

        # --- mission path (Phase 4) ----------------------------------------
        # Upload/download handshakes run on the mav thread; `_mission` holds the
        # single active op (one at a time) and is mav-thread-owned.
        self._mission_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._mission: dict[str, Any] | None = None

    # --- MAVLink ingest ------------------------------------------------------
    def _mav_loop(self) -> None:
        conn = open_connection(self.mavlink_endpoint, self.baud)
        print(f"[gs] listening for MAVLink on {self.mavlink_endpoint}")
        while True:
            try:
                msg = conn.recv_match(blocking=True, timeout=0.5)
            except Exception as exc:  # malformed packet / transient socket error
                print(f"[gs] mavlink recv error: {exc}")
                msg = None
            if msg is not None:
                self._on_mav(conn, msg)
            # Drain queued commands and drive retries/timeouts on THIS thread, so
            # all pymavlink sends share the one connection. recv's 0.5 s timeout
            # bounds the retry/timeout resolution even when there's no traffic.
            self._service_commands(conn)
            self._service_params(conn)
            self._service_misc(conn)
            self._service_missions(conn)

    def _send_command_long(self, conn: Any, mav_cmd: int, params: list[float], confirmation: int) -> None:
        conn.mav.command_long_send(
            TARGET_SYSTEM, TARGET_COMPONENT, mav_cmd, confirmation, *params)

    def _service_commands(self, conn: Any) -> None:
        """Mav-thread: accept newly queued commands, (re)send due ones, and time
        out those that never got a COMMAND_ACK. Never fire-and-forget."""
        now = _now_ms()
        # 1. Admit new commands from the WS thread.
        while True:
            try:
                item = self._cmd_queue.get_nowait()
            except queue.Empty:
                break
            self._pending[item["id"]] = {**item, "tries": 0, "last_send_ms": 0}
        # 2. Send / retry / expire.
        for cid, e in list(self._pending.items()):
            if now - e["last_send_ms"] < CMD_RETRY_MS:
                continue
            if e["tries"] >= CMD_MAX_TRIES:
                del self._pending[cid]
                self._report(cid, ok=False, result=-1, text="timeout")
                continue
            try:
                self._send_command_long(conn, e["mav_cmd"], e["params"], e["tries"])
            except Exception as exc:
                del self._pending[cid]
                self._report(cid, ok=False, result=-1, text=f"send error: {exc}")
                continue
            e["tries"] += 1
            e["last_send_ms"] = now

    def _report(self, cid: str, ok: bool, result: int, text: str) -> None:
        """Hand a resolved command result to the asyncio loop for WS delivery."""
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(
                self._emit_ack, {"id": cid, "ok": ok, "result": result, "text": text})

    # --- broadcast helper (mav thread -> all clients) ------------------------
    def _broadcast(self, obj: dict[str, Any]) -> None:
        """Fan a message to every client from the mav thread (schedules the actual
        send on the asyncio loop, which owns the websockets)."""
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(self._do_broadcast, json.dumps(obj))

    def _do_broadcast(self, payload: str) -> None:
        if self._clients:
            websockets.broadcast(self._clients, payload)

    def _report_param_ack(self, job: dict[str, Any], ok: bool, text: str) -> None:
        """Route a param_set result back to the originating client."""
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(self._emit_param_ack, {
                "id": job["id"], "name": job["name"], "value": job["value"],
                "ok": ok, "text": text,
            })

    # --- misc fire-and-forget sends (stream control) -------------------------
    def _service_misc(self, conn: Any) -> None:
        while True:
            try:
                item = self._misc_queue.get_nowait()
            except queue.Empty:
                break
            if item.get("kind") == "stream":
                hz = item.get("hz", 0)
                interval_us = -1 if hz is None or hz <= 0 else int(1e6 / hz)
                try:
                    conn.mav.command_long_send(
                        TARGET_SYSTEM, TARGET_COMPONENT,
                        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
                        item["msgId"], interval_us, 0, 0, 0, 0, 0)
                except Exception as exc:
                    print(f"[gs] stream request failed: {exc}")

    # --- param protocol (hand-rolled, mav thread) ----------------------------
    def _service_params(self, conn: Any) -> None:
        now = _now_ms()
        # 1. Admit new param jobs from the WS thread.
        while True:
            try:
                item = self._param_queue.get_nowait()
            except queue.Empty:
                break
            if item["kind"] == "refresh":
                self._start_param_refresh(conn)
            elif item["kind"] == "set":
                self._start_param_set(conn, item)

        # 2. During an active refresh, re-request any gaps once the stream goes quiet.
        if self._param_refresh_active and self._param_count:
            if len(self._param_received) >= self._param_count:
                self._param_refresh_active = False
            elif now - self._param_last_rx_ms > PARAM_GAP_QUIET_MS:
                missing = [i for i in range(self._param_count) if i not in self._param_received]
                for idx in missing[:20]:  # bounded per tick
                    try:
                        conn.mav.param_request_read_send(
                            TARGET_SYSTEM, TARGET_COMPONENT, b"", idx)
                    except Exception:
                        pass
                self._param_last_rx_ms = now  # back off before the next sweep

        # 3. Retry / time out pending param_sets awaiting their echoed PARAM_VALUE.
        for name, job in list(self._param_set_pending.items()):
            if now - job["last_send_ms"] < PARAM_SET_TIMEOUT_MS:
                continue
            if job["tries"] >= PARAM_SET_MAX_TRIES:
                del self._param_set_pending[name]
                self._report_param_ack(job, ok=False, text="timeout")
                continue
            self._send_param_set(conn, job)

    def _start_param_refresh(self, conn: Any) -> None:
        self._param_received.clear()
        self._param_count = 0
        self._param_refresh_active = True
        self._param_gap_requested = False
        self._param_last_progress = 0
        self._param_last_rx_ms = _now_ms()
        try:
            conn.mav.param_request_list_send(TARGET_SYSTEM, TARGET_COMPONENT)
        except Exception as exc:
            print(f"[gs] param_request_list failed: {exc}")
            self._param_refresh_active = False

    def _start_param_set(self, conn: Any, item: dict[str, Any]) -> None:
        job = {
            "id": item["id"], "name": item["name"], "value": float(item["value"]),
            "ptype": int(item.get("ptype", mavutil.mavlink.MAV_PARAM_TYPE_REAL32)),
            "tries": 0, "last_send_ms": 0,
        }
        self._param_set_pending[item["name"]] = job
        self._send_param_set(conn, job)

    def _send_param_set(self, conn: Any, job: dict[str, Any]) -> None:
        try:
            conn.mav.param_set_send(
                TARGET_SYSTEM, TARGET_COMPONENT,
                job["name"].encode("ascii"), job["value"], job["ptype"])
        except Exception as exc:
            name = job["name"]
            self._param_set_pending.pop(name, None)
            self._report_param_ack(job, ok=False, text=f"send error: {exc}")
            return
        job["tries"] += 1
        job["last_send_ms"] = _now_ms()

    # --- mission protocol (hand-rolled, mav thread) --------------------------
    def _service_missions(self, conn: Any) -> None:
        now = _now_ms()
        # 1. Admit queued mission jobs (one active op at a time).
        while True:
            try:
                job = self._mission_queue.get_nowait()
            except queue.Empty:
                break
            kind = job["kind"]
            if kind == "set_current":
                try:
                    conn.mav.mission_set_current_send(TARGET_SYSTEM, TARGET_COMPONENT, int(job["seq"]))
                except Exception as exc:
                    print(f"[gs] mission_set_current failed: {exc}")
                continue
            if self._mission is not None:
                # One op at a time; reject the newcomer rather than interleave handshakes.
                if kind == "push":
                    self._report_mission_ack(job.get("id"), ok=False, result=-1, text="busy")
                else:
                    self._broadcast({"type": "mission_ack", "ok": False, "result": -1, "text": "busy"})
                continue
            if kind == "push":
                self._start_mission_upload(conn, job)
            elif kind == "pull":
                self._start_mission_download(conn, job)

        # 2. Drive the active op's timeout / bounded retry (re-send the kickoff).
        op = self._mission
        if op is not None and now - op["last"] > MISSION_OP_TIMEOUT_MS:
            if op["tries"] >= MISSION_MAX_TRIES:
                if op["op"] == "upload":
                    self._report_mission_ack(op.get("id"), ok=False, result=-1, text="timeout")
                else:
                    self._broadcast({"type": "mission_ack", "ok": False, "result": -1, "text": "timeout"})
                self._mission = None
            else:
                op["tries"] += 1
                op["last"] = now
                try:
                    if op["op"] == "upload":
                        conn.mav.mission_count_send(
                            TARGET_SYSTEM, TARGET_COMPONENT, op["count"], MAV_MISSION_TYPE_MISSION)
                    elif op["count"] is None:
                        conn.mav.mission_request_list_send(
                            TARGET_SYSTEM, TARGET_COMPONENT, MAV_MISSION_TYPE_MISSION)
                    else:
                        conn.mav.mission_request_int_send(
                            TARGET_SYSTEM, TARGET_COMPONENT, op["next"], MAV_MISSION_TYPE_MISSION)
                except Exception as exc:
                    print(f"[gs] mission retry failed: {exc}")

    def _start_mission_upload(self, conn: Any, job: dict[str, Any]) -> None:
        try:
            fields = [mission_item_fields(i, it) for i, it in enumerate(job.get("items") or [])]
        except ValueError as exc:
            self._report_mission_ack(job.get("id"), ok=False, result=-1, text=str(exc))
            return
        self._mission = {"op": "upload", "id": job.get("id"), "items": fields,
                         "count": len(fields), "last": _now_ms(), "tries": 0}
        try:
            conn.mav.mission_count_send(
                TARGET_SYSTEM, TARGET_COMPONENT, len(fields), MAV_MISSION_TYPE_MISSION)
        except Exception as exc:
            self._mission = None
            self._report_mission_ack(job.get("id"), ok=False, result=-1, text=f"send error: {exc}")

    def _start_mission_download(self, conn: Any, job: dict[str, Any]) -> None:
        self._mission = {"op": "download", "id": job.get("id"), "count": None,
                         "items": {}, "next": 0, "last": _now_ms(), "tries": 0}
        try:
            conn.mav.mission_request_list_send(
                TARGET_SYSTEM, TARGET_COMPONENT, MAV_MISSION_TYPE_MISSION)
        except Exception as exc:
            self._mission = None
            self._broadcast({"type": "mission_ack", "ok": False, "result": -1, "text": f"send error: {exc}"})

    def _mission_send_item(self, conn: Any, seq: int) -> None:
        f = self._mission["items"][seq]
        conn.mav.mission_item_int_send(
            TARGET_SYSTEM, TARGET_COMPONENT, seq, f["frame"], f["command"],
            f["current"], f["autocontinue"], f["param1"], f["param2"], f["param3"],
            f["param4"], f["x"], f["y"], f["z"], MAV_MISSION_TYPE_MISSION)

    def _report_mission_ack(self, mid: Any, ok: bool, result: int, text: str) -> None:
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(
                self._emit_mission_ack, {"id": mid, "ok": ok, "result": result, "text": text})

    def _emit_mission_ack(self, event: dict[str, Any]) -> None:
        asyncio.create_task(self._deliver_mission_ack(event))

    async def _deliver_mission_ack(self, event: dict[str, Any]) -> None:
        mid = event.get("id")
        payload = {"type": "mission_ack", "id": mid, "ok": event["ok"],
                   "result": event["result"], "text": event["text"]}
        ws = self._pending_clients.pop(mid, None) if mid is not None else None
        if ws is not None:
            await self._send(ws, payload)
        else:
            self._do_broadcast(json.dumps(payload))

    def _request_message(self, conn: Any, tsys: int, tcomp: int, msg_id: int) -> None:
        now = _now_ms()
        if now - self._last_req_at.get(msg_id, 0) < 1000:  # throttle retries per msg
            return
        self._last_req_at[msg_id] = now
        conn.mav.command_long_send(
            tsys, tcomp,
            mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
            msg_id, 40000,  # interval µs -> 25 Hz
            0, 0, 0, 0, 0,
        )

    def _on_mav(self, conn: Any, msg: Any) -> None:
        t = msg.get_type()
        now = _now_ms()
        with self._lock:
            self.last_msg_at = now
            L = self.latest

            if t == "GLOBAL_POSITION_INT":
                # Drop stale/reordered frames; a large backward jump is a reboot.
                boot = msg.time_boot_ms
                if boot <= self._last_pos_boot_ms and self._last_pos_boot_ms - boot < REBOOT_GAP_MS:
                    return
                self._last_pos_boot_ms = boot
                L["lat"] = msg.lat / 1e7
                L["lon"] = msg.lon / 1e7
                L["alt"] = msg.alt / 1000.0  # mm -> m (MSL)
                if msg.hdg != 65535:
                    L["heading"] = msg.hdg / 100.0

            elif t == "ATTITUDE":
                L["roll"] = msg.roll
                L["pitch"] = msg.pitch
                L["yaw"] = msg.yaw

            elif t == "POSITION_TARGET_GLOBAL_INT":
                # Yield to flightlink's JSON setpoint when it's live (augment runs).
                if now - self._json_target_at < TARGET_SOURCE_TTL_MS:
                    return
                L["targetLat"] = msg.lat_int / 1e7
                L["targetLon"] = msg.lon_int / 1e7
                L["targetAlt"] = msg.alt
                self._last_target_at = now  # stream alive; hold off re-requesting

            elif t == "VFR_HUD":
                L["airspeed"] = msg.airspeed
                L["groundspeed"] = msg.groundspeed
                L["throttle"] = msg.throttle
                if L.get("heading") is None:
                    L["heading"] = msg.heading

            elif t == "BATTERY_STATUS":
                # Yield to the sim/HW battery when its JSON feed is fresh -- PX4's
                # SITL BATTERY_STATUS is a static dummy that would clobber it.
                if now - self._json_battery_at < BATTERY_SOURCE_TTL_MS:
                    return
                mv = [v for v in (msg.voltages or []) if v != 65535]
                if mv:
                    L["voltage"] = sum(mv) / 1000.0
                if msg.current_battery != -1:
                    L["current"] = msg.current_battery / 100.0  # cA -> A
                if msg.battery_remaining != -1:
                    L["batteryRemaining"] = msg.battery_remaining

            elif t == "ACTUATOR_OUTPUT_STATUS":
                # Post-mixer PWM (µs). idx5/6 = L/R aileron, idx7 = elevator; the
                # twin fins have no rudder output. Mirrors the sim's mavlink_io.
                a = msg.actuator
                if a and len(a) > 7:
                    L["aileron"] = 0.5 * (pwm_pct(a[6]) - pwm_pct(a[5]))
                    L["elevator"] = pwm_pct(a[7])
                    L["rudder"] = 0

            elif t == "SYS_STATUS":
                # All enabled sensors healthy? (bitwise: enabled ⊆ healthy.)
                en = msg.onboard_control_sensors_enabled
                hl = msg.onboard_control_sensors_health
                L["sysHealthy"] = (en & hl) == en
                rem = msg.battery_remaining
                L["batteryWarning"] = (
                    None if rem < 0 or rem >= 20 else ("critical" if rem < 10 else "low"))

            elif t == "GPS_RAW_INT":
                L["gpsFix"] = msg.fix_type
                L["gpsSats"] = msg.satellites_visible

            elif t == "EKF_STATUS_REPORT":
                # Healthy when attitude + horizontal velocity + absolute horizontal
                # position estimates are all valid.
                f = msg.flags
                m = mavutil.mavlink
                need = (m.ESTIMATOR_ATTITUDE | m.ESTIMATOR_VELOCITY_HORIZ
                        | m.ESTIMATOR_POS_HORIZ_ABS)
                L["ekfOk"] = (f & need) == need

            elif t == "STATUSTEXT":
                raw = msg.text
                text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
                self._broadcast({"type": "statustext", "severity": msg.severity,
                                 "text": text.rstrip("\x00").strip(), "t": now})

            elif t == "PARAM_VALUE":
                pid = msg.param_id
                name = pid.decode("ascii", "replace") if isinstance(pid, bytes) else str(pid)
                name = name.rstrip("\x00")
                idx, count = msg.param_index, msg.param_count
                # Stream the param to clients.
                self._broadcast({"type": "param", "name": name, "value": msg.param_value,
                                 "ptype": msg.param_type, "index": idx, "count": count})
                # Refresh bookkeeping (index 65535 = a reply to a targeted read/set).
                if self._param_refresh_active and 0 <= idx < 65535:
                    self._param_count = count
                    self._param_received.add(idx)
                    self._param_last_rx_ms = now
                    got = len(self._param_received)
                    if got - self._param_last_progress >= PARAM_PROGRESS_EVERY or got >= count:
                        self._param_last_progress = got
                        self._broadcast({"type": "param_progress", "received": got, "count": count})
                # Resolve a pending set when its echoed value matches.
                job = self._param_set_pending.get(name)
                if job is not None and abs(msg.param_value - job["value"]) <= 1e-4:
                    del self._param_set_pending[name]
                    self._report_param_ack(job, ok=True, text="set")

            elif t == "COMMAND_ACK":
                # Resolve the oldest pending command with this MAV command number.
                # (Commands are infrequent; typically one is in flight.)
                match_id = next(
                    (cid for cid, e in self._pending.items() if e["mav_cmd"] == msg.command),
                    None,
                )
                if match_id is not None:
                    del self._pending[match_id]
                    ok = (msg.result == mavutil.mavlink.MAV_RESULT_ACCEPTED)
                    self._report(match_id, ok=ok, result=msg.result, text=result_text(msg.result))

            elif t in ("MISSION_REQUEST_INT", "MISSION_REQUEST"):
                # Autopilot pulling items during our upload. Answer whatever seq it
                # asks for (handles out-of-order and re-requests transparently).
                op = self._mission
                if op is not None and op["op"] == "upload" and getattr(msg, "mission_type", 0) == 0:
                    seq = msg.seq
                    if 0 <= seq < len(op["items"]):
                        try:
                            self._mission_send_item(conn, seq)
                        except Exception as exc:
                            print(f"[gs] mission item send failed: {exc}")
                        op["last"] = now
                        op["tries"] = 0
                        self._broadcast({"type": "mission_progress", "phase": "upload",
                                         "seq": seq, "count": op["count"]})

            elif t == "MISSION_COUNT":
                op = self._mission
                if op is not None and op["op"] == "download" and getattr(msg, "mission_type", 0) == 0:
                    op["count"] = msg.count
                    op["last"] = now
                    op["tries"] = 0
                    if msg.count == 0:
                        conn.mav.mission_ack_send(TARGET_SYSTEM, TARGET_COMPONENT, 0, MAV_MISSION_TYPE_MISSION)
                        self._broadcast({"type": "mission", "count": 0, "items": []})
                        self._mission = None
                    else:
                        op["next"] = 0
                        conn.mav.mission_request_int_send(
                            TARGET_SYSTEM, TARGET_COMPONENT, 0, MAV_MISSION_TYPE_MISSION)

            elif t == "MISSION_ITEM_INT":
                op = self._mission
                if op is not None and op["op"] == "download" and getattr(msg, "mission_type", 0) == 0:
                    op["items"][msg.seq] = mission_item_to_console(msg)
                    op["last"] = now
                    op["tries"] = 0
                    self._broadcast({"type": "mission_progress", "phase": "download",
                                     "seq": msg.seq, "count": op["count"]})
                    if len(op["items"]) >= op["count"]:
                        conn.mav.mission_ack_send(TARGET_SYSTEM, TARGET_COMPONENT, 0, MAV_MISSION_TYPE_MISSION)
                        items = [op["items"][s] for s in sorted(op["items"])]
                        self._broadcast({"type": "mission", "count": op["count"], "items": items})
                        self._mission = None
                    else:
                        missing = [s for s in range(op["count"]) if s not in op["items"]]
                        if missing:
                            op["next"] = missing[0]
                            conn.mav.mission_request_int_send(
                                TARGET_SYSTEM, TARGET_COMPONENT, missing[0], MAV_MISSION_TYPE_MISSION)

            elif t == "MISSION_ACK":
                op = self._mission
                if op is not None and op["op"] == "upload" and getattr(msg, "mission_type", 0) == 0:
                    res = msg.type
                    self._report_mission_ack(op.get("id"), ok=(res == 0), result=res,
                                             text=mission_result_text(res))
                    self._mission = None

            elif t == "MISSION_CURRENT":
                self._broadcast({"type": "mission_current", "seq": msg.seq})

            elif t == "MISSION_ITEM_REACHED":
                self._broadcast({"type": "mission_reached", "seq": msg.seq})

            elif t == "HEARTBEAT":
                L["armed"] = bool(msg.base_mode & 128)  # MAV_MODE_FLAG_SAFETY_ARMED
                L["mode"] = decode_mode(msg.custom_mode)
                # PX4 raises system_status to CRITICAL/EMERGENCY in failsafe.
                m = mavutil.mavlink
                L["failsafe"] = msg.system_status in (m.MAV_STATE_CRITICAL, m.MAV_STATE_EMERGENCY)
                # PX4 omits ACTUATOR_OUTPUT_STATUS / POSITION_TARGET on the GCS link
                # by default; request them once we know PX4's address.
                tsys, tcomp = msg.get_srcSystem(), msg.get_srcComponent()
                if L.get("aileron") is None:
                    self._request_message(conn, tsys, tcomp, MSG_ACTUATOR_OUTPUT_STATUS)
                if now - self._last_target_at > TARGET_STALE_MS:
                    self._request_message(conn, tsys, tcomp, MSG_POSITION_TARGET_GLOBAL_INT)

    # --- JSON ingest (flightlink / no-PX4 path) ------------------------------
    def _json_loop(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", self.json_port))
        print(f"[gs] listening for JSON telemetry on udp:{self.json_port}")
        while True:
            try:
                data, _ = sock.recvfrom(65535)
                obj = json.loads(data.decode("utf-8"))
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            now = _now_ms()
            with self._lock:
                self.last_msg_at = now
                for k, v in obj.items():
                    if k in JSON_KEYS and v is not None:
                        self.latest[k] = v
                if obj.get("targetLat") is not None:
                    self._json_target_at = now
                    self._last_target_at = now
                if any(obj.get(k) is not None for k in ("voltage", "current", "batteryRemaining")):
                    self._json_battery_at = now

    # --- link state ----------------------------------------------------------
    def _link_state(self, now: int, last: int) -> str:
        if last == 0:
            return "connecting"
        age = now - last
        if age < STALE_MS:
            return "alive"
        if age < LOST_MS:
            return "stale"
        return "lost"

    # --- WebSocket (telemetry out, commands in) ------------------------------
    async def _send(self, ws: Any, obj: dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(obj))
        except Exception:
            pass  # client went away mid-send; broadcast loop / finally will clean up

    async def _on_ws_message(self, ws: Any, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        mtype = msg.get("type")

        if mtype == "claim":
            # First claimer wins until it disconnects; same ws re-claiming is fine.
            cid = msg.get("id")
            if self._commander is None or self._commander is ws:
                self._commander = ws
                if cid is not None:
                    await self._send(ws, {"type": "ack", "id": cid, "ok": True, "result": 0, "text": "commander"})
            elif cid is not None:
                await self._send(ws, {"type": "ack", "id": cid, "ok": False, "result": -1, "text": "not commander"})

        elif mtype == "command":
            cid = msg.get("id")
            if ws is not self._commander:
                await self._send(ws, {"type": "ack", "id": cid, "ok": False, "result": -1, "text": "not commander"})
                return
            try:
                mav_cmd, params = build_command(msg.get("name"), msg.get("args") or {})
            except ValueError as exc:
                await self._send(ws, {"type": "ack", "id": cid, "ok": False, "result": -1, "text": str(exc)})
                return
            # Route the eventual ack back to this client, then hand off to the mav thread.
            self._pending_clients[cid] = ws
            self._cmd_queue.put({"id": cid, "mav_cmd": mav_cmd, "params": params})

        elif mtype == "param_refresh":
            # Read-only; any client may request the param set.
            self._param_queue.put({"kind": "refresh"})

        elif mtype == "param_set":
            # A write -> commander only, like a command.
            cid = msg.get("id")
            if ws is not self._commander:
                await self._send(ws, {"type": "param_ack", "id": cid, "name": msg.get("name"),
                                      "value": msg.get("value"), "ok": False, "text": "not commander"})
                return
            self._pending_clients[cid] = ws
            self._param_queue.put({"kind": "set", "id": cid, "name": msg.get("name"),
                                   "value": msg.get("value"), "ptype": msg.get("ptype")})

        elif mtype == "stream":
            # Display preference (SET_MESSAGE_INTERVAL); open to any client.
            self._misc_queue.put({"kind": "stream", "msgId": msg.get("msgId"), "hz": msg.get("hz", 0)})

        elif mtype == "mission_push":
            # Upload a mission -> commander only (it changes what the plane flies).
            mid = msg.get("id")
            if ws is not self._commander:
                await self._send(ws, {"type": "mission_ack", "id": mid, "ok": False,
                                      "result": -1, "text": "not commander"})
                return
            if mid is not None:
                self._pending_clients[mid] = ws
            self._mission_queue.put({"kind": "push", "id": mid, "items": msg.get("items") or []})

        elif mtype == "mission_pull":
            # Read the current mission; open to any client (result broadcast to all).
            self._mission_queue.put({"kind": "pull"})

        elif mtype == "mission_set_current":
            if ws is self._commander:
                self._mission_queue.put({"kind": "set_current", "seq": msg.get("seq", 0)})

    def _emit_ack(self, event: dict[str, Any]) -> None:
        # Runs in the asyncio loop (scheduled via call_soon_threadsafe).
        asyncio.create_task(self._deliver_ack(event))

    async def _deliver_ack(self, event: dict[str, Any]) -> None:
        ws = self._pending_clients.pop(event["id"], None)
        if ws is None:
            return
        await self._send(ws, {
            "type": "ack", "id": event["id"],
            "ok": event["ok"], "result": event["result"], "text": event["text"],
        })

    def _emit_param_ack(self, event: dict[str, Any]) -> None:
        # Runs in the asyncio loop (scheduled via call_soon_threadsafe).
        asyncio.create_task(self._deliver_param_ack(event))

    async def _deliver_param_ack(self, event: dict[str, Any]) -> None:
        ws = self._pending_clients.pop(event["id"], None)
        if ws is None:
            return
        await self._send(ws, {
            "type": "param_ack", "id": event["id"], "name": event["name"],
            "value": event["value"], "ok": event["ok"], "text": event["text"],
        })

    async def _serve(self) -> None:
        self._loop = asyncio.get_running_loop()

        async def handler(ws: Any) -> None:
            self._clients.add(ws)
            try:
                async for raw in ws:
                    await self._on_ws_message(ws, raw)
            except Exception:
                pass  # connection dropped; cleaned up below
            finally:
                self._clients.discard(ws)
                if self._commander is ws:
                    self._commander = None

        async with websockets.serve(handler, self.ws_host, self.ws_port):
            print(f"[gs] websocket serving on ws://{self.ws_host}:{self.ws_port}")
            interval = 1.0 / BROADCAST_HZ
            while True:
                await asyncio.sleep(interval)
                now = _now_ms()
                with self._lock:
                    last = self.last_msg_at
                    frame = dict(self.latest)
                state = self._link_state(now, last)
                frame["type"] = "telemetry"
                frame["t"] = now
                frame["linkState"] = state
                frame["connected"] = (state == "alive")
                if self._clients:
                    websockets.broadcast(self._clients, json.dumps(frame))
                    if state != self._last_link_state:
                        websockets.broadcast(self._clients, json.dumps(
                            {"type": "link", "state": state, "lastMsgMs": last}))
                # Track transitions even with no clients so the next connect is correct.
                self._last_link_state = state

    def run(self) -> None:
        threading.Thread(target=self._mav_loop, daemon=True).start()
        threading.Thread(target=self._json_loop, daemon=True).start()
        asyncio.run(self._serve())
