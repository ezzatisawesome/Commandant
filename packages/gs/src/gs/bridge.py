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
import math
import os
import struct
import queue
import socket
import threading
import time
import traceback
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
# 1/1 is the PX4 default; gs locks onto the real ids from the first autopilot
# heartbeat it sees (see Bridge._vehicle) so a vehicle with MAV_SYS_ID != 1 works.
TARGET_SYSTEM = 1        # PX4 autopilot
TARGET_COMPONENT = 1
GCS_SYSTEM = 255         # our own MAVLink identity on the wire (QGC convention)
GCS_COMPONENT = 190      # MAV_COMP_ID_MISSIONPLANNER
CMD_MAX_TRIES = 3        # total COMMAND_LONG sends before giving up
CMD_RETRY_MS = 1000      # re-send cadence while awaiting COMMAND_ACK
CMD_IN_PROGRESS_MS = 15000  # after a MAV_RESULT_IN_PROGRESS, wait this long for the final ack

# Transport resilience: reopen the link after an open failure or a run of recv
# errors (serial unplugged, TCP peer gone) instead of letting the mav thread die.
LINK_REOPEN_MIN_S = 1.0
LINK_REOPEN_MAX_S = 10.0
LINK_RECV_ERRORS_BEFORE_REOPEN = 5

# Param sync (Phase 2). The PARAM protocol is hand-rolled on the mav thread.
PARAM_PROGRESS_EVERY = 25    # emit a param_progress at most this often (by count)
PARAM_GAP_QUIET_MS = 1500    # after the list stream goes quiet, re-request missing idx
PARAM_SET_TIMEOUT_MS = 2000  # await the echoed PARAM_VALUE after a PARAM_SET
PARAM_SET_MAX_TRIES = 3
PARAM_GAP_MAX_SWEEPS = 10    # give up a refresh after this many fruitless gap sweeps
PARAM_BATCH_MS = 50          # coalesce streamed PARAM_VALUEs into one WS `params` message
PARAM_BATCH_MAX = 64

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
        return mavutil.mavlink_connection(device, baud=rate, **_GCS_ID)
    # Bare device path (no udp/tcp scheme) -> serial too, at the fallback baud.
    if "://" not in endpoint and ":" not in endpoint.split("/")[-1] and (
            endpoint.startswith("/dev/") or endpoint.upper().startswith("COM")):
        return mavutil.mavlink_connection(endpoint, baud=baud, **_GCS_ID)
    return mavutil.mavlink_connection(endpoint, **_GCS_ID)


_GCS_ID = {"source_system": GCS_SYSTEM, "source_component": GCS_COMPONENT}

# POSITION_TARGET_GLOBAL_INT is only interpretable as lat/lon in these frames.
_GLOBAL_FRAMES = frozenset({
    mavutil.mavlink.MAV_FRAME_GLOBAL,                      # 0
    mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT,         # 3
    mavutil.mavlink.MAV_FRAME_GLOBAL_INT,                  # 5
    mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,     # 6
    mavutil.mavlink.MAV_FRAME_GLOBAL_TERRAIN_ALT,          # 10
    mavutil.mavlink.MAV_FRAME_GLOBAL_TERRAIN_ALT_INT,      # 11
})
# type_mask bits 0/1 = X/Y position IGNORE. Either set means there is no position
# setpoint in this message, whatever lat_int/lon_int happen to contain.
_POS_IGNORE_BITS = 0b11

# PX4 message ids not in the default GCS stream; we request them QGC-style.
MSG_ACTUATOR_OUTPUT_STATUS = mavutil.mavlink.MAVLINK_MSG_ID_ACTUATOR_OUTPUT_STATUS  # 375
MSG_POSITION_TARGET_GLOBAL_INT = mavutil.mavlink.MAVLINK_MSG_ID_POSITION_TARGET_GLOBAL_INT  # 87
MSG_WIND_COV = mavutil.mavlink.MAVLINK_MSG_ID_WIND_COV  # 231 — EKF wind estimate


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


# PX4 encodes integer params BYTE-WISE into PARAM_VALUE.param_value (the
# MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE convention): the int32's bytes are
# memcpy'd into the float field. pymavlink hands us that float, so an INT32 of 1
# arrives as 1.4e-45. Decode/encode through the bit pattern for integer types.
_INT_PTYPES = {
    mavutil.mavlink.MAV_PARAM_TYPE_UINT8, mavutil.mavlink.MAV_PARAM_TYPE_INT8,
    mavutil.mavlink.MAV_PARAM_TYPE_UINT16, mavutil.mavlink.MAV_PARAM_TYPE_INT16,
    mavutil.mavlink.MAV_PARAM_TYPE_UINT32, mavutil.mavlink.MAV_PARAM_TYPE_INT32,
}


def param_decode(wire: float, ptype: int) -> float:
    """Wire float -> logical value. Integer types come back as an int."""
    if ptype in _INT_PTYPES:
        try:
            return struct.unpack("<i", struct.pack("<f", wire))[0]
        except (struct.error, OverflowError):
            return wire
    return wire


def param_encode(value: float, ptype: int) -> float:
    """Logical value -> wire float for PARAM_SET."""
    if ptype in _INT_PTYPES:
        return struct.unpack("<f", struct.pack("<i", int(round(value))))[0]
    return float(value)


