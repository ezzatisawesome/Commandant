"""Publish a synthetic flight to the relay — a hub stand-in.

Flies a circle at altitude so the globe, HUD, trail and setpoint overlay can be
checked end to end without PX4. Useful for working on the hosted viewer, and for
smoke-testing a relay deployment:

    python scripts/fake_hub.py --url ws://127.0.0.1:8791/publish --token devtoken
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time

import websockets

HOME_LAT, HOME_LON = 37.4133, -122.0575   # Mountain View, matching the sim's home
RADIUS_M = 400.0
ALT_M = 320.0
SPEED_MPS = 18.0
M_PER_DEG = 111_320.0


async def fly(url: str, token: str, hz: float, flight_id: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        print(f"[fake-hub] publishing {flight_id} to {url} at {hz:g} Hz")
        await ws.send(json.dumps({"type": "flight", "id": flight_id,
                                  "startedAt": int(time.time() * 1000)}))
        # A plan for the globe to draw, as a real hub would have uploaded.
        await ws.send(json.dumps({"type": "mission", "count": 3, "items": [
            {"seq": 0, "kind": "takeoff", "lat": HOME_LAT, "lon": HOME_LON, "alt": 120},
            {"seq": 1, "kind": "loiter_unlim", "lat": HOME_LAT + 0.004,
             "lon": HOME_LON + 0.004, "alt": 320, "params": {"radius": 400}},
            {"seq": 2, "kind": "rtl"},
        ]}))
        await ws.send(json.dumps({"type": "statustext", "severity": 6,
                                  "text": "synthetic flight started",
                                  "t": int(time.time() * 1000)}))

        omega = SPEED_MPS / RADIUS_M            # rad/s around the orbit
        t0 = time.monotonic()
        n = 0
        while True:
            t = time.monotonic() - t0
            a = omega * t
            lat = HOME_LAT + (RADIUS_M * math.cos(a)) / M_PER_DEG
            lon = HOME_LON + (RADIUS_M * math.sin(a)) / (
                M_PER_DEG * math.cos(math.radians(HOME_LAT)))
            # Heading is the orbit tangent; bank follows a coordinated turn.
            heading = (math.degrees(a) + 90.0) % 360.0
            bank = math.atan((SPEED_MPS ** 2) / (RADIUS_M * 9.81))
            sun = 0.5 + 0.5 * math.sin(t / 120.0)   # fake day/night sweep
            frame = {
                "type": "telemetry",
                "t": int(time.time() * 1000),
                "connected": True, "linkState": "alive",
                "lat": lat, "lon": lon, "alt": ALT_M + 8 * math.sin(t / 7),
                "roll": bank, "pitch": 0.04 * math.sin(t / 5), "yaw": math.radians(heading),
                "heading": heading,
                "airspeed": SPEED_MPS + 0.6 * math.sin(t / 3),
                "groundspeed": SPEED_MPS, "throttle": 46 + 4 * math.sin(t / 11),
                "mode": "AUTO.MISSION", "armed": True,
                "voltage": 24.6 - 0.4 * (t / 600), "current": 7.4,
                "batteryRemaining": max(5, int(96 - t / 30)),
                "genW": 180 * sun, "loadW": 150.0, "propW": 120.0,
                "irradiance": 900 * sun,
                "sunEpochMs": int(time.time() * 1000),
                "ekfOk": True, "gpsFix": 3, "gpsSats": 14,
                "sysHealthy": True, "failsafe": False, "batteryWarning": None,
                "aileron": 12 * math.sin(t / 4), "elevator": -4.0, "rudder": 0,
                # Setpoint slightly ahead on the orbit, as PX4 would command.
                "targetLat": HOME_LAT + (RADIUS_M * math.cos(a + 0.25)) / M_PER_DEG,
                "targetLon": HOME_LON + (RADIUS_M * math.sin(a + 0.25)) / (
                    M_PER_DEG * math.cos(math.radians(HOME_LAT))),
                "targetAlt": ALT_M,
            }
            await ws.send(json.dumps(frame))
            n += 1
            if n % (int(hz) * 10 or 1) == 0:
                print(f"[fake-hub] {n} frames, t={t:.0f}s")
            await asyncio.sleep(1.0 / hz)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://127.0.0.1:8791/publish")
    p.add_argument("--token", default="devtoken")
    p.add_argument("--hz", type=float, default=5.0)
    p.add_argument("--flight-id", default="synthetic-demo")
    a = p.parse_args()
    try:
        asyncio.run(fly(a.url, a.token, a.hz, a.flight_id))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
