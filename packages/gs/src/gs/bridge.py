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
    raise ValueError(f"unknown command '{name}'")


_RESULT_TEXT = {
    0: "accepted", 1: "temporarily rejected", 2: "denied",
    3: "unsupported", 4: "failed", 5: "in progress", 6: "cancelled",
}


def result_text(result: int) -> str:
    return _RESULT_TEXT.get(result, f"result {result}")

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
    ) -> None:
        self.mavlink_endpoint = mavlink_endpoint
        self.json_port = json_port
        self.ws_host = ws_host
        self.ws_port = ws_port

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

    # --- MAVLink ingest ------------------------------------------------------
    def _mav_loop(self) -> None:
        conn = mavutil.mavlink_connection(self.mavlink_endpoint)
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

            elif t == "HEARTBEAT":
                L["armed"] = bool(msg.base_mode & 128)  # MAV_MODE_FLAG_SAFETY_ARMED
                L["mode"] = decode_mode(msg.custom_mode)
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