_RESULT_TEXT = {
    0: "accepted", 1: "temporarily rejected", 2: "denied",
    3: "unsupported", 4: "failed", 5: "in progress", 6: "cancelled",
}


def result_text(result: int) -> str:
    return _RESULT_TEXT.get(result, f"result {result}")


# --- Mission protocol (Phase 4) ----------------------------------------------
MAV_MISSION_TYPE_MISSION = mavutil.mavlink.MAV_MISSION_TYPE_MISSION
MAV_MISSION_TYPE_FENCE = mavutil.mavlink.MAV_MISSION_TYPE_FENCE
MAV_MISSION_TYPE_RALLY = mavutil.mavlink.MAV_MISSION_TYPE_RALLY
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
    # Geofence + rally (uploaded on the FENCE / RALLY mission_type planes).
    "fence_inclusion": mavutil.mavlink.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION,
    "fence_exclusion": mavutil.mavlink.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION,
    "fence_circle_inclusion": mavutil.mavlink.MAV_CMD_NAV_FENCE_CIRCLE_INCLUSION,
    "fence_circle_exclusion": mavutil.mavlink.MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION,
    "rally": mavutil.mavlink.MAV_CMD_NAV_RALLY_POINT,
}
_CMD_TO_KIND = {v: k for k, v in _KIND_TO_CMD.items()}

_FENCE_POLY_KINDS = ("fence_inclusion", "fence_exclusion")
_FENCE_CIRCLE_KINDS = ("fence_circle_inclusion", "fence_circle_exclusion")

