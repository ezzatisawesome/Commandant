"""Command path + authority + link-state tests.

A synthetic "PX4" (a pymavlink UDP endpoint) receives the COMMAND_LONG gs sends
and replies COMMAND_ACK, so we can drive a command through the WS and assert the
ack round-trips. No Docker needed.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time

import websockets

# Importing the bridge first sets MAVLINK20=1 so pymavlink loads the v2 dialect.
from gs import bridge as bridgemod
from gs.bridge import Bridge
from pymavlink import mavutil


async def _recv_until(ws, predicate, tries=200, timeout=0.5):
    for _ in range(tries):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            continue
        if predicate(msg):
            return msg
    return None


def _fake_px4(port: int, ack_result: int, stop: threading.Event) -> None:
    """Heartbeat so gs learns our address, then ACK any COMMAND_LONG we receive."""
    px4 = mavutil.mavlink_connection(f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    last_hb = 0.0
    while not stop.is_set():
        now = time.time()
        if now - last_hb > 0.1:
            px4.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_FIXED_WING, mavutil.mavlink.MAV_AUTOPILOT_PX4,
                0, 0, mavutil.mavlink.MAV_STATE_ACTIVE)
            last_hb = now
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is not None and msg.get_type() == "COMMAND_LONG":
            px4.mav.command_ack_send(msg.command, ack_result)


def test_arm_command_acked(ports):
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=_fake_px4, args=(ports["mav"], mavutil.mavlink.MAV_RESULT_ACCEPTED, stop), daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)  # let gs learn PX4's address from heartbeats
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            claim = await _recv_until(ws, lambda m: m.get("type") == "ack" and m.get("id") == "c1")
            assert claim and claim["ok"] is True

            await ws.send(json.dumps({"type": "command", "id": "a1", "name": "arm", "args": {}}))
            ack = await _recv_until(ws, lambda m: m.get("type") == "ack" and m.get("id") == "a1")
            assert ack is not None, "no ack for arm"
            assert ack["ok"] is True
            assert ack["result"] == 0
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()


def test_non_commander_rejected(ports):
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            # No claim -> command must be rejected.
            await ws.send(json.dumps({"type": "command", "id": "x1", "name": "arm", "args": {}}))
            ack = await _recv_until(ws, lambda m: m.get("type") == "ack" and m.get("id") == "x1")
            assert ack is not None
            assert ack["ok"] is False
            assert ack["text"] == "not commander"
        serve_task.cancel()

    asyncio.run(scenario())


def test_link_state_transition(monkeypatch, ports):
    # Shrink thresholds so the test is fast.
    monkeypatch.setattr(bridgemod, "STALE_MS", 200)
    monkeypatch.setattr(bridgemod, "LOST_MS", 600)

    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._json_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.2)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            # Feed one JSON frame -> traffic -> alive.
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.sendto(json.dumps({"lat": 1.0}).encode(), ("127.0.0.1", ports["json"]))
            alive = await _recv_until(ws, lambda m: m.get("linkState") == "alive")
            assert alive is not None, "never reached alive"
            # Stop feeding; after STALE_MS it must go stale.
            stale = await _recv_until(ws, lambda m: m.get("linkState") == "stale", tries=50)
            assert stale is not None, "never went stale"
        serve_task.cancel()

    asyncio.run(scenario())


def test_malformed_messages_keep_socket_and_authority(ports):
    """A bad `command` (args as a list, main=null) must be acked ok:false, not
    close the socket and silently drop our commander claim."""
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}", json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            assert (await _recv_until(ws, lambda m: m.get("id") == "c1"))["ok"] is True
            await ws.send(json.dumps({"type": "command", "id": "b1", "name": "set_mode", "args": []}))
            await ws.send(json.dumps({"type": "command", "id": "b2", "name": "set_mode", "args": {"main": None}}))
            await ws.send(json.dumps({"type": "command", "name": "arm"}))            # no id
            await ws.send(json.dumps({"type": "param_set", "id": "p1", "name": "X", "value": "nope"}))
            await ws.send(json.dumps({"type": "stream", "msgId": "x", "hz": "y"}))
            await ws.send(b"\x00\xff")                                              # binary junk
            await ws.send("[1,2,3]")
            await ws.send(json.dumps({"type": "mission_push", "id": "m1", "items": [{"kind": "waypoint", "lat": "x"}]}))
            b2 = await _recv_until(ws, lambda m: m.get("id") == "b2")
            assert b2 and b2["ok"] is False
            p1 = await _recv_until(ws, lambda m: m.get("type") == "param_ack" and m.get("id") == "p1")
            assert p1 and p1["ok"] is False
            m1 = await _recv_until(ws, lambda m: m.get("type") == "mission_ack" and m.get("id") == "m1")
            assert m1 and m1["ok"] is False
            # Still open, still commander: a well-formed command is accepted for TX.
            await ws.send(json.dumps({"type": "command", "id": "ok1", "name": "arm", "args": {}}))
            ack = await _recv_until(ws, lambda m: m.get("id") == "ok1", tries=400)
            assert ack is not None and ack["text"] != "not commander"
        serve_task.cancel()
        assert bridge.handler_errors == 0, "a malformed message reached the mav thread as an exception"

    asyncio.run(scenario())
