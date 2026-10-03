"""Mission protocol (Phase 4): upload + download round-trips against a synthetic
PX4, plus commander-gating. The upload fake deliberately requests items
out-of-order and re-requests one, to exercise the handshake's robustness. No
Docker needed.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import websockets

# Importing the bridge first sets MAVLINK20=1 so pymavlink loads the v2 dialect.
from gs.bridge import Bridge
from pymavlink import mavutil

m = mavutil.mavlink


async def _recv_until(ws, predicate, tries=300, timeout=0.5):
    for _ in range(tries):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            continue
        if predicate(msg):
            return msg
    return None


def _hb(px4, last_hb):
    now = time.time()
    if now - last_hb > 0.1:
        px4.mav.heartbeat_send(m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4, 0, 0, m.MAV_STATE_ACTIVE)
        return now
    return last_hb


def _fake_px4_upload(port: int, received: dict, stop: threading.Event) -> None:
    """On MISSION_COUNT, request items in a deliberately out-of-order plan with a
    duplicate (re-request), then MISSION_ACK once every seq has been delivered."""
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    last_hb = 0.0
    plan: list[int] = []
    idx = count = 0
    acked = False
    while not stop.is_set():
        last_hb = _hb(px4, last_hb)
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "MISSION_COUNT":
            count = msg.count
            plan = [0, 2, 1, 1] if count >= 3 else list(range(count))  # out-of-order + re-request
            idx, acked = 0, False
            received.clear()
            px4.mav.mission_request_int_send(255, 0, plan[0], 0)
        elif t == "MISSION_ITEM_INT":
            received[msg.seq] = {"lat": msg.x / 1e7, "lon": msg.y / 1e7,
                                 "cmd": msg.command, "z": msg.z}
            idx += 1
            if idx < len(plan):
                px4.mav.mission_request_int_send(255, 0, plan[idx], 0)
            elif not acked and all(s in received for s in range(count)):
                px4.mav.mission_ack_send(255, 0, 0, 0)  # MAV_MISSION_ACCEPTED
                acked = True


def _fake_px4_download(port: int, items: list[dict], stop: threading.Event) -> None:
    """Answer MISSION_REQUEST_LIST with a count, then serve each requested item."""
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    last_hb = 0.0
    while not stop.is_set():
        last_hb = _hb(px4, last_hb)
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "MISSION_REQUEST_LIST":
            px4.mav.mission_count_send(255, 0, len(items), 0)
        elif t in ("MISSION_REQUEST_INT", "MISSION_REQUEST"):
            it = items[msg.seq]
            px4.mav.mission_item_int_send(
                255, 0, msg.seq, m.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, it["cmd"], 0, 1,
                0, 0, 0, 0, int(it["lat"] * 1e7), int(it["lon"] * 1e7), it["alt"], 0)


def test_mission_upload_roundtrip():
    received: dict = {}
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:15010", json_port=15011, ws_port=8770)
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_upload, args=(15010, received, stop), daemon=True).start()

    items = [
        {"kind": "takeoff", "alt": 30},
        {"kind": "waypoint", "lat": 37.10, "lon": -122.20, "alt": 80, "params": {"acceptRadius": 50}},
        {"kind": "loiter_unlim", "lat": 37.12, "lon": -122.22, "alt": 90, "params": {"radius": 60}},
    ]

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)  # let gs learn PX4's address from heartbeats
        async with websockets.connect("ws://127.0.0.1:8770") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            assert await _recv_until(ws, lambda x: x.get("type") == "ack" and x.get("id") == "c1")
            await ws.send(json.dumps({"type": "mission_push", "id": "m1", "items": items}))
            prog = await _recv_until(ws, lambda x: x.get("type") == "mission_progress" and x.get("phase") == "upload")
            assert prog is not None, "no upload progress"
            ack = await _recv_until(ws, lambda x: x.get("type") == "mission_ack" and x.get("id") == "m1")
            assert ack is not None, "no mission_ack"
            assert ack["ok"] is True and ack["result"] == 0
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()

    assert set(received) == {0, 1, 2}, f"PX4 did not receive all items: {received}"
    assert received[0]["cmd"] == m.MAV_CMD_NAV_TAKEOFF
    assert received[1]["cmd"] == m.MAV_CMD_NAV_WAYPOINT
    assert abs(received[1]["lat"] - 37.10) < 1e-5
    assert received[2]["cmd"] == m.MAV_CMD_NAV_LOITER_UNLIM


def test_mission_download_roundtrip():
    items = [
        {"cmd": m.MAV_CMD_NAV_WAYPOINT, "lat": 37.30, "lon": -122.10, "alt": 70},
        {"cmd": m.MAV_CMD_NAV_LOITER_UNLIM, "lat": 37.33, "lon": -122.13, "alt": 100},
    ]
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:15012", json_port=15013, ws_port=8771)
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_download, args=(15012, items, stop), daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)
        async with websockets.connect("ws://127.0.0.1:8771") as ws:
            await ws.send(json.dumps({"type": "mission_pull"}))
            mission = await _recv_until(ws, lambda x: x.get("type") == "mission")
            assert mission is not None, "no mission downloaded"
            assert mission["count"] == 2
            got = mission["items"]
            assert got[0]["kind"] == "waypoint"
            assert abs(got[0]["lat"] - 37.30) < 1e-5
            assert got[1]["kind"] == "loiter_unlim"
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()


def test_mission_push_non_commander():
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:15014", json_port=15015, ws_port=8772)
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect("ws://127.0.0.1:8772") as ws:
            # No claim -> push must be rejected.
            await ws.send(json.dumps({"type": "mission_push", "id": "z1", "items": []}))
            ack = await _recv_until(ws, lambda x: x.get("type") == "mission_ack" and x.get("id") == "z1")
            assert ack is not None and ack["ok"] is False and ack["text"] == "not commander"
        serve_task.cancel()

    asyncio.run(scenario())


def test_mission_item_frames():
    """Regression (live-SITL finding): coordinate items use the global
    relative-alt frame; command-only items (rtl) MUST use MAV_FRAME_MISSION or
    PX4 rejects the whole mission as UNSUPPORTED."""
    from gs.bridge import mission_item_fields
    from pymavlink import mavutil
    m = mavutil.mavlink
    wp = mission_item_fields(1, {"kind": "waypoint", "lat": 37.4, "lon": -122.1, "alt": 80})
    assert wp["frame"] == m.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT
    rtl = mission_item_fields(2, {"kind": "rtl"})
    assert rtl["frame"] == m.MAV_FRAME_MISSION
