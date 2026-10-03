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
STALE_MS = 2000          # no traffic for this long => "disconnected"
REBOOT_GAP_MS = 5000     # a backward time_boot_ms jump bigger than this = PX4 reboot
TARGET_SOURCE_TTL_MS = 2000   # JSON setpoint wins over PX4's for this long after it arrives
BATTERY_SOURCE_TTL_MS = 3000  # JSON battery wins over PX4's dummy for this long
TARGET_STALE_MS = 3000        # re-request msg 87 once the setpoint stream goes quiet

# PX4 message ids not in the default GCS stream; we request them QGC-style.
MSG_ACTUATOR_OUTPUT_STATUS = mavutil.mavlink.MAVLINK_MSG_ID_ACTUATOR_OUTPUT_STATUS  # 375
MSG_POSITION_TARGET_GLOBAL_INT = mavutil.mavlink.MAVLINK_MSG_ID_POSITION_TARGET_GLOBAL_INT  # 87

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

    # --- MAVLink ingest ------------------------------------------------------
    def _mav_loop(self) -> None:
        conn = mavutil.mavlink_connection(self.mavlink_endpoint)
        print(f"[gs] listening for MAVLink on {self.mavlink_endpoint}")
        while True:
            try:
                msg = conn.recv_match(blocking=True, timeout=1.0)
            except Exception as exc:  # malformed packet / transient socket error
                print(f"[gs] mavlink recv error: {exc}")
                continue
            if msg is None:
                continue
            self._on_mav(conn, msg)

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

    # --- WebSocket egress ----------------------------------------------------
    async def _serve(self) -> None:
        async def handler(ws: Any) -> None:
            self._clients.add(ws)
            try:
                await ws.wait_closed()
            finally:
                self._clients.discard(ws)

        async with websockets.serve(handler, self.ws_host, self.ws_port):
            print(f"[gs] websocket serving on ws://{self.ws_host}:{self.ws_port}")
            interval = 1.0 / BROADCAST_HZ
            while True:
                await asyncio.sleep(interval)
                now = _now_ms()
                with self._lock:
                    self.latest["t"] = now
                    self.latest["connected"] = (now - self.last_msg_at) < STALE_MS
                    payload = json.dumps(self.latest)
                if self._clients:
                    websockets.broadcast(self._clients, payload)

    def run(self) -> None:
        threading.Thread(target=self._mav_loop, daemon=True).start()
        threading.Thread(target=self._json_loop, daemon=True).start()
        asyncio.run(self._serve())
