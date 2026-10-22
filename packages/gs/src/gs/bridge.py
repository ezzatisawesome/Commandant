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
import glob
import json
import math
import os
import queue
import secrets
import socket
import struct
import threading
import time
import traceback
from typing import Any

import websockets

# PX4 speaks MAVLink 2; ACTUATOR_OUTPUT_STATUS (375), WIND_COV (231) and other
# v2-only messages are absent from pymavlink's default v1.0 dialect.
#
# Setting MAVLINK20 only works if nothing has imported mavutil yet, because
# mavutil binds `mavutil.mavlink` to a dialect module at ITS import time. Any
# consumer that imports pymavlink before gs -- the rehearsal gateway pulling in
# AircraftSim, a test module, an interactive session -- silently leaves us on
# the v1 dialect, and then every v2-only message vanishes: the actuator PWMs,
# the EKF wind estimate. Nothing errors; the fields are simply never populated,
# which is the hardest kind of failure to attribute. So: set the flag, then
# rebind the dialect explicitly, which is order-independent.
os.environ.setdefault("MAVLINK20", "1")
from pymavlink import mavutil  # noqa: E402

from .flightlog import FlightLog
from . import __version__  # noqa: E402

if not hasattr(mavutil.mavlink, "MAVLINK_MSG_ID_ACTUATOR_OUTPUT_STATUS"):
    mavutil.set_dialect(os.environ.get("MAVLINK_DIALECT", "all"))

BROADCAST_HZ = 25
STALE_MS = 2000          # no traffic for this long => link no longer "alive" (-> stale)
LOST_MS = 5000           # no traffic for this long => link "lost"
REBOOT_GAP_MS = 5000     # a backward time_boot_ms jump bigger than this = PX4 reboot
# time_boot_ms is uint32 MILLISECONDS, so the vehicle's uptime counter wraps at
# 49.7 days. For a solar aircraft meant to stay up for days to weeks that is a
# flight event, not a theoretical one -- and at the wrap the counter jumps from
# ~2^32 to near zero, which is indistinguishable from a reboot unless the
# previous value is taken into account. Calling it a reboot would abandon every
# in-flight handshake and tell the console to throw away its param cache, with a
# warning saying the aircraft restarted, 49.7 days into a healthy flight.
BOOT_MS_WRAP = 2 ** 32
BOOT_WRAP_MARGIN_MS = 60_000   # "near" either end of the counter
# A backward uptime jump is either a REORDERED frame or a REBOOT, and the old
# rule -- "a gap of at least REBOOT_GAP_MS is a reboot, anything smaller is a
# reorder" -- gets it wrong whenever the vehicle reboots within 5 s of its last
# report. MEASURED: up 1.6 s and restarting at 0.2 s gives a 1.4 s gap, so every
# post-reboot frame is dropped as reordered, `_last_pos_boot_ms` never advances,
# and the position freezes PERMANENTLY while heartbeats keep linkState green --
# the stale-aircraft-shown-as-live failure again. It takes a bench power-cycle or
# a HITL restart to hit, which is to say it happens constantly.
#
# Below REBOOT_GAP_MS the two are told apart by two further signals, because one
# frame is not enough to decide:
#   * a reorder moves the clock back by a fraction of the uptime (frames in
#     flight), while a reboot takes it back to near zero -- so a candidate must
#     have lost more than half of it;
#   * a reorder is a blip in an otherwise ascending stream, while after a reboot
#     the stream ASCENDS FROM THE NEW LOW VALUE. So a candidate is dropped and
#     remembered, and confirmed only when the next frame continues from it.
BOOT_REBOOT_RATIO = 2          # candidate must be < last/2 to be a reboot at all
# ...and the vehicle must have been up at least this long for a backward jump to
# be a reboot candidate at all.
#
# Without this the discriminator is far too permissive in the first seconds of a
# vehicle's life, because every test it applies is trivially satisfied there:
# 200 ms against 600 ms "loses more than half the uptime", and any later frame
# "ascends from the suspect". So ordinary jitter -- two interleaved clocks, or
# UDP frames arriving out of order on loopback -- reads as a reboot. MEASURED in
# the browser end-to-end test: reboots declared at uptimes 200, 400 and 600 ms,
# immediately after the vehicle locked, which then tripped the shared-sysid storm
# warning and left the console believing it did not know the vehicle's mission.
#
# Below the floor the frame is simply dropped as a reorder, which costs nothing:
# a vehicle that really did restart two seconds in has nothing worth
# invalidating yet, and `_last_pos_boot_ms` catches up on the next frame either
# way.
BOOT_REBOOT_MIN_UPTIME_MS = 5_000
# A vehicle cannot reboot repeatedly in a few seconds, so a RUN of reboot
# conclusions is not a vehicle rebooting -- it is TWO SOURCES sharing a sysid,
# each with its own uptime clock, and gs reading the alternation as a clock that
# keeps restarting. MEASURED: two stand-ins at sysid 1 with both clocks
# ascending produced 40 `vehicle_reboot` events from 80 frames and zero genuine
# reboots. Each one aborts every in-flight command, param set and mission
# handshake and tells the console to discard its parameter table, so at that rate
# nothing completes and the console is unusable.
#
# This happens for real: two flight controllers at the factory MAV_SYS_ID on one
# bench, or mavlink-router merging two streams. It is a misconfiguration gs
# cannot fix, and therefore one it has to NAME -- an operator can act on "two
# vehicles are claiming sysid 1", and cannot act on a console that keeps
# clearing itself.
POS_PEERS_MAX = 16       # distinct senders remembered for the storm report
REBOOT_STORM_WINDOW_MS = 10_000
REBOOT_STORM_MAX = 3
# How long a MAVLink setpoint keeps ownership of the commanded-path overlay after
# it last arrived. Within this window the sim's JSON target is ignored.
#
# This priority used to be the other way round, and it put the orange commanded
# path 2310 m from the aircraft — measured, holding a CONSTANT offset while the
# aircraft flew 302 m, which is the signature of two different origins rather
# than of a distant destination.
#
# The cause is that in augment mode the sim projects the setpoint about ITS OWN
# home (AircraftSim systems/flightlink.py: home_lat + target_n_m/R), while the
# position on screen comes from PX4's estimator about PX4's origin. When the two
# origins disagree the setpoint tracks the aircraft with a fixed bias, so the
# overlay is wrong in a way that looks plausible and never converges.
#
# It is the same lesson this project already learned from wind, where the JSON
# feed and PX4's EKF2 disagreed by 6 m/s and the console was right to read only
# PX4: for anything describing what the AIRCRAFT is doing, the autopilot is the
# authority and the sim's JSON is the scenario model's intent. JSON remains the
# only source on a flightdyn-only run, where there is no PX4 at all, so it stays
# as the fallback rather than being dropped.
TARGET_SOURCE_TTL_MS = 2000
BATTERY_SOURCE_TTL_MS = 3000  # JSON battery wins over PX4's dummy for this long
TARGET_STALE_MS = 3000        # re-request msg 87 once the setpoint stream goes quiet

# `dataAgeMs` says how old the newest VEHICLE data is, which is the right answer
# for "is the aircraft still talking". It is not the right answer for "is this
# number still true", because the fields in a frame come from different messages
# arriving at different rates -- and three of them are messages gs had to ASK
# for, which a rebooted or reconfigured autopilot simply stops sending.
#
# When a stream stops, its last value stays in `latest` and is re-broadcast in
# every frame from then on, indistinguishable from a live reading. So an airspeed
# sensor failure takes EKF2's wind estimate with it and the operator keeps being
# shown the last wind the aircraft ever saw, as the current wind, indefinitely.
# For an aircraft whose whole job is staying up on wind and sun, that is the
# worst reading on the panel to be quietly wrong.
#
# So each message group carries its own age. The groups are by MESSAGE, because
# that is what actually stops: fields that arrive together go stale together.
_AGE_GROUPS = {
    "GLOBAL_POSITION_INT": "position",
    "ATTITUDE": "attitude",
    "VFR_HUD": "airdata",
    "WIND_COV": "wind",
    "GPS_RAW_INT": "gps",
    "BATTERY_STATUS": "battery",
    "ACTUATOR_OUTPUT_STATUS": "actuators",
    "SYS_STATUS": "health",
    "EKF_STATUS_REPORT": "ekf",
    "ESTIMATOR_STATUS": "ekf",      # PX4's name for the same report
}

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

# A full PX4 param set is ~1000 values. PARAM_REQUEST_LIST makes the autopilot
# send all of them as fast as the link will carry, which on localhost is free
# and on a radio is the whole link for ten seconds. MEASURED on a 3.4 kB/s /
# 120 ms SiK link with a 400-param set: an `arm` issued one second into a
# refresh took 3.02 s and came back ok=False -- it exhausted
# CMD_MAX_TRIES x CMD_RETRY_MS and reported `timeout` while the link was
# perfectly healthy. On localhost UDP the same sequence acks in 0.09 s, which is
# why this never showed: the contention is invisible at 1 MB/s.
#
# So on a narrow link gs does not ask for the flood. It walks the indices with
# PARAM_REQUEST_READ at a rate it chooses, leaving the rest of the link for
# flight. For 1000 params on that radio the trade is 10.7 s using 100 % of the
# link (and commands failing) against 35.7 s using 30 % (and commands working),
# which for a ground station is not a close call.
PARAM_PACED_BELOW_BPS = 20_000
# How long a client that is NOT the commander must wait between full parameter
# walks. A walk costs ~10 s of 30% of a 57600 link, which is fine occasionally
# and is a standing tax if anyone may re-trigger it on completion. The commander
# is exempt: after a vehicle reboot every parameter is stale and re-reading at
# once is the right thing to do.
PARAM_REFRESH_COOLDOWN_MS = 60_000
# STATUSTEXT carries 50 characters; longer messages arrive as several chunks
# sharing an `id` and numbered by `chunk_seq`. See _on_statustext.
STATUSTEXT_CHUNK = 50
# A run is flushed once it goes quiet, so a lost final chunk delays a message
# instead of losing it. PX4 emits a run back-to-back, so this is generous.
STATUSTEXT_RUN_TIMEOUT_MS = 2_000
# A sender that never terminates a run must not grow memory. 20 chunks is 1000
# characters, far past anything PX4 sends.
STATUSTEXT_MAX_CHUNKS = 20
# Re-asking for a stream that never comes: start at a second, double, stop at a
# minute. See _request_message for what this costs on a radio when it does not
# back off at all.
STREAM_REQ_MIN_MS = 1_000
STREAM_REQ_MAX_MS = 60_000
# A requested stream that has not arrived for this long is asked for again
# (subject to the backoff above). Long enough that a 1 Hz stream is not nagged,
# short enough that a rebooted vehicle is back within a few heartbeats.
STREAM_STALE_MS = 5_000
# Parameter TYPES remembered from PARAM_VALUE, so a write cannot be dropped for
# a type mismatch. PX4 has ~720; the cap is for a vehicle that invents names.
PARAM_TYPES_MAX = 4_000   # narrower than this => pace, don't flood
PARAM_LINK_SHARE = 0.30          # of the link a paced refresh may use
PARAM_READ_BURST = 8             # max reads issued in one service tick
PARAM_READ_RETRY_MS = 3000       # re-request an index that never answered
PARAM_PACED_STALL_MS = 15000     # no new value for this long => give up

DEFAULT_SERIAL_BAUD = 57600  # typical SiK/telemetry-radio rate on the real hub

