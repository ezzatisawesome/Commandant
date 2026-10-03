"""Phase 0 smoke test: feed a flightlink JSON frame in on UDP and read the
merged telemetry frame back over the WebSocket, plus unit checks on the pure
decode helpers. Does not require PX4/MAVLink."""

from __future__ import annotations

import asyncio
import json
import socket
import threading

import websockets

from gs.bridge import Bridge, decode_mode, pwm_pct


def test_pwm_pct():
    assert pwm_pct(1500) == 0
    assert pwm_pct(2000) == 100
    assert pwm_pct(1000) == -100
    assert pwm_pct(3000) == 100   # clamped
    assert pwm_pct(0) == -100     # clamped


def test_decode_mode():
    assert decode_mode(1 << 16) == "MANUAL"
    # main=AUTO(4), sub=TAKEOFF(2) / LOITER(3)
    assert decode_mode((4 << 16) | (2 << 24)) == "AUTO.TAKEOFF"
    assert decode_mode((4 << 16) | (3 << 24)) == "AUTO.LOITER"


def test_json_to_ws_roundtrip():
    # Use ports unlikely to collide with a running instance.
    bridge = Bridge(mavlink_endpoint="udpin:127.0.0.1:0", json_port=14999, ws_port=8799)
    # Run only the JSON ingest + WS egress (skip MAVLink, which needs a real link).
    threading.Thread(target=bridge._json_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)  # let the WS server bind
        async with websockets.connect("ws://127.0.0.1:8799") as ws:
            # Send a flightlink-style JSON telemetry datagram.
            frame = {"lat": 37.4, "lon": -122.1, "airspeed": 14.2, "mode": "AUTO.LOITER",
                     "genW": 120.0, "voltage": 24.3}
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.sendto(json.dumps(frame).encode(), ("127.0.0.1", 14999))

            # Read frames until the JSON values land (first tick may predate ingest).
            got = None
            for _ in range(20):
                got = json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
                if got.get("lat") == 37.4:
                    break
            assert got is not None
            assert got["lat"] == 37.4
            assert got["airspeed"] == 14.2
            assert got["mode"] == "AUTO.LOITER"
            assert got["genW"] == 120.0
            assert got["connected"] is True  # just saw traffic
            assert "t" in got
        serve_task.cancel()

    asyncio.run(scenario())
