"""Phase 1 (commands + health + STATUSTEXT) and Phase 2 (params) tests.

Synthetic-PX4 endpoints exercise the real ingest/TX paths; no Docker needed.
"""

from __future__ import annotations

import asyncio
import json
import math
import threading
import time

import websockets

# Importing the bridge first sets MAVLINK20=1 so pymavlink loads the v2 dialect.
from gs import bridge as bridgemod
from gs.bridge import Bridge, build_command, open_connection
from pymavlink import mavutil

m = mavutil.mavlink


async def _recv_until(ws, predicate, tries=200, timeout=0.5):
    for _ in range(tries):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            continue
        if predicate(msg):
            return msg
    return None


# --- transport abstraction ---------------------------------------------------

def test_open_connection_routes_transports(monkeypatch):
    calls = []

    def fake_conn(endpoint, **kwargs):
        calls.append((endpoint, kwargs))
        return object()

    monkeypatch.setattr(bridgemod.mavutil, "mavlink_connection", fake_conn)

    gcs = {"source_system": bridgemod.GCS_SYSTEM, "source_component": bridgemod.GCS_COMPONENT}
    open_connection("serial:/dev/ttyUSB0:921600")
    assert calls[-1] == ("/dev/ttyUSB0", {"baud": 921600, **gcs})

    open_connection("serial:/dev/ttyUSB0", baud=57600)
    assert calls[-1] == ("/dev/ttyUSB0", {"baud": 57600, **gcs})

    open_connection("/dev/ttyACM0", baud=115200)
    assert calls[-1] == ("/dev/ttyACM0", {"baud": 115200, **gcs})

    open_connection("udpin:0.0.0.0:14550")
    assert calls[-1] == ("udpin:0.0.0.0:14550", gcs)


# --- command verbs -----------------------------------------------------------

def test_build_command_verbs():
    cmd, p = build_command("takeoff", {"alt": 40})
    assert cmd == m.MAV_CMD_NAV_TAKEOFF and p[6] == 40.0 and all(math.isnan(x) for x in p[3:6])

    assert build_command("land", {})[0] == m.MAV_CMD_NAV_LAND
    assert build_command("rtl", {})[0] == m.MAV_CMD_NAV_RETURN_TO_LAUNCH

    hcmd, hp = build_command("hold", {})
    assert hcmd == m.MAV_CMD_DO_SET_MODE and hp[1] == 4 and hp[2] == 3  # AUTO.LOITER

    rcmd, rp = build_command("reposition", {"lat": 37.4, "lon": -122.1, "alt": 120})
    assert rcmd == m.MAV_CMD_DO_REPOSITION and rp[4] == 37.4 and rp[5] == -122.1 and rp[6] == 120.0


# --- health + STATUSTEXT ingest ---------------------------------------------

def _fake_px4_health(port: int, stop: threading.Event) -> None:
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    while not stop.is_set():
        px4.mav.heartbeat_send(m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, m.MAV_STATE_ACTIVE)
        bits = 0x1
        px4.mav.sys_status_send(bits, bits, bits, 250, 24000, 500, 73, 0, 0, 0, 0, 0, 0)
        px4.mav.gps_raw_int_send(0, 3, 374000000, -1221000000, 100000, 100, 100, 0, 0, 12)
        px4.mav.ekf_status_report_send(
            m.ESTIMATOR_ATTITUDE | m.ESTIMATOR_VELOCITY_HORIZ | m.ESTIMATOR_POS_HORIZ_ABS,
            0.1, 0.1, 0.1, 0.1, 0.1)
        # Resend periodically so a client that connects after startup still sees it
        # (STATUSTEXT is broadcast only to currently-connected clients).
        px4.mav.statustext_send(m.MAV_SEVERITY_WARNING, b"takeoff rejected")
        time.sleep(0.1)


