"""Geofence + rally (Phase 4 extension): the mission handshake generalized by
mission_type. Upload + download round-trips against a synthetic PX4 that asserts
the correct mission_type on the wire. No Docker needed.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import websockets

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


def _fake_px4_upload(port: int, received: dict, seen_type: dict, stop: threading.Event) -> None:
    """Request items in order and MISSION_ACK, echoing the mission_type back so we
    can assert the plane (mission/fence/rally) was set correctly on the wire."""
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    last_hb = 0.0
    count = idx = 0
    mtype = 0
    acked = False
    while not stop.is_set():
        last_hb = _hb(px4, last_hb)
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "MISSION_COUNT":
            count = msg.count
            mtype = getattr(msg, "mission_type", 0)
            seen_type["count"] = mtype
            idx, acked = 0, False
            received.clear()
            if count:
                px4.mav.mission_request_int_send(255, 0, 0, mtype)
            else:
                px4.mav.mission_ack_send(255, 0, 0, mtype)
        elif t == "MISSION_ITEM_INT":
            received[msg.seq] = {"cmd": msg.command, "frame": msg.frame, "p1": msg.param1,
                                 "lat": msg.x / 1e7, "lon": msg.y / 1e7,
                                 "mtype": getattr(msg, "mission_type", 0)}
            idx += 1
            if idx < count:
                px4.mav.mission_request_int_send(255, 0, idx, mtype)
            elif not acked:
                px4.mav.mission_ack_send(255, 0, 0, mtype)  # ACCEPTED, same plane
                acked = True


def _fake_px4_download(port: int, items: list[dict], mtype: int, seen_type: dict,
                       stop: threading.Event) -> None:
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    last_hb = 0.0
    while not stop.is_set():
        last_hb = _hb(px4, last_hb)
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "MISSION_REQUEST_LIST":
            seen_type["list"] = getattr(msg, "mission_type", 0)
            px4.mav.mission_count_send(255, 0, len(items), mtype)
        elif t in ("MISSION_REQUEST_INT", "MISSION_REQUEST"):
            it = items[msg.seq]
            px4.mav.mission_item_int_send(
                255, 0, msg.seq, m.MAV_FRAME_GLOBAL, it["cmd"], 0, 1,
                it.get("p1", 0), 0, 0, 0, int(it["lat"] * 1e7), int(it["lon"] * 1e7), 0, mtype)


def test_fence_upload_roundtrip():
    received: dict = {}
    seen: dict = {}
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:15020", json_port=15021, ws_port=8780)
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_upload, args=(15020, received, seen, stop), daemon=True).start()

    # A 3-vertex inclusion polygon + one circular exclusion.
    items = [
        {"kind": "fence_inclusion", "lat": 37.40, "lon": -122.20, "params": {"vertexCount": 3}},
        {"kind": "fence_inclusion", "lat": 37.41, "lon": -122.20, "params": {"vertexCount": 3}},
        {"kind": "fence_inclusion", "lat": 37.41, "lon": -122.19, "params": {"vertexCount": 3}},
        {"kind": "fence_circle_exclusion", "lat": 37.405, "lon": -122.195, "params": {"radius": 50}},
    ]

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)
        async with websockets.connect("ws://127.0.0.1:8780") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            assert await _recv_until(ws, lambda x: x.get("type") == "ack" and x.get("id") == "c1")
            await ws.send(json.dumps({"type": "fence_push", "id": "f1", "items": items}))
            ack = await _recv_until(ws, lambda x: x.get("type") == "fence_ack" and x.get("id") == "f1")
            assert ack is not None, "no fence_ack"
            assert ack["ok"] is True and ack["result"] == 0
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()

    assert seen.get("count") == m.MAV_MISSION_TYPE_FENCE, "MISSION_COUNT not on the FENCE plane"
    assert set(received) == {0, 1, 2, 3}
    assert received[0]["cmd"] == m.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION
    assert received[0]["p1"] == 3          # vertexCount
    assert received[0]["frame"] == m.MAV_FRAME_GLOBAL
    assert all(r["mtype"] == m.MAV_MISSION_TYPE_FENCE for r in received.values())
    assert received[3]["cmd"] == m.MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION
    assert received[3]["p1"] == 50          # radius


def test_rally_upload_roundtrip():
    received: dict = {}
    seen: dict = {}
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:15022", json_port=15023, ws_port=8781)
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_upload, args=(15022, received, seen, stop), daemon=True).start()

    items = [
        {"kind": "rally", "lat": 37.50, "lon": -122.30, "alt": 60},
        {"kind": "rally", "lat": 37.52, "lon": -122.32, "alt": 60},
    ]

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)
        async with websockets.connect("ws://127.0.0.1:8781") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            assert await _recv_until(ws, lambda x: x.get("type") == "ack" and x.get("id") == "c1")
            await ws.send(json.dumps({"type": "rally_push", "id": "r1", "items": items}))
            ack = await _recv_until(ws, lambda x: x.get("type") == "rally_ack" and x.get("id") == "r1")
            assert ack is not None and ack["ok"] is True
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()

    assert seen.get("count") == m.MAV_MISSION_TYPE_RALLY
    assert set(received) == {0, 1}
    assert all(r["cmd"] == m.MAV_CMD_NAV_RALLY_POINT for r in received.values())
    assert all(r["mtype"] == m.MAV_MISSION_TYPE_RALLY for r in received.values())


def test_fence_download_roundtrip():
    items = [
        {"cmd": m.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION, "lat": 37.40, "lon": -122.20, "p1": 3},
        {"cmd": m.MAV_CMD_NAV_FENCE_CIRCLE_EXCLUSION, "lat": 37.405, "lon": -122.195, "p1": 50},
    ]
    seen: dict = {}
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:15024", json_port=15025, ws_port=8782)
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4_download,
                     args=(15024, items, m.MAV_MISSION_TYPE_FENCE, seen, stop), daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)
        async with websockets.connect("ws://127.0.0.1:8782") as ws:
            await ws.send(json.dumps({"type": "fence_pull"}))
            fence = await _recv_until(ws, lambda x: x.get("type") == "fence")
            assert fence is not None, "no fence downloaded"
            assert fence["count"] == 2
            assert fence["items"][0]["kind"] == "fence_inclusion"
            assert fence["items"][0]["params"]["vertexCount"] == 3
            assert fence["items"][1]["kind"] == "fence_circle_exclusion"
            assert fence["items"][1]["params"]["radius"] == 50
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()

    assert seen.get("list") == m.MAV_MISSION_TYPE_FENCE, "REQUEST_LIST not on the FENCE plane"