# --- GCS heartbeat (H1) -----------------------------------------------------
# PX4 decides whether a ground station is connected by RECEIVING heartbeats from
# one: MavlinkReceiver::handle_message_heartbeat sets telemetry_status
# .heartbeat_type_gcs, and commander's data_link_check() watches it. A GCS that
# only listens is, to PX4, a GCS that was never there.
#
# What follows from that, checked against the PX4 parameter metadata this repo
# already bundles (console/public/px4-params.json) rather than assumed:
#   COM_DL_LOSS_T  default 10   -- the threshold exists precisely for this
#   NAV_DLL_ACT    default 0    -- "Disabled"
# So on a STOCK airframe the consequence is the commander reporting the data
# link lost while the operator sits there watching telemetry flow: wrong, and
# visible, but not an automatic failsafe. Set NAV_DLL_ACT to any of its other
# values (Hold / Return / Land / Terminate) -- which is a configuration a BVLOS
# operator may well choose -- and the failsafe does run, on a healthy link.
#
# Either way a GCS that never heartbeats is lying to the autopilot about its own
# presence, and every real one (QGC, MAVProxy, MP) emits 1 Hz. So do we.
GCS_HEARTBEAT_MS = 1000

# --- Link budget (H2) -------------------------------------------------------
# On top of PX4's own GCS stream, gs asks for three messages PX4 does not send
# by default. The rate used to be a hardcoded 25 Hz, which is free on localhost
# UDP and ruinous on a radio: MEASURED, those three requests alone come to
# 6675 B/s, i.e. 133 % of a 57600 SiK link's usable goodput, before PX4's own
# ~1.2 kB/s stream. The link saturates and the radio drops frames -- and what
# gets dropped is COMMAND_LONG and STATUSTEXT, the two things a GCS exists for.
# So the rate is derived from what the transport can actually carry.
SERIAL_GOODPUT_FRACTION = 0.6   # of baud/10: SiK's share after framing/ECC/duty
NET_BUDGET_BPS = 1_000_000.0    # UDP/TCP (SITL, HITL, hub WiFi): effectively free
EXTRA_STREAM_SHARE = 0.25       # of the link gs may spend on its own extra streams
MAVLINK2_OVERHEAD = 12          # bytes of framing per message
REQUEST_HZ_MAX = 25.0
REQUEST_HZ_MIN = 1.0

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


# --- Transport autodetect ("plug and play") ---------------------------------
# The premise of this daemon is that it cannot tell, and must not care, whether
# the MAVLink on the other end is PX4 SITL, a HITL rig, or the aircraft on the
# bench -- that is what makes "sim == real aircraft" hold. The one place the
# distinction leaked out was configuration: the operator had to know which
# endpoint string to pass, and get the baud right, before anything worked. So
# `--mavlink auto` probes the transports an autopilot actually shows up on, in
# order of specificity, and picks the first one that produces a heartbeat from
# something claiming to be an autopilot.
#
# Ordering matters: a physically attached autopilot is a stronger signal of
# intent than a UDP port that might just have a stale SITL still running, so
# serial is probed first. The baud list per device class is what PX4 actually
# ships: USB CDC-ACM ignores the baud entirely, telemetry radios are 57600.
AUTODETECT = "auto"
SERIAL_CANDIDATES = (
    # PX4 over USB: the flight controller itself, on the bench or in HITL.
    # The baud here is a formality -- CDC-ACM ignores it (see _is_usb_cdc) --
    # but pymavlink wants a number.
    ("/dev/tty.usbmodem*", 115200),
    ("/dev/ttyACM*", 115200),
    # A telemetry radio: the hub's link to an airborne aircraft.
    ("/dev/tty.usbserial*", DEFAULT_SERIAL_BAUD),
    ("/dev/ttyUSB*", DEFAULT_SERIAL_BAUD),
)
NET_CANDIDATES = (
    "udpin:0.0.0.0:14550",   # PX4's GCS target (SITL, HITL, and mavlink-router)
    "tcp:127.0.0.1:5760",    # PX4 SITL's direct TCP server
)
PROBE_SERIAL_S = 2.0   # a device that is there answers within one heartbeat period
PROBE_NET_S = 3.0      # UDP has no handshake: give SITL a moment to send


def candidate_endpoints() -> list[str]:
    """Endpoints to probe, most specific first. Only serial devices that exist
    are listed, so an absent radio costs nothing."""
    out: list[str] = []
    for pattern, baud in SERIAL_CANDIDATES:
        for dev in sorted(glob.glob(pattern)):
            out.append(f"serial:{dev}:{baud}")
    out.extend(NET_CANDIDATES)
    return out


def probe_endpoint(endpoint: str, timeout_s: float) -> bool:
    """True if an AUTOPILOT heartbeats on this endpoint within the window.

    Sends one GCS heartbeat first: harmless on serial, and it is what makes a
    `udpout`/TCP peer start streaming at all. The autopilot check is the same
    one _on_mav uses, so a second ground station on the wire -- or gs's own
    heartbeat echoed back by a router -- is never mistaken for a vehicle."""
    conn = None
    try:
        conn = open_connection(endpoint)
        m = mavutil.mavlink
        try:
            conn.mav.heartbeat_send(m.MAV_TYPE_GCS, m.MAV_AUTOPILOT_INVALID, 0, 0,
                                    m.MAV_STATE_ACTIVE)
        except Exception:
            pass  # udpin has no peer to send to yet; that is fine
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            msg = conn.recv_match(type="HEARTBEAT", blocking=True, timeout=0.25)
            if msg is None:
                continue
            if msg.type == m.MAV_TYPE_GCS or msg.autopilot == m.MAV_AUTOPILOT_INVALID:
                continue
            print(f"[gs] autodetect: autopilot found on {endpoint} "
                  f"(sysid {msg.get_srcSystem()})")
            return True
        return False
    except Exception as exc:
        print(f"[gs] autodetect: {endpoint} unusable ({exc})")
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def detect_endpoint(candidates: list[str] | None = None) -> str | None:
    """Probe every candidate once; return the first that has an autopilot on it."""
    for endpoint in candidates if candidates is not None else candidate_endpoints():
        window = PROBE_NET_S if endpoint.startswith(("udp", "tcp")) else PROBE_SERIAL_S
        if probe_endpoint(endpoint, window):
            return endpoint
    return None


# A USB CDC-ACM device -- which is what a flight controller plugged into a
# laptop is, on the bench and in HITL -- ignores the baud rate entirely. Line
# coding is a no-op over USB: both ends accept whatever number is set and move
# data at bus speed, megabytes per second.
#
# Treating the number as real is not a small error. MEASURED on the pre-fix
# code: `/dev/tty.usbmodem14201` (the macOS name, which autodetect finds) fell
# through to the 57600 default and came out at 3456 B/s -- the same budget as a
# SiK radio -- so gs asked for 1.9 Hz actuator output and switched the param
# fetch to the paced walk. On the link where everything should be at full rate,
# the bench and HITL sessions got radio behaviour.
#
# The distinction is the device class, not the name's prefix: ttyACM/usbmodem
# are CDC-ACM, while ttyUSB/usbserial are real UARTs behind an FTDI or CP210x
# bridge, and ttyAMA/ttyS are the SoC's own UART -- which on a Pi hub is exactly
# where the telemetry radio lives, so those must stay rate-limited.
_CDC_ACM_HINTS = ("ttyacm", "usbmodem")


def _is_usb_cdc(device: str) -> bool:
    low = device.lower()
    return any(h in low for h in _CDC_ACM_HINTS)


def link_budget_bps(endpoint: str, baud: int = DEFAULT_SERIAL_BAUD) -> float:
    """Usable goodput of a MAVLink endpoint, bytes/sec. A real UART is the
    constraint (a telemetry radio); IP and USB CDC-ACM are treated as free."""
    if endpoint.startswith("serial:"):
        parts = endpoint.split(":")
        device = parts[1] if len(parts) > 1 else ""
        rate = int(parts[2]) if len(parts) > 2 and parts[2] else baud
    elif "://" not in endpoint and (endpoint.startswith("/dev/")
                                    or endpoint.upper().startswith("COM")):
        device, rate = endpoint, baud
    else:
        return NET_BUDGET_BPS
    if _is_usb_cdc(device):
        return NET_BUDGET_BPS        # the baud is a fiction; see _CDC_ACM_HINTS
    return (rate / 10.0) * SERIAL_GOODPUT_FRACTION   # 8N1 => 10 bits per byte


def message_bytes(msg_id: int) -> int:
    """On-the-wire size of a message id, from pymavlink's own definitions."""
    cls = mavutil.mavlink.mavlink_map.get(msg_id)
    size = getattr(getattr(cls, "unpacker", None), "size", 0) or 64
    return size + MAVLINK2_OVERHEAD


def param_read_hz(budget_bps: float) -> float:
    """Params per second a paced refresh may request, from the link budget."""
    pv = message_bytes(mavutil.mavlink.MAVLINK_MSG_ID_PARAM_VALUE)
    # Each param costs a request out and a value back; the value dominates and
    # the request shares the much quieter uplink, so budget on the value.
    return max(1.0, (budget_bps * PARAM_LINK_SHARE) / pv)


def budgeted_hz(budget_bps: float, msg_id: int, shares: int = 1) -> float:
    """Highest rate we may ask for a message, given the link and how many extra
    streams share gs's slice of it. Clamped to a sane [1, 25] Hz."""
    allowance = (budget_bps * EXTRA_STREAM_SHARE) / max(1, shares)
    hz = allowance / message_bytes(msg_id)
    return max(REQUEST_HZ_MIN, min(REQUEST_HZ_MAX, hz))

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
# The extras gs asks for, by the type name a decoded message reports. Keyed by
# name rather than by msg.get_msgId() so that anything shaped like a message
# works here -- the id is a pymavlink implementation detail and the name is the
# thing the rest of this file already dispatches on.
# Messages real PX4 streams to a GCS by default that gs never reads, and that
# nothing else is known to want. MEASURED against the firmware over a fat pipe,
# quiet machine, a fresh PX4 for each run:
#   off: 286 msg/s, 3.41% of a core here (an estimated 17.1% of a Pi 4's)
#   on:  168 msg/s, 1.14%                                          (5.7%)
# 41% fewer messages, 67% less CPU, and ~10.9 kB/s of link.
#
# NOTE the trim is STICKY: PX4 holds a channel's stream settings until the
# vehicle reboots, so turning it back off with --keep-all-streams does not
# restore the streams on an already-running autopilot. Measuring one setting
# after the other without restarting PX4 in between reads as "no effect",
# which cost a confused measurement before this was understood.
# ATTITUDE_QUATERNION duplicates ATTITUDE, which gs does use; the other three
# are estimator and IMU detail for a simulator or a companion computer, not for
# a ground station.
#
# Trimming them is per-CHANNEL in PX4, so it changes what OUR link carries and
# nothing else: a companion on another channel keeps its streams. On a radio
# PX4 is already pacing itself and these mostly will not appear; the case this
# is for is USB and HITL, where bandwidth is free and the hub's CPU is not.
_TRIMMABLE = {
    "HIGHRES_IMU": mavutil.mavlink.MAVLINK_MSG_ID_HIGHRES_IMU,
    "ATTITUDE_QUATERNION": mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE_QUATERNION,
    "ODOMETRY": mavutil.mavlink.MAVLINK_MSG_ID_ODOMETRY,
    # LOCAL_POSITION_NED is NOT here, though gs reads it no more than the
    # others. This airframe's own px4-rc.mavlink carries a deliberate
    #   mavlink stream -r 50 -s LOCAL_POSITION_NED -u $udp_gcs_port_local
    # and nobody now remembers what consumes it. SET_MESSAGE_INTERVAL is scoped
    # to the CHANNEL, not to the client that asked, so switching it off would
    # switch it off for every other tool on that link as well -- silently, and
    # from inside a ground station that has no business deciding what else on
    # the network needs. The CPU this costs is a known quantity; what the trim
    # would break is not, and that asymmetry decides it.
}