def test_health_fields_and_statustext(ports):
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_health, args=(ports["mav"], stop), daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            tele = await _recv_until(ws, lambda m_: m_.get("type") == "telemetry"
                                     and m_.get("gpsSats") == 12 and m_.get("ekfOk") is True)
            assert tele is not None, "health fields never populated"
            assert tele["gpsFix"] == 3
            assert tele["sysHealthy"] is True
            assert tele["batteryWarning"] is None
            st = await _recv_until(ws, lambda m_: m_.get("type") == "statustext")
            assert st is not None and "takeoff rejected" in st["text"]
            assert st["severity"] == m.MAV_SEVERITY_WARNING
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()


# --- params ------------------------------------------------------------------

_PARAMS = [("FW_AIRSPD_TRIM", 15.0), ("MPC_XY_P", 0.95), ("NAV_ACC_RAD", 10.0)]


def _fake_px4_params(port: int, stop: threading.Event) -> None:
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    store = {n: v for n, v in _PARAMS}
    names = [n for n, _ in _PARAMS]
    last_hb = 0.0
    while not stop.is_set():
        now = time.time()
        if now - last_hb > 0.1:
            px4.mav.heartbeat_send(m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, m.MAV_STATE_ACTIVE)
            last_hb = now
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "PARAM_REQUEST_LIST":
            for i, n in enumerate(names):
                px4.mav.param_value_send(n.encode(), store[n], m.MAV_PARAM_TYPE_REAL32, len(names), i)
        elif t == "PARAM_REQUEST_READ":
            i = msg.param_index
            if 0 <= i < len(names):
                px4.mav.param_value_send(names[i].encode(), store[names[i]], m.MAV_PARAM_TYPE_REAL32, len(names), i)
        elif t == "PARAM_SET":
            pid = msg.param_id
            name = pid.decode("ascii", "replace") if isinstance(pid, bytes) else str(pid)
            name = name.rstrip("\x00")
            if name in store:
                store[name] = msg.param_value
                i = names.index(name)
                px4.mav.param_value_send(name.encode(), store[name], m.MAV_PARAM_TYPE_REAL32, len(names), i)


def test_param_refresh_and_set(ports):
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_params, args=(ports["mav"], stop), daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)  # let gs learn PX4's address
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            await _recv_until(ws, lambda x: x.get("type") == "ack" and x.get("id") == "c1")

            # Refresh -> we should see each param stream in.
            await ws.send(json.dumps({"type": "param_refresh"}))
            # PARAM_VALUEs arrive coalesced in `params` batches (see PARAM_BATCH_MS).
            batch = await _recv_until(ws, lambda x: x.get("type") == "params"
                                      and any(i["name"] == "FW_AIRSPD_TRIM" for i in x["items"]))
            assert batch is not None
            trim = next(i for i in batch["items"] if i["name"] == "FW_AIRSPD_TRIM")
            assert abs(trim["value"] - 15.0) < 1e-4
            assert trim["count"] == len(_PARAMS)
            # And the refresh completes with a done marker.
            done = await _recv_until(ws, lambda x: x.get("type") == "param_progress" and x.get("done"))
            assert done is not None and done["received"] == len(_PARAMS) and "error" not in done

            # Set it -> param_ack ok, echoed with the new value.
            await ws.send(json.dumps({"type": "param_set", "id": "p1",
                                      "name": "FW_AIRSPD_TRIM", "value": 18.5,
                                      "ptype": m.MAV_PARAM_TYPE_REAL32}))
            ack = await _recv_until(ws, lambda x: x.get("type") == "param_ack" and x.get("id") == "p1")
            assert ack is not None and ack["ok"] is True
            assert abs(ack["value"] - 18.5) < 1e-4
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()


def test_param_set_not_commander(ports):
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            await ws.send(json.dumps({"type": "param_set", "id": "p9",
                                      "name": "FW_AIRSPD_TRIM", "value": 1.0}))
            ack = await _recv_until(ws, lambda x: x.get("type") == "param_ack" and x.get("id") == "p9")
            assert ack is not None and ack["ok"] is False and ack["text"] == "not commander"
        serve_task.cancel()

    asyncio.run(scenario())