# Maps a push/pull WS message type to its MAVLink mission plane: the mission_type
# on the wire, the download response message type, and the ack message type. One
# handshake serves all three planes (mission / fence / rally).
_PLAN_PLANES = {
    "mission_push": {"mtype": MAV_MISSION_TYPE_MISSION, "rtype": "mission", "ack_type": "mission_ack"},
    "mission_pull": {"mtype": MAV_MISSION_TYPE_MISSION, "rtype": "mission", "ack_type": "mission_ack"},
    "fence_push": {"mtype": MAV_MISSION_TYPE_FENCE, "rtype": "fence", "ack_type": "fence_ack"},
    "fence_pull": {"mtype": MAV_MISSION_TYPE_FENCE, "rtype": "fence", "ack_type": "fence_ack"},
    "rally_push": {"mtype": MAV_MISSION_TYPE_RALLY, "rtype": "rally", "ack_type": "rally_ack"},
    "rally_pull": {"mtype": MAV_MISSION_TYPE_RALLY, "rtype": "rally", "ack_type": "rally_ack"},
}

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
    if not isinstance(item, dict):
        raise ValueError("mission item must be an object")
    p = item.get("params") or {}
    if not isinstance(p, dict):
        raise ValueError("params must be an object")
    try:
        lat = float(item.get("lat") or 0.0)
        lon = float(item.get("lon") or 0.0)
        alt = float(item.get("alt") or 0.0)
    except (TypeError, ValueError):
        raise ValueError(f"item {seq}: lat/lon/alt must be numbers") from None
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
    elif kind in _FENCE_POLY_KINDS:
        p1 = float(p.get("vertexCount", 0) or 0)  # vertices in this inclusion/exclusion set
    elif kind in _FENCE_CIRCLE_KINDS:
        p1 = float(p.get("radius", 0) or 0)
    # Frame by item class: command-only items (RTL) carry no position and MUST use
    # MAV_FRAME_MISSION or PX4 NAKs the whole mission as UNSUPPORTED (live-SITL
    # finding); fence vertices/circles are lat/lon-only (no alt) -> MAV_FRAME_GLOBAL;
    # everything else positional -> global relative-alt.
    if kind == "rtl":
        frame = m.MAV_FRAME_MISSION
    elif kind in _FENCE_POLY_KINDS or kind in _FENCE_CIRCLE_KINDS:
        frame = m.MAV_FRAME_GLOBAL
    else:
        frame = m.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT
    return {
        "frame": frame, "command": cmd,
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
    if kind in _FENCE_POLY_KINDS and msg.param1:
        params["vertexCount"] = int(msg.param1)
    if kind in _FENCE_CIRCLE_KINDS and msg.param1:
        params["radius"] = msg.param1
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
    # Course over ground, straight from the FDM's inertial velocity. Far better
    # than differencing position fixes (that path is what fabricated 8.6 m/s of
    # wind out of GPS noise), so the console prefers it when present.
    "trackDeg",
    # The sim's TRUTH wind (NED m/s, direction the air moves toward). Sim-only —
    # it has no MAVLink carrier — and it exists so the console's own wind estimate
    # can be CHECKED against the field the aircraft was actually flown in.
    "windN", "windE", "windD",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_safe(obj: Any) -> Any:
    """Replace non-finite floats (NaN/inf) with None, recursively. Python's
    json.dumps happily emits `NaN`, which the browser's JSON.parse rejects --
    so a single NaN field (PX4 sends them, e.g. an unset setpoint altitude)
    would otherwise poison every telemetry frame from then on."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def dumps(obj: Any) -> str:
    """json.dumps that never emits NaN/Infinity. Fast path first; only the rare
    frame that actually carries a non-finite value pays for the sanitizing walk."""
    try:
        return json.dumps(obj, allow_nan=False)
    except ValueError:
        return json.dumps(_json_safe(obj), allow_nan=False)


class Bridge:
    def __init__(
        self,
        mavlink_endpoint: str = "udpin:0.0.0.0:14550",
        json_port: int = 14555,
        ws_host: str = "0.0.0.0",
        ws_port: int = 8790,
        baud: int = DEFAULT_SERIAL_BAUD,
        relay: Any = None,
    ) -> None:
        self.mavlink_endpoint = mavlink_endpoint
        self.json_port = json_port
        self.ws_host = ws_host
        self.ws_port = ws_port
        self.baud = baud
        # Optional outbound-only uplink to the public relay (see gs/relay.py).
        # It is handed every payload the local clients get; it rate-limits and
        # reconnects on its own, and nothing it does can block this daemon.
        self.relay = relay

        self._lock = threading.Lock()
        self.latest: dict[str, Any] = {"t": 0, "connected": False}
        # Link freshness is tracked PER SOURCE, deliberately.
        #
        # `last_mav_at` is the only thing that says the *vehicle* is alive, because
        # MAVLink is the flight link. `last_json_at` is the sim's supplementary
        # flightlink feed (power model, no PX4). Collapsing them into one timestamp
        # is how a live JSON feed reported `linkState:"alive"` for an hour while
        # PX4's MAVLink was dead and the console re-drew the same frozen position —
        # a GCS showing a stale aircraft as live, which is the worst failure it has.
        self.last_mav_at = 0
        self.last_json_at = 0

        # Source-arbitration / stream-health bookkeeping (mirrors the TS bridge).
        self._last_pos_boot_ms = -1
        self._json_target_at = 0
        self._json_battery_at = 0
        self._last_target_at = 0
        self._last_req_at: dict[int, int] = {}

        self._clients: set[Any] = set()

        # The vehicle we are talking to: (sysid, compid), locked from the first
        # autopilot heartbeat. Until then TX goes to the PX4 default 1/1. Messages
        # from any OTHER source (a second GCS, a companion) never touch `latest`.
        self._vehicle: tuple[int, int] | None = None

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
        self._param_gap_sweeps = 0
        self._param_batch: list[dict[str, Any]] = []   # mav-thread only
        self._param_batch_at = 0
        self._tasks: set[asyncio.Task[Any]] = set()    # keep ack-delivery tasks alive
        self.link_reopens = 0                          # diagnostics: transport reopen count
        self.handler_errors = 0                        # diagnostics: swallowed handler exceptions

        # --- mission path (Phase 4) ----------------------------------------
        # Upload/download handshakes run on the mav thread; `_mission` holds the
        # single active op (one at a time) and is mav-thread-owned.
        self._mission_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._mission: dict[str, Any] | None = None

    # --- MAVLink ingest ------------------------------------------------------
    def _open_with_retry(self) -> Any:
        """Open the transport, retrying with backoff. A serial device that is not
        plugged in yet, or a TCP peer that is not up, must not kill the daemon."""
        delay = LINK_REOPEN_MIN_S
        while True:
            try:
                conn = open_connection(self.mavlink_endpoint, self.baud)
                print(f"[gs] listening for MAVLink on {self.mavlink_endpoint}")
                return conn
            except Exception as exc:
                print(f"[gs] mavlink open failed ({exc}); retrying in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, LINK_REOPEN_MAX_S)

    def _mav_loop(self) -> None:
        conn = self._open_with_retry()
        errors = 0
        while True:
            try:
                msg = conn.recv_match(blocking=True, timeout=0.5)
                errors = 0
            except Exception as exc:  # malformed packet / transient socket error
                errors += 1
                print(f"[gs] mavlink recv error: {exc}")
                msg = None
                if errors >= LINK_RECV_ERRORS_BEFORE_REOPEN:
                    # The link itself is broken (unplugged radio, dead TCP peer):
                    # reopen rather than spin on a dead descriptor.
                    try:
                        conn.close()
                    except Exception:
                        pass
                    self.link_reopens += 1
                    time.sleep(LINK_REOPEN_MIN_S)
                    conn = self._open_with_retry()
                    errors = 0
                    continue
                time.sleep(0.05)  # bound the error rate; never busy-loop
            # A bug in any handler must never take the link down with it: log the
            # traceback and keep serving. (A dead mav thread looks exactly like a
            # dead radio from the console, which is the worst failure to debug.)
            try:
                if msg is not None:
                    self._on_mav(conn, msg)
                # Drain queued commands and drive retries/timeouts on THIS thread, so
                # all pymavlink sends share the one connection. recv's 0.5 s timeout
                # bounds the retry/timeout resolution even when there's no traffic.
                self._service_commands(conn)
                self._service_params(conn)
                self._service_misc(conn)
                self._service_missions(conn)
            except Exception:
                self.handler_errors += 1
                print(f"[gs] handler error (link kept alive):\n{traceback.format_exc()}")

    @property
    def tsys(self) -> int:
        return self._vehicle[0] if self._vehicle else TARGET_SYSTEM

    @property
    def tcomp(self) -> int:
        return self._vehicle[1] if self._vehicle else TARGET_COMPONENT

    def _send_command_long(self, conn: Any, mav_cmd: int, params: list[float], confirmation: int) -> None:
        conn.mav.command_long_send(
            self.tsys, self.tcomp, mav_cmd, confirmation, *params)

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
            if e.get("in_progress_ms"):
                # PX4 said IN_PROGRESS: stop resending, wait (bounded) for the final ack.
                if now - e["in_progress_ms"] > CMD_IN_PROGRESS_MS:
                    del self._pending[cid]
                    self._report(cid, ok=False, result=-1, text="timeout (in progress)")
                continue
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

    def _report(self, cid: str, ok: bool, result: int, text: str, final: bool = True) -> None:
        """Hand a command result to the asyncio loop for WS delivery. `final=False`
        is an interim (IN_PROGRESS) notice: the client keeps waiting for the real one."""
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(
                self._emit_ack, {"id": cid, "ok": ok, "result": result, "text": text, "final": final})

    # --- broadcast helper (mav thread -> all clients) ------------------------
    def _broadcast(self, obj: dict[str, Any]) -> None:
        """Fan a message to every client from the mav thread (schedules the actual
        send on the asyncio loop, which owns the websockets)."""
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(self._do_broadcast, dumps(obj), obj.get("type", "event"))

    def _do_broadcast(self, payload: str, kind: str = "event") -> None:
        if self._clients:
            websockets.broadcast(self._clients, payload)
        if self.relay is not None:
            self.relay.offer(payload, kind)

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
                try:
                    hz = float(item.get("hz") or 0)
                    msg_id = int(item["msgId"])
                except (TypeError, ValueError, KeyError):
                    print(f"[gs] ignoring malformed stream request: {item}")
                    continue
                interval_us = -1 if hz <= 0 else int(1e6 / hz)
                try:
                    conn.mav.command_long_send(
                        self.tsys, self.tcomp,
                        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
                        msg_id, interval_us, 0, 0, 0, 0, 0)
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
                if self._param_refresh_active:
                    continue  # two tabs clicking Refresh must not double the radio load
                self._start_param_refresh(conn)
            elif item["kind"] == "set":
                self._start_param_set(conn, item)

        # 2. Flush the coalesced PARAM_VALUE batch (time- or size-triggered).
        if self._param_batch and (now - self._param_batch_at >= PARAM_BATCH_MS
                                  or len(self._param_batch) >= PARAM_BATCH_MAX):
            self._flush_param_batch()

        # 3. During an active refresh, re-request any gaps once the stream goes quiet.
        if self._param_refresh_active:
            got = len(self._param_received)
            if self._param_count and got >= self._param_count:
                self._param_refresh_active = False
                if self._param_batch:
                    self._flush_param_batch()  # every value precedes the done marker
                self._broadcast({"type": "param_progress", "received": got,
                                 "count": self._param_count, "done": True})
            elif now - self._param_last_rx_ms > PARAM_GAP_QUIET_MS:
                self._param_gap_sweeps += 1
                if self._param_gap_sweeps > PARAM_GAP_MAX_SWEEPS:
                    # The vehicle stopped answering: fail loudly, don't poll forever.
                    self._param_refresh_active = False
                    if self._param_batch:
                        self._flush_param_batch()
                    self._broadcast({"type": "param_progress", "received": got,
                                     "count": self._param_count, "done": True,
                                     "error": "timeout"})
                elif self._param_count == 0:
                    # Never saw a single PARAM_VALUE: re-kick the whole list.
                    try:
                        conn.mav.param_request_list_send(self.tsys, self.tcomp)
                    except Exception:
                        pass
                    self._param_last_rx_ms = now
                else:
                    missing = [i for i in range(self._param_count) if i not in self._param_received]
                    for idx in missing[:20]:  # bounded per tick
                        try:
                            conn.mav.param_request_read_send(
                                self.tsys, self.tcomp, b"", idx)
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
        self._param_gap_sweeps = 0
        self._param_last_rx_ms = _now_ms()
        try:
            conn.mav.param_request_list_send(self.tsys, self.tcomp)
        except Exception as exc:
            print(f"[gs] param_request_list failed: {exc}")
            self._param_refresh_active = False

    def _flush_param_batch(self) -> None:
        batch, self._param_batch = self._param_batch, []
        self._broadcast({"type": "params", "items": batch})

    def _start_param_set(self, conn: Any, item: dict[str, Any]) -> None:
        job = {"id": item.get("id"), "name": str(item.get("name") or ""),
               "value": item.get("value"), "tries": 0, "last_send_ms": 0}
        try:
            job["value"] = float(item["value"])
            job["ptype"] = int(item.get("ptype") or mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
            if not job["name"] or len(job["name"]) > 16:
                raise ValueError("param name must be 1-16 chars")
            job["name"].encode("ascii")
        except (TypeError, ValueError, KeyError, UnicodeEncodeError) as exc:
            self._report_param_ack(job, ok=False, text=f"bad request: {exc}")
            return
        self._param_set_pending[job["name"]] = job
        self._send_param_set(conn, job)

    def _send_param_set(self, conn: Any, job: dict[str, Any]) -> None:
        try:
            conn.mav.param_set_send(
                self.tsys, self.tcomp,
                job["name"].encode("ascii"), param_encode(job["value"], job["ptype"]), job["ptype"])
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
                    conn.mav.mission_set_current_send(self.tsys, self.tcomp, int(job["seq"]))
                except Exception as exc:
                    print(f"[gs] mission_set_current failed: {exc}")
                continue
            if self._mission is not None:
                # One op at a time; reject the newcomer rather than interleave handshakes.
                ack_type = job.get("ack_type", "mission_ack")
                if kind == "push":
                    self._report_mission_ack(job.get("id"), ok=False, result=-1, text="busy", ack_type=ack_type)
                else:
                    self._broadcast({"type": ack_type, "ok": False, "result": -1, "text": "busy"})
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
                    self._report_mission_ack(op.get("id"), ok=False, result=-1, text="timeout",
                                             ack_type=op["ack_type"])
                else:
                    self._broadcast({"type": op["ack_type"], "ok": False, "result": -1, "text": "timeout"})
                self._mission = None
            else:
                op["tries"] += 1
                op["last"] = now
                try:
                    if op["op"] == "upload":
                        conn.mav.mission_count_send(
                            self.tsys, self.tcomp, op["count"], op["mtype"])
                    elif op["count"] is None:
                        conn.mav.mission_request_list_send(
                            self.tsys, self.tcomp, op["mtype"])
                    else:
                        conn.mav.mission_request_int_send(
                            self.tsys, self.tcomp, op["next"], op["mtype"])
                except Exception as exc:
                    print(f"[gs] mission retry failed: {exc}")

    def _start_mission_upload(self, conn: Any, job: dict[str, Any]) -> None:
        ack_type = job["ack_type"]
        try:
            items = job.get("items") or []
            if not isinstance(items, list):
                raise ValueError("items must be a list")
            fields = [mission_item_fields(i, it) for i, it in enumerate(items)]
        except (ValueError, TypeError, AttributeError) as exc:
            self._report_mission_ack(job.get("id"), ok=False, result=-1, text=str(exc), ack_type=ack_type)
            return
        self._mission = {"op": "upload", "id": job.get("id"), "items": fields,
                         "count": len(fields), "last": _now_ms(), "tries": 0,
                         "mtype": job["mtype"], "rtype": job["rtype"], "ack_type": ack_type}
        try:
            conn.mav.mission_count_send(
                self.tsys, self.tcomp, len(fields), job["mtype"])
        except Exception as exc:
            self._mission = None
            self._report_mission_ack(job.get("id"), ok=False, result=-1, text=f"send error: {exc}", ack_type=ack_type)

    def _start_mission_download(self, conn: Any, job: dict[str, Any]) -> None:
        self._mission = {"op": "download", "id": job.get("id"), "count": None,
                         "items": {}, "next": 0, "last": _now_ms(), "tries": 0,
                         "mtype": job["mtype"], "rtype": job["rtype"], "ack_type": job["ack_type"]}
        try:
            conn.mav.mission_request_list_send(
                self.tsys, self.tcomp, job["mtype"])
        except Exception as exc:
            self._mission = None
            self._broadcast({"type": job["ack_type"], "ok": False, "result": -1, "text": f"send error: {exc}"})

    def _mission_send_item(self, conn: Any, seq: int) -> None:
        f = self._mission["items"][seq]
        conn.mav.mission_item_int_send(
            self.tsys, self.tcomp, seq, f["frame"], f["command"],
            f["current"], f["autocontinue"], f["param1"], f["param2"], f["param3"],
            f["param4"], f["x"], f["y"], f["z"], self._mission["mtype"])

    def _report_mission_ack(self, mid: Any, ok: bool, result: int, text: str,
                            ack_type: str = "mission_ack") -> None:
        loop = self._loop
        if loop is not None:
            loop.call_soon_threadsafe(
                self._emit_mission_ack,
                {"id": mid, "ok": ok, "result": result, "text": text, "ack_type": ack_type})

    def _spawn(self, coro: Any) -> None:
        """create_task + keep a strong ref (otherwise a pending task can be GC'd)."""
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _emit_mission_ack(self, event: dict[str, Any]) -> None:
        self._spawn(self._deliver_mission_ack(event))

    async def _deliver_mission_ack(self, event: dict[str, Any]) -> None:
        mid = event.get("id")
        payload = {"type": event.get("ack_type", "mission_ack"), "id": mid, "ok": event["ok"],
                   "result": event["result"], "text": event["text"]}
        ws = self._pending_clients.pop(mid, None) if mid is not None else None
        if ws is not None:
            await self._send(ws, payload)
        else:
            self._do_broadcast(dumps(payload))

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
        if t == "BAD_DATA":
            return  # corrupted bytes are not "traffic" for link-health purposes
        now = _now_ms()
        src = (msg.get_srcSystem(), msg.get_srcComponent())
        if t == "HEARTBEAT":
            m = mavutil.mavlink
            if msg.type == m.MAV_TYPE_GCS or msg.autopilot == m.MAV_AUTOPILOT_INVALID:
                return  # another ground station / a non-autopilot: not our vehicle
            if self._vehicle is None:
                self._vehicle = src
                print(f"[gs] vehicle locked: sysid {src[0]} compid {src[1]}")
        if self._vehicle is not None and src != self._vehicle:
            return  # a companion / second autopilot: never let it overwrite our state
        with self._lock:
            self.last_mav_at = now
            L = self.latest

            if t == "GLOBAL_POSITION_INT":
                # Drop stale/reordered frames; a large backward jump is a reboot.
                boot = msg.time_boot_ms
                if boot <= self._last_pos_boot_ms and self._last_pos_boot_ms - boot < REBOOT_GAP_MS:
                    return
                self._last_pos_boot_ms = boot
                # PX4's own uptime clock, surfaced for diagnostics: when the
                # simulator stalls this is the value PX4's clock stops at, which
                # is what distinguishes a counter overflow from a race.
                L["bootMs"] = boot
                L["lat"] = msg.lat / 1e7
                L["lon"] = msg.lon / 1e7
                L["alt"] = msg.alt / 1000.0  # mm -> m (MSL)
                if msg.hdg != 65535:
                    L["heading"] = msg.hdg / 100.0

                # EKF velocity in NED, cm/s on the wire. These were being thrown
                # away, and the console was reconstructing a worse version of the
                # same information by differencing consecutive positions — a 1.3 m
                # baseline at 10 Hz against 1.5 m of GPS noise. This is the
                # estimator's own output, derived from Doppler rather than position
                # differences, so track and groundspeed below are exact rather than
                # noise-limited.
                vn, ve, vd = msg.vx / 100.0, msg.vy / 100.0, msg.vz / 100.0
                L["vn"], L["ve"], L["vd"] = vn, ve, vd
                # Course over ground, degrees true. atan2(east, north) is the
                # compass convention; the position-differencing version it replaces
                # needed a 30 m baseline and smoothing to be usable at all.
                L["trackDeg"] = (math.degrees(math.atan2(ve, vn)) + 360.0) % 360.0
                L["groundspeed"] = math.hypot(vn, ve)
                # Climb rate, positive up (NED down is positive).
                L["climb"] = -vd

            elif t == "ATTITUDE":
                L["roll"] = msg.roll
                L["pitch"] = msg.pitch
                L["yaw"] = msg.yaw

            elif t == "POSITION_TARGET_GLOBAL_INT":
                # Yield to flightlink's JSON setpoint when it's live (augment runs).
                if now - self._json_target_at < TARGET_SOURCE_TTL_MS:
                    return
                self._last_target_at = now  # stream alive; hold off re-requesting

                # Two checks that were missing, and whose absence put the commanded
                # path (orange) far away from the actual path (cyan) on the globe.
                #
                # 1. coordinate_frame. lat_int/lon_int are only degrees*1e7 for the
                #    GLOBAL frames. In MAV_FRAME_LOCAL_NED they are local metres, so
                #    dividing by 1e7 yields a point near null island — metres of
                #    offset become tens of degrees.
                # 2. type_mask. The mask declares which components are VALID. PX4
                #    frequently publishes a velocity or acceleration setpoint with the
                #    position bits set to IGNORE, in which case lat_int/lon_int carry
                #    nothing meaningful and plotting them draws a line to noise.
                #
                # When either check fails the setpoint is dropped AND cleared, so the
                # overlay disappears instead of freezing at a wrong position — the
                # same "stale data must not look live" rule as the link state.
                if (getattr(msg, "coordinate_frame", 0) not in _GLOBAL_FRAMES
                        or (msg.type_mask & _POS_IGNORE_BITS)):
                    L.pop("targetLat", None)
                    L.pop("targetLon", None)
                    L.pop("targetAlt", None)
                    return

                L["targetLat"] = msg.lat_int / 1e7
                L["targetLon"] = msg.lon_int / 1e7
                L["targetAlt"] = msg.alt

            elif t == "VFR_HUD":
                L["airspeed"] = msg.airspeed
                L["throttle"] = msg.throttle
                # Only fill groundspeed/climb if the EKF velocity has not already
                # (GLOBAL_POSITION_INT is the better source: same estimator, more
                # precision, and it gives the direction too).
                if "vn" not in L:
                    L["groundspeed"] = msg.groundspeed
                    L["climb"] = msg.climb
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

            elif t == "WIND_COV":
                # PX4's EKF2 estimates wind as part of its state, fusing airspeed
                # with GPS velocity and a sideslip model, and reports it with
                # variances. The console used to solve its own wind triangle from
                # position differences; this is the estimator's answer, which has
                # strictly more information (and an uncertainty, which a hand-rolled
                # triangle cannot produce).
                #
                # wind_x/y are NED components of the air's motion, i.e. the
                # direction it blows TOWARD. Aviation reports the direction it
                # blows FROM, so the bearing is the reciprocal.
                wx, wy = msg.wind_x, msg.wind_y
                speed = math.hypot(wx, wy)
                L["windSpeed"] = speed
                L["windFromDeg"] = (math.degrees(math.atan2(wy, wx)) + 180.0) % 360.0
                L["windDown"] = msg.wind_z
                # Horizontal variance (m/s)^2 -> a 1-sigma figure the UI can show,
                # so an unreliable estimate can say so instead of being believed.
                L["windSigma"] = math.sqrt(max(0.0, msg.var_horiz))

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
                # Coalesce into a `params` batch: a full PX4 list is ~1000 values in
                # under a second, and one WS message per value floods the browser.
                if not self._param_batch:
                    self._param_batch_at = now
                value = param_decode(msg.param_value, msg.param_type)
                self._param_batch.append({"name": name, "value": value,
                                          "ptype": msg.param_type, "index": idx, "count": count})
                if len(self._param_batch) >= PARAM_BATCH_MAX:
                    self._flush_param_batch()
                # Refresh bookkeeping (index 65535 = a reply to a targeted read/set).
                if self._param_refresh_active and 0 <= idx < 65535:
                    self._param_count = count
                    self._param_received.add(idx)
                    self._param_last_rx_ms = now
                    self._param_gap_sweeps = 0
                    got = len(self._param_received)
                    if got - self._param_last_progress >= PARAM_PROGRESS_EVERY or got >= count:
                        self._param_last_progress = got
                        self._broadcast({"type": "param_progress", "received": got, "count": count})
                # Resolve a pending set from its echo: a match is success; a
                # targeted reply (index 65535) carrying a DIFFERENT value is PX4
                # refusing/clamping the write -> fail now, don't wait for timeout.
                job = self._param_set_pending.get(name)
                if job is not None:
                    if abs(value - job["value"]) <= 1e-4:
                        del self._param_set_pending[name]
                        self._report_param_ack(job, ok=True, text="set")
                    elif idx == 65535 and job["tries"] > 0:
                        del self._param_set_pending[name]
                        self._report_param_ack(job, ok=False, text=f"rejected (vehicle kept {value})")

            elif t == "COMMAND_ACK":
                # Resolve the oldest pending command with this MAV command number.
                # (Commands are infrequent; typically one is in flight.)
                match_id = next(
                    (cid for cid, e in self._pending.items() if e["mav_cmd"] == msg.command),
                    None,
                )
                if match_id is not None:
                    if msg.result == mavutil.mavlink.MAV_RESULT_IN_PROGRESS:
                        # Not final: keep the entry, stop retrying, extend the wait, and
                        # tell the console so its own timeout re-arms instead of firing.
                        self._pending[match_id]["in_progress_ms"] = now
                        self._report(match_id, ok=True, result=msg.result,
                                     text=result_text(msg.result), final=False)
                    else:
                        del self._pending[match_id]
                        ok = (msg.result == mavutil.mavlink.MAV_RESULT_ACCEPTED)
                        self._report(match_id, ok=ok, result=msg.result, text=result_text(msg.result))

            elif t in ("MISSION_REQUEST_INT", "MISSION_REQUEST"):
                # Autopilot pulling items during our upload. Answer whatever seq it
                # asks for (handles out-of-order and re-requests transparently).
                op = self._mission
                if op is not None and op["op"] == "upload" and getattr(msg, "mission_type", 0) == op["mtype"]:
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
                if op is not None and op["op"] == "download" and getattr(msg, "mission_type", 0) == op["mtype"]:
                    op["count"] = msg.count
                    op["last"] = now
                    op["tries"] = 0
                    if msg.count == 0:
                        conn.mav.mission_ack_send(self.tsys, self.tcomp, 0, op["mtype"])
                        self._broadcast({"type": op["rtype"], "count": 0, "items": []})
                        self._mission = None
                    else:
                        op["next"] = 0
                        conn.mav.mission_request_int_send(
                            self.tsys, self.tcomp, 0, op["mtype"])

            elif t == "MISSION_ITEM_INT":
                op = self._mission
                if op is not None and op["op"] == "download" and getattr(msg, "mission_type", 0) == op["mtype"]:
                    op["items"][msg.seq] = mission_item_to_console(msg)
                    op["last"] = now
                    op["tries"] = 0
                    self._broadcast({"type": "mission_progress", "phase": "download",
                                     "seq": msg.seq, "count": op["count"]})
                    if len(op["items"]) >= op["count"]:
                        conn.mav.mission_ack_send(self.tsys, self.tcomp, 0, op["mtype"])
                        items = [op["items"][s] for s in sorted(op["items"])]
                        self._broadcast({"type": op["rtype"], "count": op["count"], "items": items})
                        self._mission = None
                    else:
                        missing = [s for s in range(op["count"]) if s not in op["items"]]
                        if missing:
                            op["next"] = missing[0]
                            conn.mav.mission_request_int_send(
                                self.tsys, self.tcomp, missing[0], op["mtype"])

            elif t == "MISSION_ACK":
                op = self._mission
                if op is not None and getattr(msg, "mission_type", 0) == op["mtype"]:
                    res = msg.type
                    if op["op"] == "upload":
                        self._report_mission_ack(op.get("id"), ok=(res == 0), result=res,
                                                 text=mission_result_text(res), ack_type=op["ack_type"])
                        self._mission = None
                    elif res != 0:
                        # PX4 NAKed our download (e.g. a transfer is busy elsewhere).
                        self._broadcast({"type": op["ack_type"], "ok": False, "result": res,
                                         "text": mission_result_text(res)})
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
                if L.get("windSpeed") is None:
                    # Not in PX4's default GCS stream; ask for it like QGC does.
                    self._request_message(conn, tsys, tcomp, MSG_WIND_COV)
                if now - self._last_target_at > TARGET_STALE_MS:
                    self._request_message(conn, tsys, tcomp, MSG_POSITION_TARGET_GLOBAL_INT)

    # --- JSON ingest (flightlink / no-PX4 path) ------------------------------
    def _json_loop(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", self.json_port))
        except OSError as exc:
            # The JSON feed is the sim's optional no-PX4 path. Losing it must not
            # look like a crash, and must not stop MAVLink telemetry.
            print(f"[gs] JSON telemetry disabled: cannot bind udp:{self.json_port} ({exc}). "
                  f"Another gs instance? Use --json-port to pick another.")
            return
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
                self.last_json_at = now
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
        """Freshness of the VEHICLE's data (see last_mav_at / last_json_at)."""
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
            await ws.send(dumps(obj))
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
            if not isinstance(cid, str) or not cid:
                await self._send(ws, {"type": "ack", "id": cid, "ok": False, "result": -1,
                                      "text": "command needs a string id"})
                return
            if ws is not self._commander:
                await self._send(ws, {"type": "ack", "id": cid, "ok": False, "result": -1, "text": "not commander"})
                return
            try:
                args = msg.get("args")
                mav_cmd, params = build_command(msg.get("name"), args if isinstance(args, dict) else {})
            except (ValueError, TypeError) as exc:
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

        elif mtype in ("mission_push", "fence_push", "rally_push"):
            # Upload a mission/fence/rally plan -> commander only (changes the plane).
            plane = _PLAN_PLANES[mtype]
            mid = msg.get("id")
            if ws is not self._commander:
                await self._send(ws, {"type": plane["ack_type"], "id": mid, "ok": False,
                                      "result": -1, "text": "not commander"})
                return
            if mid is not None:
                self._pending_clients[mid] = ws
            self._mission_queue.put({"kind": "push", "id": mid, "items": msg.get("items") or [],
                                     "mtype": plane["mtype"], "rtype": plane["rtype"],
                                     "ack_type": plane["ack_type"]})

        elif mtype in ("mission_pull", "fence_pull", "rally_pull"):
            # Read the current plan; open to any client (result broadcast to all).
            plane = _PLAN_PLANES[mtype]
            self._mission_queue.put({"kind": "pull", "mtype": plane["mtype"],
                                     "rtype": plane["rtype"], "ack_type": plane["ack_type"]})

        elif mtype == "mission_set_current":
            if ws is self._commander:
                self._mission_queue.put({"kind": "set_current", "seq": msg.get("seq", 0)})

    def _emit_ack(self, event: dict[str, Any]) -> None:
        # Runs in the asyncio loop (scheduled via call_soon_threadsafe).
        self._spawn(self._deliver_ack(event))

    async def _deliver_ack(self, event: dict[str, Any]) -> None:
        final = event.get("final", True)
        ws = (self._pending_clients.pop(event["id"], None) if final
              else self._pending_clients.get(event["id"]))
        if ws is None:
            return
        await self._send(ws, {
            "type": "ack", "id": event["id"],
            "ok": event["ok"], "result": event["result"], "text": event["text"],
            "final": final,
        })

    def _emit_param_ack(self, event: dict[str, Any]) -> None:
        # Runs in the asyncio loop (scheduled via call_soon_threadsafe).
        self._spawn(self._deliver_param_ack(event))

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
                    try:
                        await self._on_ws_message(ws, raw)
                    except Exception as exc:
                        # One malformed message must not close the socket (and with
                        # it, silently drop this client's command authority).
                        print(f"[gs] bad ws message ignored: {exc!r}")
                        await self._send(ws, {"type": "ack", "id": None, "ok": False,
                                              "result": -1, "text": f"bad message: {exc}"})
            except Exception:
                pass  # connection dropped; cleaned up below
            finally:
                self._clients.discard(ws)
                if self._commander is ws:
                    self._commander = None

        # Short ping cycle: a commander tab that vanishes without a FIN (WiFi drop)
        # releases authority in ~10 s instead of websockets' default 40 s.
        if self.relay is not None:
            self._spawn(self.relay.run())
        try:
            server_cm = websockets.serve(handler, self.ws_host, self.ws_port,
                                         ping_interval=5, ping_timeout=5)
            server = await server_cm.__aenter__()
        except OSError as exc:
            raise SystemExit(
                f"[gs] cannot serve on {self.ws_host}:{self.ws_port} ({exc}).\n"
                f"      Another gs is probably already running — stop it, or pass "
                f"--ws-port to run a second one."
            ) from None
        try:
            print(f"[gs] websocket serving on ws://{self.ws_host}:{self.ws_port}")
            interval = 1.0 / BROADCAST_HZ
            while True:
                await asyncio.sleep(interval)
                now = _now_ms()
                with self._lock:
                    mav_at, json_at = self.last_mav_at, self.last_json_at
                    frame = dict(self.latest)
                # A MAVLink vehicle, once seen, is the sole authority on link health:
                # the JSON feed must never keep the link green for a dead autopilot.
                # A pure flightlink run (no PX4) falls back to the JSON feed, which
                # is then genuinely the only source there is.
                last = mav_at if mav_at else json_at
                state = self._link_state(now, last)
                frame["type"] = "telemetry"
                frame["t"] = now
                frame["linkState"] = state
                frame["connected"] = (state == "alive")
                # How old the newest vehicle data actually is, so the UI can say
                # "frozen 42 s ago" instead of quietly showing a stale position.
                frame["dataAgeMs"] = (now - last) if last else None
                payload = dumps(frame)
                if self._clients:
                    websockets.broadcast(self._clients, payload)
                if self.relay is not None:
                    self.relay.offer(payload, "telemetry")
                if state != self._last_link_state:
                    link = dumps({"type": "link", "state": state, "lastMsgMs": last})
                    if self._clients:
                        websockets.broadcast(self._clients, link)
                    if self.relay is not None:
                        self.relay.offer(link, "link")
                # Track transitions even with no clients so the next connect is correct.
                self._last_link_state = state
        finally:
            await server_cm.__aexit__(None, None, None)

    def run(self) -> None:
        threading.Thread(target=self._mav_loop, daemon=True).start()
        threading.Thread(target=self._json_loop, daemon=True).start()
        asyncio.run(self._serve())
