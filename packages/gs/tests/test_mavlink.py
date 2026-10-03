"""MAVLink -> WS decode path: synthesize real MAVLink 2 packets with pymavlink,
feed them to the daemon's UDP input, and assert the decoded WebSocket frame.

Exercises the exact ingest path (recv_match on real bytes, per-message decode,
source arbitration) without needing Docker/PX4. Mirrors how PX4 SITL unicasts its
GCS stream to the daemon's port.
"""

from __future__ import annotations

import asyncio
import json
import math
import threading
import time

import websockets

# Importing the bridge first sets MAVLINK20=1, so pymavlink loads the v2 dialect.
from gs.bridge import Bridge
from pymavlink import mavutil

GS_MAV_PORT = 14998
GS_WS_PORT = 8798


def _sender():
    return mavutil.mavlink_connection(
        f"udpout:127.0.0.1:{GS_MAV_PORT}", source_system=1, source_component=1
    )


def test_mavlink_to_ws_decode():
    bridge = Bridge(
        mavlink_endpoint=f"udpin:127.0.0.1:{GS_MAV_PORT}",
        json_port=14997,  # unused here
        ws_port=GS_WS_PORT,
    )
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        tx = _sender()

        def blast(boot_ms: int) -> None:
            mav = tx.mav
            # AUTO.LOITER (main=4, sub=3), armed.
            custom_mode = (4 << 16) | (3 << 24)
            mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_FIXED_WING,
                mavutil.mavlink.MAV_AUTOPILOT_PX4,
                mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED, custom_mode,
                mavutil.mavlink.MAV_STATE_ACTIVE,
            )
            mav.global_position_int_send(
                boot_ms, int(37.4 * 1e7), int(-122.1 * 1e7),
                1000 * 1000, 50 * 1000, 0, 0, 0, int(90.0 * 100),
            )
            mav.attitude_send(boot_ms, 0.1, -0.2, 1.57, 0, 0, 0)
            mav.vfr_hud_send(14.2, 15.0, 90, 42, 100.0, 0.0)
            # voltages[0]=24300 mV -> 24.3 V; current 250 cA -> 2.5 A; 87 %.
            mav.battery_status_send(
                0, mavutil.mavlink.MAV_BATTERY_FUNCTION_ALL,
                mavutil.mavlink.MAV_BATTERY_TYPE_LIPO, 32767,
                [24300] + [65535] * 9, 250, -1, -1, 87,
            )
            # idx5=1500µs(0%), idx6=2000µs(+100%) -> aileron 50; idx7=1000µs -> elevator -100.
            actuator = [0.0] * 32
            actuator[5], actuator[6], actuator[7] = 1500.0, 2000.0, 1000.0
            mav.actuator_output_status_send(int(time.time() * 1e6), 0xFF, actuator)

        async with websockets.connect(f"ws://127.0.0.1:{GS_WS_PORT}") as ws:
            got = {}
            boot = 1000
            for _ in range(40):
                blast(boot)
                boot += 100
                try:
                    got = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.5))
                except asyncio.TimeoutError:
                    continue
                if got.get("mode") == "AUTO.LOITER" and got.get("lat") is not None:
                    # give the burst a moment so later messages (battery/actuator) land
                    await asyncio.sleep(0.1)
                    blast(boot); boot += 100
                    got = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.5))
                    break

        serve_task.cancel()
        return got

    got = asyncio.run(scenario())

    assert got.get("mode") == "AUTO.LOITER"
    assert got.get("armed") is True
    assert abs(got["lat"] - 37.4) < 1e-4
    assert abs(got["lon"] - (-122.1)) < 1e-4
    assert abs(got["alt"] - 1000.0) < 1e-3
    assert abs(got["roll"] - 0.1) < 1e-3
    assert abs(got["pitch"] - (-0.2)) < 1e-3
    assert abs(got["airspeed"] - 14.2) < 1e-2
    assert abs(got["voltage"] - 24.3) < 1e-3
    assert abs(got["current"] - 2.5) < 1e-3
    assert got["batteryRemaining"] == 87
    assert abs(got["aileron"] - 50.0) < 1e-6
    assert abs(got["elevator"] - (-100.0)) < 1e-6
    assert got["connected"] is True