_REQUESTED_IDS = {
    "ACTUATOR_OUTPUT_STATUS": MSG_ACTUATOR_OUTPUT_STATUS,
    "POSITION_TARGET_GLOBAL_INT": MSG_POSITION_TARGET_GLOBAL_INT,
    "WIND_COV": MSG_WIND_COV,
}


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
        # A takeoff to zero or below is a takeoff into the ground. gs is the last
        # thing between a malformed request and an aircraft, so it refuses what
        # it can prove wrong rather than forwarding it and hoping PX4 objects.
        if not math.isfinite(alt) or alt <= 0:
            raise ValueError(f"takeoff needs a positive altitude, got {alt}")
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
        # "Fly to here" with no here. An omitted or non-finite coordinate used to
        # go out as a NaN position: a fly-to command with no destination, sent to
        # an aircraft, for PX4 to interpret however it does. A missing altitude
        # is fine and means "keep the current one"; a missing POSITION is not.
        if not (math.isfinite(lat) and math.isfinite(lon)):
            raise ValueError("reposition needs a finite lat and lon")
        if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
            raise ValueError(f"reposition lat/lon out of range: {lat}, {lon}")
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


FENCE_POLYGON_MIN_VERTICES = 3   # two points bound no area


def validate_fence_plan(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Check a FENCE plan and return it with `vertexCount` derived by gs.

    `param1` on a fence vertex is, per MAVLink, how many vertices PX4 should
    read as belonging to *this* polygon; consecutive same-kind vertices are one
    shape, so a flat list can carry several. That makes the count structural,
    not decorative: get it wrong and PX4 mis-slices the whole fence.

    gs used to take it from the client and forward whatever arrived. Measured on
    the pre-fix code, every one of these was accepted and acked `accepted`:
    a 2-vertex "polygon" (param1=[2,2]), a 1-vertex one, a client claiming 7 for
    3 vertices, a client omitting the count entirely (param1=[0,0,0], i.e. "this
    polygon has no vertices"), and a circle of radius 0. In each case the
    operator is told they have a geofence when they do not -- and the whole
    point of a fence is that it is there when something else has already gone
    wrong, so `accepted` has to mean it.

    gs is the authority on the wire: it serves the console and anything else
    that ever speaks this protocol, so it cannot depend on a client computing
    this correctly. The count is therefore DERIVED here. A client that supplied
    a different number is refused rather than silently corrected -- if the two
    ends disagree about what the fence is, uploading either answer without
    saying so is its own failure."""
    out: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            raise ValueError("fence item must be an object")
        out.append({**it, "params": dict(it.get("params") or {})})

    i = 0
    while i < len(out):
        kind = out[i].get("kind")
        if kind in _FENCE_POLY_KINDS:
            j = i
            while j < len(out) and out[j].get("kind") == kind:
                j += 1
            count = j - i
            if count < FENCE_POLYGON_MIN_VERTICES:
                raise ValueError(
                    f"item {i}: a polygon fence needs at least "
                    f"{FENCE_POLYGON_MIN_VERTICES} vertices, got {count}")
            for k in range(i, j):
                claimed = out[k]["params"].get("vertexCount")
                if claimed is not None and int(claimed) != count:
                    raise ValueError(
                        f"item {k}: client says vertexCount {int(claimed)} but this "
                        f"polygon run has {count} vertices")
                out[k]["params"]["vertexCount"] = count
            i = j
            continue
        if kind in _FENCE_CIRCLE_KINDS:
            try:
                radius = float(out[i]["params"].get("radius") or 0)
            except (TypeError, ValueError):
                raise ValueError(f"item {i}: circle radius must be a number") from None
            if radius <= 0:
                raise ValueError(f"item {i}: a circle fence needs a radius > 0, got {radius:g}")
        i += 1
    return out


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


# The commanded-path overlay's fields, as one group: they are accepted or
# refused together, because a target latitude from one source and a longitude
# from another is a point that exists nowhere.
_TARGET_KEYS = ("targetLat", "targetLon", "targetAlt")

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
    # The sim's MODELLED wind (NED m/s, direction the air moves toward). Sim-only;
    # no MAVLink carrier.
    #
    # DO NOT DISPLAY THIS AS THE WIND. It is the environment model's intent, not
    # what the airframe experienced. In the px4_autopilot rig they are different
    # things: environment.py models wind with shear and turbulence, but nothing
    # sets JSBSim's atmosphere/wind-* properties, so the aerodynamics never see
    # it. MEASURED on a live flight — this feed said 6.21 m/s while PX4's EKF2,
    # which only knows what the airframe actually flew in, said 0.14 m/s with a
    # 0.28 sigma. A 6 m/s phantom.
    #
    # The wind the operator is shown comes from WIND_COV and nowhere else. These
    # are kept only so the two can be COMPARED — a nonzero gap means the sim's
    # wind is not reaching the FDM, which is a sim-configuration bug worth
    # seeing, not a reading to put on the HUD.
    "windN", "windE", "windD",
}

# Of those, the keys the JSON feed owns EVEN WHEN A REAL AUTOPILOT IS ON THE
# LINK (H4). The feed is documented as the sim's no-PX4 path, but nothing
# enforced that: in HITL both are live and `_json_loop` wrote lat/lon/alt/
# attitude/mode/armed straight over whatever MAVLink had just put there, with no
# TTL and no arbitration. The two sources then interleave at their own rates and
# the aircraft jitters between the autopilot's estimate and the sim's truth --
# and `armed`/`mode` from the sim can contradict the autopilot the operator is
# commanding, which is a GCS lying about the state of the vehicle.
#
# So: once a vehicle is locked, MAVLink owns flight state, full stop. JSON keeps
# only what MAVLink has no carrier for (the solar/power model, the sim's
# modelled wind) plus the two PX4 SITL fakes that the existing TTL arbitration
# already hands to it. With no vehicle locked -- the genuine no-PX4 rig -- JSON
# owns everything, exactly as before.
JSON_ONLY_KEYS = {
    # No MAVLink carrier at all: the solar/power model and the sim's own wind.
    "genW", "loadW", "propW", "motorCurrent", "irradiance", "sunEpochMs",
    "windN", "windE", "windD",
    # PX4 SITL's BATTERY_STATUS is a static dummy; the feed is the real figure.
    "voltage", "current", "batteryRemaining",
    # Already TTL-arbitrated against POSITION_TARGET_GLOBAL_INT in _on_mav_state.
    "targetLat", "targetLon", "targetAlt",
}


_MONO_EPOCH = time.monotonic()   # daemon start, for _mono_ms

# _mono_ms counts from this value rather than from 0, and the reason is a real
# bug the monotonic switch introduced: `0` is the "never happened" sentinel for
# every watermark in this file (_hb_at, a command's last_send_ms, _last_req_at,
# _param_batch_at, a mission op's last). Under the old WALL clock `now - 0` was
# ~1.7e12 ms, so "never" always read as "long ago" and every
# `now - last >= TIMEOUT` test fired. Measured from daemon start, `now - 0` is
# just the uptime -- so for the first second of the daemon's life "never" reads
# as "just now" and everything is SUPPRESSED: the first GCS heartbeat delayed,
# a command queued at startup not transmitted, the stream requests skipped. An
# origin longer than any timeout here restores the old meaning without
# reintroducing the wall clock.
_MONO_ORIGIN_MS = 3_600_000   # an hour: longer than every timeout in this file


def _now_ms() -> int:
    """WALL-CLOCK ms since the epoch. For TIMESTAMPS a human or a log reads.
    Never for a duration -- see _mono_ms."""
    return int(time.time() * 1000)


def _mono_ms() -> int:
    """MONOTONIC ms. For every duration: link health, retries, timeouts, TTLs.

    The field hub is a Raspberry Pi with no RTC. It boots with a stale or zero
    clock and then steps -- by hours, or by decades -- the moment it gets NTP, a
    GPS fix, or the operator sets the date. That is not an edge case on a hub;
    it is what every cold boot without a network does.

    Computing a duration from the wall clock then goes wrong in both directions,
    and the backward one is unsafe. MEASURED on the pre-fix code, with a frame
    that had just arrived: a 1 h backward step produced
    `linkState="alive", dataAgeMs=-3600000` -- gs telling the console the
    aircraft is live, and continuing to say so for an hour, which is precisely
    the "stale aircraft shown as live" failure this daemon is built to prevent.
    A forward step is merely loud: the link goes `lost` and every in-flight
    command, param set and mission handshake expires in the same tick.

    time.monotonic() cannot step and cannot go backward, so every comparison
    below is against elapsed real time regardless of what the clock does.

    Measured from daemon start rather than raw, for two reasons. It makes the
    value a readable uptime (the `upMs` a client sees). And `0` is the "never
    saw any traffic" sentinel for last_mav_at / last_json_at, while a raw
    time.monotonic() is since-BOOT on Linux -- on a hub whose systemd unit
    starts gs at boot that is a single-digit number of seconds, uncomfortably
    close to the sentinel. The origin offset guarantees the two can never
    collide, and that a `0` watermark still reads as "long ago" -- see
    _MONO_ORIGIN_MS, which is a bug this function caused before it had one."""
    return int((time.monotonic() - _MONO_EPOCH) * 1000) + _MONO_ORIGIN_MS


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
        budget_bps: float | None = None,
        trim_streams: bool = True,
        log_dir: str | None = None,
        command_token: str = "",
    ) -> None:
        self.mavlink_endpoint = mavlink_endpoint
        self.json_port = json_port
        self.ws_host = ws_host
        self.ws_port = ws_port
        self.baud = baud
        # The secret that separates watching from commanding. Empty means the
        # old behaviour -- anyone who can reach the port can fly the aircraft --
        # which is announced loudly at startup rather than left to be discovered.
        self.command_token = command_token
        # Ask PX4 to stop sending what gs never reads. See _TRIMMABLE.
        self.trim_streams = trim_streams
        # True while serving a recorded flight. Carried on every frame, because
        # a console that cannot tell a replay from a live aircraft is a console
        # that will eventually be read as live while something is on fire.
        self.replaying = False
        # Everything that crosses the link, written where someone can replay it.
        # None disables it; the daemon still flies, it just forgets.
        self.flight_log = FlightLog(log_dir) if log_dir else None
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
        # When PX4's own POSITION_TARGET_GLOBAL_INT last arrived and was usable.
        # While this is fresh, the JSON feed's target is ignored.
        self._mav_target_at = 0
        self._json_battery_at = 0
        self._last_target_at = 0
        self._last_req_at: dict[int, int] = {}
        # Attempts per message id, for the backoff in _request_message.
        self._req_tries: dict[int, int] = {}
        # name -> MAV_PARAM_TYPE, learned from the vehicle. See _start_param_set.
        self._param_types: dict[str, int] = {}
        # Backoff state for asking PX4 to STOP sending something. Separate from
        # _req_tries, whose reset-on-arrival rule is the opposite of this one's.
        self._trim_at: dict[int, int] = {}
        self._trim_tries: dict[int, int] = {}

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
        self._param_last_progress = 0
        self._param_set_pending: dict[str, dict[str, Any]] = {}  # name -> set job
        self._param_gap_sweeps = 0
        self._param_batch: list[dict[str, Any]] = []   # mav-thread only
        self._param_batch_at = 0
        # Paced-refresh state (narrow links; see PARAM_PACED_BELOW_BPS).
        self._param_paced = False
        self._param_req_at: dict[int, int] = {}   # index -> last request (mono ms)
        self._param_paced_at = 0                  # last paced request tick
        self._param_next_idx = 0                  # cursor into the paced walk
        # Set by _on_mav_state when the vehicle's uptime clock jumps backward
        # (a reboot); acted on in _on_mav_protocol, which may transmit.
        self._reboot_pending: int | None = None
        # A backward uptime jump too small to be unambiguous, held for one frame
        # so the next one can say whether it was a reorder or a reboot.
        self._param_refresh_opened_at = 0   # see PARAM_REFRESH_COOLDOWN_MS
        # Partially-received chunked status messages, keyed by STATUSTEXT id.
        self._text_runs: dict[int, dict[str, Any]] = {}
        self._boot_suspect: int | None = None
        # Where position frames arrive FROM, counted per peer. On a UDP or TCP
        # link pymavlink exposes the sender's address, and when two sources
        # share a sysid that address is the only thing that tells them apart --
        # so the storm report names them instead of asking the operator to go
        # looking. Bounded: a handful of peers on any real link, and a flood of
        # spoofed sources would be the finding, not a leak.
        self._pos_peers: dict[str, int] = {}
        # The peer the frame being folded arrived from, or None on a link that
        # has no such notion (serial). Set by the receive loop, read under the
        # lock by the folder; a plain attribute is enough since only the one
        # loop writes it and it is only ever a diagnostic.
        self._mav_peer: str | None = None
        # Recent reboot conclusions, for the storm check (see REBOOT_STORM_MAX).
        self._reboot_times: list[int] = []
        self._storm_reported = False
        # Per-message-group freshness; see _AGE_GROUPS. Mav-thread writes under
        # the lock, the broadcast loop reads it there too.
        self._src_at: dict[str, int] = {}
        self._tasks: set[asyncio.Task[Any]] = set()    # keep ack-delivery tasks alive
        self.link_reopens = 0                          # diagnostics: transport reopen count
        self._hb_at = 0                                # last GCS heartbeat tx (mav thread)
        # What this transport can carry, and therefore what rate gs may ask PX4
        # for on its three extra streams. See link_budget_bps / budgeted_hz.
        # Usable goodput of the link, which sets the stream rates and the param
        # fetch strategy. Normally inferred from the endpoint -- but a UDP socket
        # says "fat pipe", and that is a lie exactly when mavlink-router (or any
        # other proxy) sits between gs and a telemetry radio: gs would then ask a
        # 57600 link for 25 Hz streams and a PARAM_REQUEST_LIST flood. A pin is
        # the operator saying what is really downstream. It also survives a
        # reopen, which a derived value must not.
        self._budget_pin = budget_bps
        self.link_budget_bps = budget_bps or link_budget_bps(mavlink_endpoint, baud)
        # The endpoint actually opened (differs from mavlink_endpoint under
        # `auto`, and can change across a reopen).
        self.active_endpoint = mavlink_endpoint
        self.handler_errors = 0                        # diagnostics: swallowed handler exceptions

        # --- mission path (Phase 4) ----------------------------------------
        # Upload/download handshakes run on the mav thread; `_mission` holds the
        # single active op (one at a time) and is mav-thread-owned.
        self._mission_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._mission: dict[str, Any] | None = None

    # --- MAVLink ingest ------------------------------------------------------
    def _on_reopen(self) -> None:
        """Reset the per-link state a reopen invalidates (H5).

        `_vehicle` locks onto the first autopilot heartbeat and is never
        released on a live link -- that is what keeps a companion computer from
        overwriting vehicle state. Across a reopen it is a trap: unplug the USB
        autopilot, attach the radio to an aircraft with a different MAV_SYS_ID,
        and the `src != self._vehicle` guard silently drops every message from
        it. The console shows `connecting` forever with a perfectly healthy
        radio, and commands keep going to a sysid that is not there. A reopened
        link is a new link, so it starts with nothing locked.

        `_last_pos_boot_ms` goes with it: the new vehicle's uptime clock is
        unrelated to the old one's, and a lower value would be rejected as a
        reordered frame."""
        if self._vehicle is not None:
            print(f"[gs] link reopened: releasing vehicle lock on sysid {self._vehicle[0]}")
        self._vehicle = None
        self._last_pos_boot_ms = -1
        self._boot_suspect = None
        self._reboot_times.clear()
        self._storm_reported = False
        self._src_at.clear()        # the new link's streams have their own ages
        self._last_req_at.clear()   # re-request the extra streams on the new link
        self._req_tries.clear()     # ...promptly, not at the backed-off rate
        self._param_types.clear()   # a different airframe may type names differently
        self._trim_at.clear()       # the new link is back on PX4's defaults
        self._trim_tries.clear()

    def _resolve_endpoint(self) -> str | None:
        """The endpoint to open. With `auto`, probe for one; the result is
        re-resolved on every reopen, so unplugging the USB cable and bringing up
        the radio instead is a hardware action, not a restart."""
        if self.mavlink_endpoint != AUTODETECT:
            return self.mavlink_endpoint
        found = detect_endpoint()
        if found is None:
            # Nothing on the wire yet -- which is the normal state while the
            # aircraft is still powering up. Fall back to the UDP port PX4 and
            # mavlink-router both default to, and keep listening there: a daemon
            # that exits because the vehicle was not ready is useless on a hub
            # that boots with the plane.
            print("[gs] autodetect: nothing heartbeating yet; "
                  f"listening on {NET_CANDIDATES[0]} and re-probing on reopen")
            return NET_CANDIDATES[0]
        return found

    def _open_with_retry(self) -> Any:
        """Open the transport, retrying with backoff. A serial device that is not
        plugged in yet, or a TCP peer that is not up, must not kill the daemon."""
        delay = LINK_REOPEN_MIN_S
        while True:
            endpoint = self._resolve_endpoint()
            try:
                conn = open_connection(endpoint, self.baud)
            except Exception as exc:
                print(f"[gs] mavlink open failed ({exc}); retrying in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, LINK_REOPEN_MAX_S)
                continue
            self._record_sends(conn)
            # The link budget follows the transport we actually got, not the one
            # configured -- under `auto` they are only known now, and asking a
            # 57600 radio for 25 Hz is the fault H2 fixed.
            self._on_reopen()
            self.active_endpoint = endpoint
            if self._budget_pin is None:
                self.link_budget_bps = link_budget_bps(endpoint, self.baud)
            print(f"[gs] listening for MAVLink on {endpoint} "
                  f"({self.link_budget_bps:.0f} B/s budget)")
            return conn

    def _record_sends(self, conn: Any) -> None:
        """Log what gs transmits, by wrapping the one place it leaves.

        Every send helper in pymavlink -- command_long_send, param_set_send,
        mission_item_int_send -- ends at `conn.write`, so wrapping that covers
        all of them and cannot be forgotten when a new one is added. Wrapping
        each call site instead would have been a list to keep in step with the
        code, and that list is wrong the first time somebody adds a message.

        Commands are the half of a debrief that says what the OPERATOR did; a
        log of only what arrived answers "what did the aircraft do" and leaves
        "what were we asking it to do" to memory."""
        if self.flight_log is None or getattr(conn, "_gs_logged", False):
            return
        inner = conn.write

        def logged_write(buf):
            try:
                self.flight_log.write(buf)
            except Exception:
                pass            # logging never breaks a transmit
            return inner(buf)

        conn.write = logged_write
        conn._gs_logged = True

    def _mav_loop(self) -> None:
        conn = self._open_with_retry()
        errors = 0
        while True:
            try:
                msg = conn.recv_match(blocking=True, timeout=0.5)
                if self.flight_log is not None and msg is not None:
                    # The raw frame, not a re-encode: a log is evidence, and a
                    # re-encode records what gs believes rather than what the
                    # aircraft said. The two differing is the kind of thing a
                    # log exists to settle.
                    self.flight_log.write(msg.get_msgbuf())
                # UDP/TCP connections expose the sender; serial has no peer.
                addr = getattr(conn, "last_address", None)
                self._mav_peer = (f"{addr[0]}:{addr[1]}"
                                  if isinstance(addr, tuple) and len(addr) >= 2
                                  else None)
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
                # First, unconditionally: PX4 must keep hearing from us even if
                # nothing else is going well on this link.
                self._service_heartbeat(conn)
                if msg is not None:
                    self._on_mav(conn, msg)
                # Drain queued commands and drive retries/timeouts on THIS thread, so
                # all pymavlink sends share the one connection. recv's 0.5 s timeout
                # bounds the retry/timeout resolution even when there's no traffic.
                self._service_commands(conn)
                self._service_params(conn)
                self._service_misc(conn)
                self._service_missions(conn)
                # A chunked status message whose last chunk was lost would
                # otherwise sit in the buffer forever; the operator gets what
                # arrived, marked as partial. See _on_statustext.
                self._expire_text_runs()
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

    def _service_heartbeat(self, conn: Any) -> None:
        """Mav-thread: announce ourselves to PX4 as a ground station, 1 Hz.

        This is not cosmetic. Without it PX4's commander never sees a data link
        at all (see GCS_HEARTBEAT_MS) and will run the datalink-loss failsafe
        mid-flight with a perfectly healthy radio. We declare MAV_TYPE_GCS with
        MAV_AUTOPILOT_INVALID -- the same identity QGC uses, and the identity
        our own _on_mav ignores, so a second gs on the link can never be
        mistaken for the vehicle."""
        now = _mono_ms()
        if now - self._hb_at < GCS_HEARTBEAT_MS:
            return
        self._hb_at = now
        m = mavutil.mavlink
        try:
            conn.mav.heartbeat_send(m.MAV_TYPE_GCS, m.MAV_AUTOPILOT_INVALID, 0, 0,
                                    m.MAV_STATE_ACTIVE)
        except Exception as exc:
            print(f"[gs] gcs heartbeat failed: {exc}")

    def _service_commands(self, conn: Any) -> None:
        """Mav-thread: accept newly queued commands, (re)send due ones, and time
        out those that never got a COMMAND_ACK. Never fire-and-forget."""
        now = _mono_ms()
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
        if ok and job.get("retyped"):
            # Worth saying: the client's idea of this parameter's type was
            # wrong, and silently fixing it would leave that bug in place.
            text = f"{text} (sent as the vehicle's own type)"
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
                # An operator picking a rate in the UI cannot know the link's
                # budget, so clamp it here rather than let a 50 Hz request off a
                # phone saturate a telemetry radio and drop commands. Say so on
                # the statustext channel so the clamp is visible, not silent.
                if hz > 0:
                    cap = budgeted_hz(self.link_budget_bps, msg_id, shares=1)
                    if hz > cap:
                        self._broadcast({
                            "type": "statustext", "severity": 4,
                            "text": f"msg {msg_id}: {hz:g} Hz exceeds the link budget, "
                                    f"capped at {cap:.1f} Hz",
                            "t": _now_ms()})
                        hz = cap
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
        now = _mono_ms()
        # 1. Admit new param jobs from the WS thread.
        while True:
            try:
                item = self._param_queue.get_nowait()
            except queue.Empty:
                break
            if item["kind"] == "refresh":
                if self._param_refresh_active:
                    # Two tabs clicking Refresh must not double the radio load.
                    # Say so rather than dropping it in silence: a client that
                    # hears nothing cannot tell its request from a lost one,
                    # and the console used to clear its table on the strength
                    # of a request that was never going to be acted on.
                    self._broadcast({"type": "param_progress",
                                     "received": len(self._param_received),
                                     "count": self._param_count,
                                     "note": "a refresh is already in progress"})
                    continue
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
            elif self._param_paced:
                self._service_param_paced(conn, now, got)
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

    def _on_vehicle_reboot(self, now: int, boot_ms: int) -> None:
        """The vehicle restarted. Abandon everything addressed to the instance
        that is gone, and say so.

        Every in-flight handshake was a conversation with a process that no
        longer exists: the autopilot will not answer a PARAM_SET it never
        received, or ask for the next item of an upload it has forgotten. Left
        alone they each sit until their own timeout and then report `timeout`,
        which tells the operator the link is bad when the truth is that the
        vehicle rebooted -- a much more useful thing to know, and a different
        action.

        Clients also hold state a reboot invalidates. Params are the dangerous
        one: PX4 reverts anything that was not saved, so a console that keeps
        showing the pre-reboot values will show an edit as applied when the
        vehicle has dropped it. gs holds no param cache of its own, so this is
        broadcast rather than handled here."""
        now_mono = _mono_ms()
        self._reboot_times = [t for t in self._reboot_times
                              if now_mono - t < REBOOT_STORM_WINDOW_MS]
        self._reboot_times.append(now_mono)
        if len(self._reboot_times) > REBOOT_STORM_MAX:
            # Not a vehicle rebooting. See REBOOT_STORM_MAX.
            if not self._storm_reported:
                self._storm_reported = True
                sysid = self._vehicle[0] if self._vehicle else "?"
                peers = sorted(self._pos_peers.items(), key=lambda kv: -kv[1])
                where = (", ".join(f"{a} ({n} frames)" for a, n in peers)
                         if peers else "a link that does not report peer addresses")
                text = (f"two sources appear to share sysid {sysid}: the uptime "
                        f"clock keeps restarting, which one vehicle cannot do. "
                        f"Position frames came from: {where}. Two addresses means "
                        f"a second autopilot or a router merging streams; one "
                        f"address means one sender whose clock really is "
                        f"restarting, or a serial link that cannot say.")
                print(f"[gs] {text}")
                self._broadcast({"type": "statustext", "severity": 3,
                                 "text": f"gs: {text}", "t": _now_ms()})
            # Abort nothing: the aborting is what made this unusable, and there
            # is no reboot to recover from.
            return
        self._storm_reported = False
        print(f"[gs] vehicle rebooted (uptime restarted at {boot_ms} ms)")
        aborted = []
        if self._param_refresh_active:
            self._param_refresh_active = False
            if self._param_batch:
                self._flush_param_batch()
            self._broadcast({"type": "param_progress",
                             "received": len(self._param_received),
                             "count": self._param_count, "done": True,
                             "error": "vehicle rebooted"})
            aborted.append("param refresh")
        for name, job in list(self._param_set_pending.items()):
            del self._param_set_pending[name]
            self._report_param_ack(job, ok=False, text="vehicle rebooted")
            aborted.append(f"param set {name}")
        op = self._mission
        if op is not None:
            self._mission = None
            text = "vehicle rebooted"
            if op["op"] == "upload":
                self._report_mission_ack(op.get("id"), ok=False, result=-1,
                                         text=text, ack_type=op["ack_type"])
            else:
                self._broadcast({"type": op["ack_type"], "ok": False,
                                 "result": -1, "text": text})
            aborted.append(f"{op['rtype']} {op['op']}")
        # Commands in flight are addressed to a vehicle that never saw them.
        for cid in list(self._pending):
            del self._pending[cid]
            self._report(cid, ok=False, result=-1, text="vehicle rebooted")
            aborted.append("command")
        # The extra streams have to be re-requested: the new instance is back on
        # PX4's defaults and never saw our SET_MESSAGE_INTERVALs. The backoff
        # resets too, or a reboot after a long quiet spell would wait a minute
        # before asking -- see _request_message.
        self._last_req_at.clear()
        self._req_tries.clear()
        self._broadcast({"type": "vehicle_reboot", "bootMs": boot_ms, "t": _now_ms(),
                         "aborted": aborted})

    def _paced_read(self, conn: Any, idx: int) -> None:
        try:
            conn.mav.param_request_read_send(self.tsys, self.tcomp, b"", idx)
        except Exception as exc:
            print(f"[gs] param_request_read({idx}) failed: {exc}")
            return
        self._param_req_at[idx] = _mono_ms()

    def _service_param_paced(self, conn: Any, now: int, got: int) -> None:
        """Walk the param indices at a rate the link can spare.

        The alternative, PARAM_REQUEST_LIST, hands the pacing to the autopilot,
        which sends as fast as the link allows and starves everything else --
        including the COMMAND_ACK for an arm the operator just pressed. Here gs
        issues the reads, so the rate is ours to choose."""
        if now - self._param_last_rx_ms > PARAM_PACED_STALL_MS:
            # Asking and getting nothing: fail loudly rather than poll forever.
            self._param_refresh_active = False
            if self._param_batch:
                self._flush_param_batch()
            self._broadcast({"type": "param_progress", "received": got,
                             "count": self._param_count, "done": True,
                             "error": "timeout"})
            return
        if self._param_count == 0:
            # Still bootstrapping: re-read index 0 until it answers.
            if now - self._param_req_at.get(0, 0) >= PARAM_READ_RETRY_MS:
                self._paced_read(conn, 0)
            return
        # How many reads this tick is allowed, from the elapsed time and the rate.
        # The first tick after the count arrives gets a full burst: the budget
        # has been idle through the bootstrap, and making this tick wait out one
        # interval meant the walk did not start at all until the next one.
        interval_ms = 1000.0 / param_read_hz(self.link_budget_bps)
        allowed = (PARAM_READ_BURST if self._param_paced_at == 0
                   else int((now - self._param_paced_at) / interval_ms))
        if allowed <= 0:
            return
        # Resume the walk where it left off rather than rescanning from zero.
        # This runs once per mav-loop iteration, i.e. once per received message,
        # so a scan from 0 over ~1000 params came to tens of thousands of index
        # checks per second -- on a Raspberry Pi, to issue at most 8 reads. The
        # cursor wraps once per pass, which also interleaves retries of indices
        # that never answered with new ones instead of letting the early ones
        # consume every burst.
        budget = min(allowed, PARAM_READ_BURST)
        sent = 0
        scanned = 0
        idx = self._param_next_idx
        while sent < budget and scanned < self._param_count:
            if idx >= self._param_count:
                idx = 0
            scanned += 1
            if idx in self._param_received:
                idx += 1
                continue
            if now - self._param_req_at.get(idx, 0) < PARAM_READ_RETRY_MS:
                idx += 1          # already asked recently; wait for the answer
                continue
            self._paced_read(conn, idx)
            sent += 1
            idx += 1
        self._param_next_idx = idx
        if sent:
            self._param_paced_at = now

    def _start_param_refresh(self, conn: Any) -> None:
        self._param_received.clear()
        self._param_count = 0
        self._param_refresh_active = True
        self._param_last_progress = 0
        self._param_gap_sweeps = 0
        self._param_last_rx_ms = _mono_ms()
        self._param_req_at.clear()
        self._param_paced_at = 0
        self._param_next_idx = 0
        # Strategy follows the transport, like the stream rates do. A fat pipe
        # gets the fast path it has always had; a radio gets paced reads so a
        # refresh cannot starve the commands (see PARAM_PACED_BELOW_BPS).
        self._param_paced = self.link_budget_bps < PARAM_PACED_BELOW_BPS
        if self._param_paced:
            print(f"[gs] param refresh: paced "
                  f"({param_read_hz(self.link_budget_bps):.0f}/s, "
                  f"{PARAM_LINK_SHARE:.0%} of a {self.link_budget_bps:.0f} B/s link)")
            # One read of index 0 bootstraps the total: PARAM_VALUE carries
            # param_count, so we learn the size without asking for the flood.
            self._paced_read(conn, 0)
            return
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
            # The type the VEHICLE reported for this parameter beats the one the
            # client offered. PX4 compares the type on a PARAM_SET and silently
            # IGNORES a write whose type does not match -- no refusal, no ack,
            # nothing. gs then retried, timed out, and told the operator
            # "timeout", which points at the radio for what is actually a type
            # mismatch. MEASURED against real PX4: writing the int parameter
            # MAV_SYS_ID as REAL32 produced exactly that.
            #
            # This is not the value cache gs deliberately does not keep. A
            # value is state that a reboot invalidates; a parameter's TYPE is a
            # property of the firmware, and gs has already seen it on every
            # PARAM_VALUE it forwarded. Using it costs a dict and removes a
            # whole class of silent failure, including for clients that cannot
            # know the type -- a script, or a console that has not read the
            # table yet, where `ptype` is optional and defaults to REAL32.
            name = str(item.get("name") or "")
            known = self._param_types.get(name)
            offered = item.get("ptype")
            if known is not None:
                job["ptype"] = known
                job["retyped"] = (offered is not None and int(offered) != known)
            else:
                job["ptype"] = int(offered or mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
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
        job["last_send_ms"] = _mono_ms()

    # --- mission protocol (hand-rolled, mav thread) --------------------------
    def _service_missions(self, conn: Any) -> None:
        now = _mono_ms()
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
            elif op.get("kickoffs", 0) > MISSION_MAX_TRIES:
                # Backstop against a restart LOOP, which the ordinary `tries`
                # check cannot catch: `tries` resets to 0 on every bit of
                # progress -- right for bounding a stall, and exactly how the
                # pre-fix retry livelocked. Re-sending MISSION_COUNT made the
                # autopilot restart at seq 0, that request counted as progress,
                # the budget reset, and round it went. MEASURED at 5 % loss on a
                # 3.4 kB/s link: 39 restarts, no completion in 90 s, and no
                # timeout ever reported -- the console sits on "uploading"
                # forever, which is worse than a clean failure. Retransmitting
                # one item (below) removes the cause; this bounds the class.
                text = "timeout (restart loop)"
                if op["op"] == "upload":
                    self._report_mission_ack(op.get("id"), ok=False, result=-1,
                                             text=text, ack_type=op["ack_type"])
                else:
                    self._broadcast({"type": op["ack_type"], "ok": False,
                                     "result": -1, "text": text})
                self._mission = None
            else:
                op["tries"] += 1
                op["last"] = now
                try:
                    if op["op"] == "upload":
                        # A stall mid-transfer means ONE packet was lost: either
                        # the autopilot's MISSION_REQUEST_INT or our
                        # MISSION_ITEM_INT answering it. Re-sending MISSION_COUNT
                        # makes the autopilot discard everything and restart from
                        # seq 0, so a single lost frame costs the whole mission
                        # again -- and MISSION_MAX_TRIES gets spent retransmitting
                        # items that already arrived. MEASURED on a 3.4 kB/s /
                        # 120 ms link at 5 % loss: a 40-item upload burned all
                        # three kickoffs and took 9.4 s, with no margin left.
                        # So re-send the last item instead, and keep MISSION_COUNT
                        # for the one case it is right for -- the autopilot never
                        # answered the kickoff at all.
                        if op.get("last_seq") is None:
                            op["kickoffs"] = op.get("kickoffs", 0) + 1
                            conn.mav.mission_count_send(
                                self.tsys, self.tcomp, op["count"], op["mtype"])
                        else:
                            self._mission_send_item(conn, op["last_seq"])
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
            # A fence is checked before it goes anywhere, and its vertex counts
            # are derived here rather than trusted (see validate_fence_plan).
            if job["mtype"] == MAV_MISSION_TYPE_FENCE:
                items = validate_fence_plan(items)
            fields = [mission_item_fields(i, it) for i, it in enumerate(items)]
        except (ValueError, TypeError, AttributeError) as exc:
            self._report_mission_ack(job.get("id"), ok=False, result=-1, text=str(exc), ack_type=ack_type)
            return
        self._mission = {"op": "upload", "id": job.get("id"), "items": fields,
                         "count": len(fields), "last": _mono_ms(), "tries": 0,
                         "last_seq": None, "kickoffs": 1,
                         "mtype": job["mtype"], "rtype": job["rtype"], "ack_type": ack_type}
        try:
            conn.mav.mission_count_send(
                self.tsys, self.tcomp, len(fields), job["mtype"])
        except Exception as exc:
            self._mission = None
            self._report_mission_ack(job.get("id"), ok=False, result=-1, text=f"send error: {exc}", ack_type=ack_type)

    def _start_mission_download(self, conn: Any, job: dict[str, Any]) -> None:
        self._mission = {"op": "download", "id": job.get("id"), "count": None,
                         "items": {}, "next": 0, "last": _mono_ms(), "tries": 0,
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
        """Ask the vehicle to stream a message, with a backoff that matters.

        The caller re-asks on every heartbeat for anything it has not seen, and
        this was throttled to once a second per message with no backoff and no
        end. That is fine when the stream eventually arrives, which is what the
        stand-in autopilot always did. Real PX4 ACCEPTS the request and then
        sends nothing, forever, whenever the vehicle has no such data -- no
        airspeed sensor means no WIND_COV, no configured actuators means no
        ACTUATOR_OUTPUT_STATUS, no active setpoint means no POSITION_TARGET.
        MEASURED against real PX4: 66 COMMAND_ACKs in 25 s, all ACCEPTED, for
        three streams that never came.

        On a 57600 radio that standing conversation costs 135 B/s up and 66 B/s
        down -- 5.8% of a half-duplex link's air time, permanently, to re-ask a
        question that was answered the first time. Backing off to a minute
        makes it 1/60th of that while still recovering from a genuinely lost
        request. The watermarks reset on a link reopen and on a vehicle lock,
        so a reboot or a swapped radio starts asking promptly again."""
        now = _mono_ms()
        tries = self._req_tries.get(msg_id, 0)
        wait = min(STREAM_REQ_MIN_MS * (2 ** tries), STREAM_REQ_MAX_MS)
        if now - self._last_req_at.get(msg_id, 0) < wait:
            return
        self._last_req_at[msg_id] = now
        self._req_tries[msg_id] = tries + 1
        # Rate from the link budget, not a constant. There are three of these
        # extra streams, so each gets a third of gs's slice.
        hz = budgeted_hz(self.link_budget_bps, msg_id, shares=3)
        conn.mav.command_long_send(
            tsys, tcomp,
            mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
            msg_id, int(1e6 / hz),
            0, 0, 0, 0, 0,
        )

    def _on_mav(self, conn: Any, msg: Any) -> None:
        t = msg.get_type()
        if t == "BAD_DATA":
            return  # corrupted bytes are not "traffic" for link-health purposes
        now = _mono_ms()   # a duration clock; see _mono_ms
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
        # A stream that arrives has answered the question, so its backoff starts
        # over: if it later stops and has to be asked for again, that ask should
        # be prompt rather than inheriting the patience built up last time.
        if self._req_tries:
            self._req_tries.pop(_REQUESTED_IDS.get(t, -1), None)
        # The lock guards `latest` and nothing else. It deliberately does NOT span
        # a MAVLink transmit: on the hub the link is a serial port, and a write
        # that blocks while the radio's buffer drains would hold this lock for
        # hundreds of ms. The 25 Hz WS broadcast takes the same lock, so the
        # asyncio loop -- and with it every client's ping -- stalls behind a radio
        # write. MEASURED: one 150 ms blocking write stalled the broadcast tick
        # 458 ms, and a saturated 57600 link queues far longer than that. State
        # first, under the lock; protocol state machines and all I/O after it.
        with self._lock:
            self.last_mav_at = now
            self._on_mav_state(now, t, msg)
        self._on_mav_protocol(conn, now, t, msg)

    def _note_boot_ms(self, boot: int) -> bool:
        """Fold the vehicle's uptime clock forward. Returns False if this frame
        is a reordered straggler the caller should ignore.

        Lifted out of the GLOBAL_POSITION_INT handler without changing a line of
        its reasoning, because that was the ONLY message feeding it -- and real
        PX4 does not always send it. MEASURED against the firmware with no
        position estimate: 22 SYSTEM_TIME and ZERO GLOBAL_POSITION_INT in 25
        seconds. A vehicle on the bench, indoors, on a HITL rig, or simply
        before GPS lock therefore had NO reboot detection at all -- and a reboot
        is the event that invalidates every cached parameter, which is the whole
        reason gs announces it. SYSTEM_TIME carries the same clock at 1 Hz and
        PX4 sends it unconditionally, so it feeds this too."""
        last = self._last_pos_boot_ms
        # One decision about the vehicle's own uptime clock going backward:
        # a reordered frame (drop it), a counter wrap (keep it, say nothing),
        # or a reboot (keep it, and tell everyone -- see _on_vehicle_reboot).
        rebooted = False
        if last >= 0 and boot <= last:
            if last - boot >= REBOOT_GAP_MS:
                # Unambiguous -- unless the counter simply wrapped: it was
                # about to overflow and has come back around (BOOT_MS_WRAP).
                if (last >= BOOT_MS_WRAP - BOOT_WRAP_MARGIN_MS
                        and boot <= BOOT_WRAP_MARGIN_MS):
                    print(f"[gs] vehicle uptime counter wrapped at 49.7 days "
                          f"({last} -> {boot} ms); not a reboot")
                else:
                    rebooted = True
                self._boot_suspect = None
            else:
                # Ambiguous: a reordered frame, or a reboot that happened
                # within REBOOT_GAP_MS of the last report. One frame cannot
                # say which, so a candidate is held and confirmed only when
                # the next frame continues from it. See BOOT_REBOOT_RATIO.
                suspect = self._boot_suspect
                if last < BOOT_REBOOT_MIN_UPTIME_MS:
                    # Only just booted: ACCEPT the frame and resync, without
                    # declaring a reboot. Dropping it instead was the first
                    # version of this guard, and it reintroduced the H24
                    # freeze -- every post-jump frame dropped, the watermark
                    # never advancing, the position stuck forever.
                    self._boot_suspect = None
                    self._last_pos_boot_ms = boot
                    self.latest["bootMs"] = boot
                    return True
                if suspect is not None and suspect <= boot < suspect + REBOOT_GAP_MS:
                    rebooted = True            # ascending from the low value
                    self._boot_suspect = None
                else:
                    # Only a jump that loses most of the uptime is even a
                    # candidate; a true reorder is a small blip.
                    self._boot_suspect = (boot if boot * BOOT_REBOOT_RATIO < last
                                          else None)
                    return False
        else:
            self._boot_suspect = None
        if rebooted:
            # Flagged here, acted on in _on_mav_protocol, because reacting
            # means transmitting and this runs under the lock.
            self._reboot_pending = boot
        self._last_pos_boot_ms = boot
        # PX4's own uptime clock, surfaced for diagnostics: when the
        # simulator stalls this is the value PX4's clock stops at, which
        # is what distinguishes a counter overflow from a race.
        self.latest["bootMs"] = boot
        return True

    def _on_mav_state(self, now: int, t: str, msg: Any) -> None:
        """Fold a message into `latest`. Called with `self._lock` held, so this
        must stay pure bookkeeping -- no sends, no broadcasts, no blocking."""
        L = self.latest
        group = _AGE_GROUPS.get(t)
        if group is not None:
            self._src_at[group] = now
        if t == "SYSTEM_TIME":
            # Carries the same uptime clock as GLOBAL_POSITION_INT, at 1 Hz,
            # whether or not the vehicle knows where it is. See _note_boot_ms.
            self._note_boot_ms(msg.time_boot_ms)

        elif t == "GLOBAL_POSITION_INT":
            if self._mav_peer is not None and len(self._pos_peers) < POS_PEERS_MAX:
                self._pos_peers[self._mav_peer] = self._pos_peers.get(self._mav_peer, 0) + 1
            if not self._note_boot_ms(msg.time_boot_ms):
                return      # a reordered straggler; its position is stale too
            L["lat"] = msg.lat / 1e7
            L["lon"] = msg.lon / 1e7
            L["alt"] = msg.alt / 1000.0  # mm -> m (MSL)
            # Height above HOME, which is a different number from `alt` and the
            # one the mission protocol actually speaks.
            #
            # Mission items go up as MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, so a
            # waypoint's z is metres above home -- but the console only ever had
            # `alt` (MSL) to seed one from, so an altitude clicked on the globe
            # meant MSL when placed and relative-to-home when PX4 flew it.
            # Measured on this vehicle: alt 206.9 MSL against relativeAlt 97.8,
            # so home is at 109 m and every waypoint authored from `alt` was
            # 109 m TOO HIGH. It is also why a "landing" taken from the
            # aircraft's own altitude ended up in the air rather than on ground.
            #
            # Exposing it lets the console author in the frame it uploads in,
            # and lets it derive home's elevation (alt - relativeAlt) so the
            # plan can still be DRAWN at the right height on an MSL globe.
            L["relativeAlt"] = msg.relative_alt / 1000.0
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
            # PX4's setpoint is the authority: this is the point the autopilot is
            # actually tracking. It no longer yields to the sim's JSON target,
            # which is projected about a different origin (TARGET_SOURCE_TTL_MS).
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

            self._mav_target_at = now   # a usable setpoint: JSON stands down
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

        elif t in ("EKF_STATUS_REPORT", "ESTIMATOR_STATUS"):
            # Healthy when attitude + horizontal velocity + absolute horizontal
            # position estimates are all valid.
            #
            # Two message names, one bitmask. EKF_STATUS_REPORT is ArduPilot's
            # message; PX4 sends ESTIMATOR_STATUS, and both carry `flags` from
            # the same ESTIMATOR_STATUS_FLAGS enum. gs listened for the ArduPilot
            # one only, so against real PX4 `ekfOk` was never set and the EKF
            # chip read as unknown for the whole flight. MEASURED on the live
            # JSBSim rig (mojave-px4 v1.16.2): ESTIMATOR_STATUS 61, EKF_STATUS_REPORT
            # 0, in a two-minute window. The stand-in sent the ArduPilot one.
            f = msg.flags
            m = mavutil.mavlink
            need = (m.ESTIMATOR_ATTITUDE | m.ESTIMATOR_VELOCITY_HORIZ
                    | m.ESTIMATOR_POS_HORIZ_ABS)
            L["ekfOk"] = (f & need) == need

        elif t == "HEARTBEAT":
            L["armed"] = bool(msg.base_mode & 128)  # MAV_MODE_FLAG_SAFETY_ARMED
            L["mode"] = decode_mode(msg.custom_mode)
            # PX4 raises system_status to CRITICAL/EMERGENCY in failsafe.
            m = mavutil.mavlink
            L["failsafe"] = msg.system_status in (m.MAV_STATE_CRITICAL, m.MAV_STATE_EMERGENCY)

    def _on_statustext(self, msg: Any) -> None:
        """Reassemble PX4's chunked status messages.

        MAVLink 2 STATUSTEXT carries 50 characters. Anything longer is split
        across several messages sharing an `id`, numbered by `chunk_seq`, and
        the receiver is expected to join them. gs ignored both fields, so the
        most important messages the autopilot sends -- the long ones, which are
        the ones that explain a refusal -- reached the operator broken mid-word
        across two log lines. MEASURED against real PX4: declining to arm sends
        id=15 chunk_seq=0 "Arming denied: Resolve system health failures firs"
        and id=15 chunk_seq=1 "t". The stand-in autopilot only ever sent short
        strings, so five passes of testing could not see this.

        id == 0 means "not chunked" and is the common case, so it costs nothing.

        On a radio, chunks get lost and reordered, which decides the rest:
        - chunks are held by seq and joined in order, so a reordered pair is
          still correct;
        - a run is flushed on its terminating chunk (a NUL, or short of the full
          50 characters), which is how the sender marks the end;
        - and a run with a hole in it is flushed anyway once it goes quiet,
          marked with an ellipsis. A dropped middle chunk must not swallow the
          whole message: a partial refusal reason beats silence, as long as the
          operator can see it is partial."""
        raw = msg.text
        text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        sev = msg.severity
        sid = int(getattr(msg, "id", 0) or 0)
        seq = int(getattr(msg, "chunk_seq", 0) or 0)

        if sid == 0:
            self._emit_statustext(sev, text)
            return

        run = self._text_runs.get(sid)
        if run is None or run["sev"] != sev:
            # A run under this id whose SEVERITY changed is a different message
            # reusing the id, so flush rather than splice two messages together.
            # A different id is left alone: ids exist so concurrent runs can
            # interleave, and flushing one because another began would truncate
            # a message that was only interleaved. Abandoned runs are the
            # timeout's job.
            if run is not None:
                self._flush_text_run(sid)
            run = self._text_runs[sid] = {"sev": sev, "chunks": {}, "at": _mono_ms()}
        run["chunks"][seq] = text
        run["at"] = _mono_ms()

        terminated = "\x00" in text or len(text.rstrip("\x00")) < STATUSTEXT_CHUNK
        if terminated or len(run["chunks"]) >= STATUSTEXT_MAX_CHUNKS:
            self._flush_text_run(sid)

    def _flush_text_run(self, sid: int) -> None:
        run = self._text_runs.pop(sid, None)
        if run is None:
            return
        seqs = sorted(run["chunks"])
        joined = "".join(run["chunks"][i] for i in seqs)
        # A gap means a chunk never arrived. Say so rather than silently
        # presenting a sentence that is missing its middle.
        gapped = seqs != list(range(len(seqs)))
        if gapped:
            joined += " \u2026(incomplete)"
        self._emit_statustext(run["sev"], joined)

    def _expire_text_runs(self) -> None:
        """Flush runs whose remaining chunks never came. Called from the service
        tick, so a lost final chunk delays a message rather than losing it."""
        now = _mono_ms()
        for sid in [k for k, r in self._text_runs.items()
                    if now - r["at"] >= STATUSTEXT_RUN_TIMEOUT_MS]:
            self._flush_text_run(sid)

    def _emit_statustext(self, severity: int, text: str) -> None:
        # `now` in the caller is monotonic (a duration clock); a statustext
        # carries a timestamp an operator reads, so stamp it off the wall clock.
        self._broadcast({"type": "statustext", "severity": severity,
                         "text": text.rstrip("\x00").strip(), "t": _now_ms()})

    def _trim_stream(self, conn: Any, t: str) -> None:
        """Ask the vehicle to stop sending a message gs never reads.

        Triggered by RECEIVING one, which makes it self-limiting and
        self-healing: if PX4 honours the request the message stops arriving and
        we stop asking, and if the vehicle reboots onto its defaults the next
        one that arrives asks again. Backs off the same way _request_message
        does, so a firmware that ignores the request costs a message a minute
        rather than one per arrival.

        The flight log loses these messages, which is the real cost. PX4's own
        onboard ulog keeps far more than this ever would, and on the radio link
        this is written for they would not have been sent at all."""
        msg_id = _TRIMMABLE.get(t)
        if msg_id is None or not self.trim_streams or self._vehicle is None:
            return
        now = _mono_ms()
        tries = self._trim_tries.get(msg_id, 0)
        wait = min(STREAM_REQ_MIN_MS * (2 ** tries), STREAM_REQ_MAX_MS)
        if now - self._trim_at.get(msg_id, 0) < wait:
            return
        self._trim_at[msg_id] = now
        self._trim_tries[msg_id] = tries + 1
        try:
            conn.mav.command_long_send(
                self._vehicle[0], self._vehicle[1],
                mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
                msg_id, -1,          # -1 = stop sending it on this channel
                0, 0, 0, 0, 0,
            )
        except Exception as exc:
            print(f"[gs] could not trim {t}: {exc}")

    def _on_mav_protocol(self, conn: Any, now: int, t: str, msg: Any) -> None:
        """The protocol state machines (statustext, param, command-ack, mission)
        and every message request. Called with the lock RELEASED, because all of
        these transmit, and a transmit can block on a real serial link."""
        if self._reboot_pending is not None:
            self._on_vehicle_reboot(now, self._reboot_pending)
            self._reboot_pending = None
        if t in _TRIMMABLE:
            self._trim_stream(conn, t)
            return      # nothing below reads these
        if t == "STATUSTEXT":
            self._on_statustext(msg)

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
            # Remember the TYPE the vehicle reports (not the value -- see
            # _start_param_set). Bounded by the vehicle's parameter count, ~720
            # on the PX4 this was measured against.
            if name and len(self._param_types) < PARAM_TYPES_MAX:
                self._param_types[name] = int(msg.param_type)
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
                    # Remember what the autopilot last asked for, so a stall
                    # retransmits that one item instead of restarting the whole
                    # upload (see _service_missions).
                    op["last_seq"] = seq
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
            # PX4 omits ACTUATOR_OUTPUT_STATUS / WIND_COV / POSITION_TARGET on
            # the GCS link by default; ask for them, and keep asking while they
            # are not ARRIVING. This used to gate on "have we ever seen one?"
            # (`latest["aileron"] is not None`), which is satisfied forever by
            # a value from a vehicle that no longer exists. MEASURED on the
            # live JSBSim rig: actuators arrived at ~1350/min for ten minutes,
            # PX4 restarted, the stream stopped dead, and gs sent not one
            # re-request for the next seventeen minutes -- the chip read
            # "stale" with no way back short of restarting gs. A reboot resets
            # the request backoff, but the gate was never consulted again.
            # Age is the only honest gate: it is also what the console shows.
            with self._lock:
                act_at = self._src_at.get("actuators", 0)
                wind_at = self._src_at.get("wind", 0)
            tsys, tcomp = msg.get_srcSystem(), msg.get_srcComponent()
            if now - act_at > STREAM_STALE_MS:
                self._request_message(conn, tsys, tcomp, MSG_ACTUATOR_OUTPUT_STATUS)
            if now - wind_at > STREAM_STALE_MS:
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
            except Exception:
                continue
            # Recorded BEFORE parsing, and whatever it is: on a flightdyn-only
            # rig this feed is the entire flight, and a feed sending malformed
            # frames is a thing somebody will need to see rather than a thing to
            # discard quietly. See FlightLog.write_json.
            if self.flight_log is not None:
                self.flight_log.write_json(data)
            try:
                obj = json.loads(data.decode("utf-8"))
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            self._apply_json(obj)

    def _apply_json(self, obj: dict[str, Any]) -> None:
        """Fold one JSON telemetry frame into `latest`, ownership rules and all.

        Lifted out of the socket loop so that replaying a recorded flight can
        use exactly this, rather than a second implementation of the same
        arbitration that would drift from it. A replay whose ownership rules
        differed from the live ones would be showing a flight that never
        happened, which is worse than having no replay at all."""
        now = _mono_ms()
        with self._lock:
            self.last_json_at = now
            # PX4 owns the setpoint whenever it is streaming one; the sim's
            # own target is projected about a different origin and would drag
            # the commanded path off by that difference.
            mav_owns_target = (now - self._mav_target_at) < TARGET_SOURCE_TTL_MS
            for k, v in obj.items():
                if k in JSON_KEYS and v is not None:
                    # Two independent gates, and neither subsumes the other.
                    # `mav_owns_target` is PX4's claim on the commanded-path
                    # overlay while it is streaming one (it measured 2310 m of
                    # error when the sim won that argument). `_json_owns` is the
                    # broader rule that a locked autopilot owns flight state at
                    # all, which the target keys are deliberately NOT part of --
                    # they stay JSON-ownable so a flightdyn-only run, where no
                    # vehicle ever locks, still draws the overlay.
                    if mav_owns_target and k in _TARGET_KEYS:
                        continue
                    if not self._json_owns(k):
                        continue
                    self.latest[k] = v
            if obj.get("targetLat") is not None and not mav_owns_target:
                # The setpoint stream is alive from SOME source, so hold off
                # re-requesting message 87. (A `_json_target_at` was kept
                # here too, as the JSON feed's claim on the overlay -- but
                # its only reader was the yield-to-JSON branch that PX4
                # ownership replaced, so the writes outlived the read.)
                self._last_target_at = now
            if any(obj.get(k) is not None for k in ("voltage", "current", "batteryRemaining")):
                self._json_battery_at = now

    def status(self) -> dict[str, Any]:
        """A snapshot of what this daemon currently believes.

        Deliberately derived, not accumulated: nothing here is a counter kept
        for the sake of this message, so asking costs nothing and the answer
        cannot drift from the behaviour it describes."""
        with self._lock:
            src_at = dict(self._src_at)
            mav_at, json_at = self.last_mav_at, self.last_json_at
        mono = _mono_ms()
        return {
            "type": "status",
            # --- what gs decided about the link ---------------------------
            "endpoint": self.active_endpoint,
            "configuredEndpoint": self.mavlink_endpoint,
            "linkBudgetBps": round(self.link_budget_bps),
            "linkBudgetPinned": self._budget_pin is not None,
            "paramFetch": ("paced" if self.link_budget_bps < PARAM_PACED_BELOW_BPS
                           else "flood"),
            # --- what it found on the other end ---------------------------
            "vehicle": list(self._vehicle) if self._vehicle else None,
            "linkState": self._link_state(mono, mav_at if mav_at else json_at),
            "dataAgeMs": (mono - (mav_at if mav_at else json_at)
                          if (mav_at or json_at) else None),
            "streamAges": {g: mono - at for g, at in src_at.items()},
            "bootMs": self.latest.get("bootMs"),
            "flightLog": (self.flight_log.status() if self.flight_log
                          else {"enabled": False, "path": None}),
            # --- what it is in the middle of ------------------------------
            "commanderHeld": self._commander is not None,
            # Whether a secret is required, never the secret itself.
            "commandTokenRequired": bool(self.command_token),
            # What gs asked the vehicle to STOP sending, so a missing message
            # in a log is attributable rather than mysterious. See _TRIMMABLE.
            "trimmedStreams": (sorted(k for k, v in _TRIMMABLE.items()
                                      if v in self._trim_at)
                               if self.trim_streams else []),
            "clients": len(self._clients),
            "pendingCommands": len(self._pending),
            "pendingParamSets": len(self._param_set_pending),
            "paramRefresh": ({"received": len(self._param_received),
                              "count": self._param_count}
                             if self._param_refresh_active else None),
            "missionOp": ({"op": self._mission["op"], "plane": self._mission["rtype"]}
                          if self._mission else None),
            # --- things that went wrong quietly ---------------------------
            # Both of these are survivable by design, which is exactly why they
            # need surfacing: a daemon that reopened the link forty times, or
            # swallowed a hundred handler exceptions, is working and is also
            # telling you something.
            "linkReopens": self.link_reopens,
            "handlerErrors": self.handler_errors,
            "upMs": mono - _MONO_ORIGIN_MS,
            "version": __version__,
            "relay": (None if self.relay is None else {
                "connected": self.relay.connected,
                "sent": self.relay.sent,
                "dropped": self.relay.dropped,
            }),
        }

    def _json_owns(self, key: str) -> bool:
        """May the flightlink JSON feed write this key? Once an autopilot is on
        the link it owns flight state; the feed keeps only JSON_ONLY_KEYS. With
        no vehicle locked (the no-PX4 rig) the feed is the only source there is
        and owns everything it sends."""
        if self._vehicle is None:
            return True
        return key in JSON_ONLY_KEYS

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

    def _token_ok(self, offered: Any) -> bool:
        """Constant-time comparison, as the relay already does for its own
        token: a timing-variable compare leaks the secret to anyone who can
        reach the port, which on a field hotspot is everyone nearby."""
        if not self.command_token:
            return True                 # unsecured by configuration, not by accident
        if not isinstance(offered, str) or not offered:
            return False
        return secrets.compare_digest(offered, self.command_token)

    async def _on_ws_message(self, ws: Any, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        mtype = msg.get("type")

        if mtype == "claim":
            # A plain claim takes authority only if it is free, and a client
            # re-claiming keeps it. `force` is an explicit takeover.
            #
            # The distinction is the whole point. The hub's premise is "join the
            # WiFi, open the page", so several people do -- and the first to
            # load held command until its socket dropped. A phone in someone's
            # pocket with the page open keeps answering gs's 5 s pings, so its
            # socket never drops, and the pilot at the laptop could not get
            # authority: every command, mission upload and param write refused,
            # with the only cure being to find that person. The console grew a
            # "Take command" button for exactly this and it re-sent a plain
            # claim, which was refused for the same reason -- a button that
            # could not do the thing it was named after.
            #
            # So: a page merely loading must never take command from someone who
            # is flying (that is what a plain claim is, and it still refuses),
            # while an operator who pressed a button that says "Take command"
            # has stated their intent and gets it. The displaced client is told,
            # so its UI can grey out rather than silently have everything
            # rejected.
            cid = msg.get("id")
            force = bool(msg.get("force", False))
            # Authority is gated HERE and nowhere else, because this is the only
            # door to it: every privileged path below already refuses anyone who
            # is not the commander, so a token checked once at the claim covers
            # commands, parameter writes, mission and fence uploads, and any
            # future one, without a list to keep in step.
            #
            # Telemetry is deliberately NOT gated. The hub's premise is "join the
            # WiFi, open the page", and someone watching the aircraft fly is the
            # point of it; what needs a secret is arming one.
            if not self._token_ok(msg.get("token")):
                print("[gs] refused a command claim with a bad or missing token")
                if cid is not None:
                    await self._send(ws, {
                        "type": "ack", "id": cid, "ok": False, "result": -1,
                        "text": "command authority needs the hub token"})
                return
            if self._commander is None or self._commander is ws:
                self._commander = ws
                if cid is not None:
                    await self._send(ws, {"type": "ack", "id": cid, "ok": True, "result": 0, "text": "commander"})
            elif force:
                displaced = self._commander
                self._commander = ws
                print("[gs] command authority taken over by another console")
                await self._send(displaced, {
                    "type": "commander", "held": False,
                    "text": "another console took command"})
                if cid is not None:
                    await self._send(ws, {"type": "ack", "id": cid, "ok": True,
                                          "result": 0, "text": "commander (taken over)"})
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

        elif mtype == "status":
            # Ask the daemon what it thinks. Read-only, open to any client, and
            # it allocates nothing: every field below is state gs already keeps.
            #
            # This exists for the field. When something is wrong during a
            # day-in-the-life run -- commands timing out, a stream missing, the
            # wrong rates on a radio -- the question is always "what did gs
            # decide?", and there was no way to ask. The answers that matter are
            # the ones gs INFERRED rather than was told: which transport it
            # found, what budget it derived from it, which vehicle it locked
            # onto, and whether it has been quietly reopening the link or
            # swallowing handler exceptions.
            await self._send(ws, self.status())

        elif mtype == "param_refresh":
            # Deliberately open to any client, and pinned as such by H22: a
            # refresh is a read, a viewer wanting to see the param table takes
            # nothing from the operator, concurrent requests dedupe, and the
            # walk is paced to a share of the link. Tightening it to the
            # commander was my first instinct and it was wrong -- that test
            # exists to catch exactly that reflex.
            #
            # What the dedupe does NOT cover is REPETITION. A walk is ~10 s on a
            # 57600 radio, and a client that asks again the moment each one
            # finishes holds 30% of the operator's link for as long as it likes,
            # with nothing the operator can do about it. So non-commanders are
            # rate-limited between walks; the commander never is, because a
            # vehicle reboot clears every parameter and re-reading immediately
            # is the correct response to it.
            cid = msg.get("id")
            if ws is not self._commander:
                since = _mono_ms() - self._param_refresh_opened_at
                if self._param_refresh_opened_at and since < PARAM_REFRESH_COOLDOWN_MS:
                    wait_s = (PARAM_REFRESH_COOLDOWN_MS - since) / 1000
                    await self._send(ws, {
                        "type": "param_progress", "id": cid, "received": 0,
                        "count": 0, "done": True,
                        "error": f"a refresh ran recently; a viewer may ask again "
                                 f"in {wait_s:.0f}s (the link is shared)"})
                    return
                self._param_refresh_opened_at = _mono_ms()
            self._param_queue.put({"kind": "refresh"})

        elif mtype == "param_set":
            # A write -> commander only, like a command.
            cid = msg.get("id")
            if ws is not self._commander:
                await self._send(ws, {"type": "param_ack", "id": cid, "name": msg.get("name"),
                                      "value": msg.get("value"), "ok": False, "text": "not commander"})
                return
            # Only route an ack back when there is an id to route it under. An
            # id-less param_set used to be filed under the key `None`, so two
            # clients sending one would cross-deliver each other's verdicts.
            # (Commander-only, so one client in practice; the mission path
            # already guards this and the two should not differ.)
            if cid is not None:
                self._pending_clients[cid] = ws
            self._param_queue.put({"kind": "set", "id": cid, "name": msg.get("name"),
                                   "value": msg.get("value"), "ptype": msg.get("ptype")})

        elif mtype == "stream":
            # Not a display preference, despite how it reads. This sends
            # SET_MESSAGE_INTERVAL, which changes what the VEHICLE transmits,
            # for every client, out of a shared and finite link budget -- and it
            # was open to any phone on the hub's WiFi. That is the H14 failure
            # with a different trigger: a careless tab asking for a fat message
            # at a high rate is the operator's commands competing for a radio
            # they were already measured to lose. The clamp above bounds the
            # damage; the authority question is separate. A write to the
            # aircraft belongs to the console that holds command, exactly like a
            # param write or a mission upload.
            cid = msg.get("id")
            if ws is not self._commander:
                if cid is not None:
                    await self._send(ws, {"type": "ack", "id": cid, "ok": False,
                                          "result": -1, "text": "not commander"})
                return
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
            if not self.command_token:
                # Said every start, not once in a README. The hub runs an open
                # WiFi on a flight line; without a token, anyone within range
                # who loads the page can arm the aircraft.
                print("[gs] NO COMMAND TOKEN SET — anyone who can reach this "
                      "port can take command and arm the vehicle. Set "
                      "GS_COMMAND_TOKEN (or --command-token) to require one.")
            interval = 1.0 / BROADCAST_HZ
            while True:
                await asyncio.sleep(interval)
                # Two clocks, deliberately: `mono` for freshness (it cannot step),
                # `wall` for the timestamp the console and the logs display.
                mono, wall = _mono_ms(), _now_ms()
                with self._lock:
                    mav_at, json_at = self.last_mav_at, self.last_json_at
                    frame = dict(self.latest)
                    src_at = dict(self._src_at)
                # A MAVLink vehicle, once seen, is the sole authority on link health:
                # the JSON feed must never keep the link green for a dead autopilot.
                # A pure flightlink run (no PX4) falls back to the JSON feed, which
                # is then genuinely the only source there is.
                last = mav_at if mav_at else json_at
                state = self._link_state(mono, last)
                frame["type"] = "telemetry"
                # `t` stays the wall clock: it is the timestamp a human and a log
                # read, and the contract has always said so.
                frame["t"] = wall
                # `upMs` is new, and is the clock a CLIENT should difference.
                # The console was throttling its HUD and sampling its history on
                # `t` -- i.e. on this hub's wall clock -- so a backward NTP step
                # froze the HUD for the length of the step. Monotonic ms since
                # the daemon started cannot step, cannot go backward, and
                # doubles as a daemon-uptime readout.
                frame["upMs"] = mono - _MONO_ORIGIN_MS
                frame["linkState"] = state
                frame["connected"] = (state == "alive")
                if self.replaying:
                    frame["replay"] = True
                # How old the newest vehicle data actually is, so the UI can say
                # "frozen 42 s ago" instead of quietly showing a stale position.
                # Both sides monotonic, so a clock step cannot make it negative.
                frame["dataAgeMs"] = (mono - last) if last else None
                # Per-group ages, so a client can tell a stopped stream from a
                # live one instead of redrawing its last value forever. A group
                # that has never been seen is simply absent -- "no wind estimate
                # yet" and "a wind estimate from four minutes ago" are different
                # things and a client should be able to say which it has.
                if src_at:
                    frame["ages"] = {g: mono - at for g, at in src_at.items()}
                payload = dumps(frame)
                if self._clients:
                    websockets.broadcast(self._clients, payload)
                if self.relay is not None:
                    self.relay.offer(payload, "telemetry")
                if state != self._last_link_state:
                    # Say it in the daemon's own log too. When the PX4 container
                    # went away under a live run, every console was told and gs's
                    # log recorded nothing -- so the operator reading the daemon
                    # (the thing `commandant logs` shows) had no line to find.
                    print(f"[gs] link {self._last_link_state} -> {state}"
                          + ("" if state == "alive" else
                             f" (no vehicle data for {(mono - last) / 1000:.0f}s)" if last else ""))
                    # lastMsgMs is documented as a wall-clock figure, so convert
                    # the monotonic watermark back rather than leak uptime into it.
                    link = dumps({"type": "link", "state": state,
                                  "lastMsgMs": (wall - (mono - last)) if last else 0})
                    if self._clients:
                        websockets.broadcast(self._clients, link)
                    if self.relay is not None:
                        self.relay.offer(link, "link")
                # Track transitions even with no clients so the next connect is correct.
                self._last_link_state = state
        finally:
            await server_cm.__aexit__(None, None, None)

    def run_replay(self, path: str, speed: float = 1.0, loop: bool = False) -> None:
        """Serve a recorded flight to the console instead of a live link.

        No MAVLink or JSON socket is opened at all: there is nothing to talk to,
        and a replay that bound the live ports would collide with the daemon
        actually flying the aircraft."""
        from .replay import replay as _replay
        self.replaying = True
        if self.flight_log is not None:
            # Recording a replay would be recording our own echo.
            self.flight_log = None
        threading.Thread(target=_replay, args=(self, path, speed, loop),
                         daemon=True).start()
        asyncio.run(self._serve())

    def run(self) -> None:
        if self.flight_log is not None:
            self.flight_log.start()
        threading.Thread(target=self._mav_loop, daemon=True).start()
        threading.Thread(target=self._json_loop, daemon=True).start()
        try:
            asyncio.run(self._serve())
        finally:
            # The tail of a log is usually the interesting part, so flush it on
            # the way out rather than leaving the last second in a buffer.
            if self.flight_log is not None:
                self.flight_log.stop()
