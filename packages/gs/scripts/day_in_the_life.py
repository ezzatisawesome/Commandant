#!/usr/bin/env python
"""Rehearse a whole flight day against a simulated autopilot behind a radio.

`radio_soak.py` hammers one operation at a time to find where a state machine
breaks. This does the opposite: it walks the sequence an operator actually walks,
once, in order, and reports what each step cost. It is the "is it flight ready"
question rather than "where does it break" -- and the two find different things,
because most of these steps only interact when they are done in order on one
link (a param refresh overlapping an arm is how H14 was found).

Every step is a real WS message to a real gs, driving the real protocol state
machines, against an autopilot that is deliberately indistinguishable from PX4
SITL, a HITL rig, or the airframe on the bench. Nothing here knows which.

    cd packages/gs && uv run python scripts/day_in_the_life.py
    uv run python scripts/day_in_the_life.py --loss 0.05 --net   # or on a fat pipe

Exits non-zero if any step fails, so it can gate a release.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("MAVLINK20", "1")

import websockets  # noqa: E402
from radio_soak import SIK_57600_BPS, SimAutopilot, _free_port  # noqa: E402

from gs.bridge import Bridge  # noqa: E402

HOME_LAT, HOME_LON = 37.3985511, -122.148853


class Step:
    def __init__(self, name):
        self.name, self.ok, self.secs, self.note = name, False, 0.0, ""


class Rehearsal:
    def __init__(self, ws, budget_s):
        self.ws, self.budget_s = ws, budget_s
        self.steps: list[Step] = []
        self.seen: list[dict] = []

    async def _wait(self, pred, budget=None):
        budget = budget or self.budget_s
        t0 = time.monotonic()
        while time.monotonic() - t0 < budget:
            try:
                got = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.5))
            except asyncio.TimeoutError:
                continue
            self.seen.append(got)
            if pred(got):
                return got
        return None

    async def step(self, name, send, pred, note=lambda g: ""):
        s = Step(name)
        self.steps.append(s)
        t0 = time.monotonic()
        if send is not None:
            await self.ws.send(json.dumps(send))
        got = await self._wait(pred)
        s.secs = time.monotonic() - t0
        # A reply is not a success. The first run of this script reported `ok`
        # for a param write whose ack said "timeout", because arriving was all
        # it checked -- a rehearsal that passes a failed flight is worse than no
        # rehearsal. Anything carrying `ok` or `error` is judged on it.
        s.ok = got is not None and got.get("ok", True) is not False \
            and not got.get("error")
        s.note = note(got) if got else "no reply"
        print(f"  {'ok ' if s.ok else 'FAIL'} {name:38s} {s.secs:6.2f}s  {s.note}")
        return got


def mission(n):
    items = [{"kind": "takeoff", "lat": HOME_LAT, "lon": HOME_LON, "alt": 60,
              "params": {"pitch": 10}}]
    for i in range(n - 2):
        items.append({"kind": "waypoint", "lat": HOME_LAT + 0.004 * (i + 1),
                      "lon": HOME_LON + 0.003 * (i % 3), "alt": 80,
                      "params": {"acceptRadius": 60}})
    items.append({"kind": "rtl", "lat": 0, "lon": 0, "alt": 0})
    return items


def fence():
    # A square inclusion polygon around the field, plus a keep-out circle. gs
    # derives the vertex counts (H13), so they are deliberately not sent.
    d = 0.01
    poly = [{"kind": "fence_inclusion", "lat": HOME_LAT + dy, "lon": HOME_LON + dx}
            for dy, dx in ((-d, -d), (-d, d), (d, d), (d, -d))]
    return poly + [{"kind": "fence_circle_exclusion", "lat": HOME_LAT + 0.02,
                    "lon": HOME_LON, "params": {"radius": 300}}]


async def fly(args):
    random.seed(args.seed)
    bps = 1_000_000.0 if args.net else args.bps
    ws_p, json_p = _free_port(socket.SOCK_STREAM), _free_port(socket.SOCK_DGRAM)

    # --attach points the rehearsal at a REAL autopilot -- PX4 SITL, a HITL rig,
    # or the aircraft on the bench -- instead of the stand-in. This is the whole
    # reason the stand-in is written to be indistinguishable from them: the same
    # script, the same steps, the same pass/fail, against the real thing. A tool
    # for validating against SITL that cannot be pointed at SITL is half a tool.
    px4 = None
    if args.attach:
        endpoint = args.attach
        budget = None if args.net else bps      # let gs infer it from a real link
    else:
        mav_p = _free_port(socket.SOCK_DGRAM)
        px4 = SimAutopilot(mav_p, (bps, 0.0 if args.net else args.latency, args.loss)).start()
        endpoint = f"udpin:127.0.0.1:{mav_p}"
        budget = bps
    b = Bridge(mavlink_endpoint=endpoint,
               json_port=json_p, ws_port=ws_p, budget_bps=budget)
    threading.Thread(target=b._mav_loop, daemon=True).start()
    serve = asyncio.create_task(b._serve())
    await asyncio.sleep(0.4)

    link = (f"REAL autopilot on {args.attach}" if args.attach
            else "a simulated fat pipe (SITL / HITL / USB)" if args.net
            else f"simulated {bps:.0f} B/s, {args.latency * 1000:.0f} ms, {args.loss:.0%} loss")
    print(f"\nA day in the life — link: {link}\n")
    try:
        async with websockets.connect(f"ws://127.0.0.1:{ws_p}") as ws:
            r = Rehearsal(ws, args.budget)

            print(" pre-flight")
            await r.step("link comes up on its own", None,
                         lambda g: g.get("linkState") == "alive",
                         lambda g: f"dataAge {g['dataAgeMs']} ms, {b.active_endpoint}")
            await r.step("take command", {"type": "claim", "id": "k"},
                         lambda g: g.get("type") == "ack" and g.get("id") == "k",
                         lambda g: g["text"])
            await r.step("read the params", {"type": "param_refresh"},
                         lambda g: g.get("type") == "param_progress" and g.get("done"),
                         lambda g: f"{g['received']}/{g['count']}"
                                   + (f" ERROR {g['error']}" if g.get("error") else ""))
            await r.step("set a param", {"type": "param_set", "id": "p1",
                                         "name": "FW_AIRSPD_TRIM", "value": 15.0, "ptype": 9},
                         lambda g: g.get("type") == "param_ack" and g.get("id") == "p1",
                         lambda g: g["text"])

            print(" plan")
            await r.step("upload the geofence",
                         {"type": "fence_push", "id": "f1", "items": fence()},
                         lambda g: g.get("type") == "fence_ack" and g.get("id") == "f1",
                         lambda g: g["text"])
            await r.step("read the fence back", {"type": "fence_pull"},
                         lambda g: g.get("type") == "fence",
                         lambda g: f"{g['count']} items, "
                                   f"vertexCount={g['items'][0].get('params', {}).get('vertexCount')}")
            await r.step("upload the mission",
                         {"type": "mission_push", "id": "m1", "items": mission(args.items)},
                         lambda g: g.get("type") == "mission_ack" and g.get("id") == "m1",
                         lambda g: g["text"])
            await r.step("read the mission back", {"type": "mission_pull"},
                         lambda g: g.get("type") == "mission",
                         lambda g: f"{g['count']} items")

            print(" fly")
            if args.wait_ready:
                # Real PX4 refuses to arm until its estimator has a position and
                # a home, which takes tens of seconds into a fresh SITL run.
                # Without this the first --attach run reports FAIL for `arm` and
                # looks like a Commandant bug, when the honest reading is "the
                # aircraft was not ready yet". Waits for what the autopilot
                # itself says, rather than sleeping a guessed interval.
                await r.step("wait until the vehicle is armable", None,
                             lambda g: (g.get("type") == "telemetry"
                                        and g.get("ekfOk") is True
                                        and (g.get("gpsFix") or 0) >= 3),
                             lambda g: f"ekfOk, gps fix {g.get('gpsFix')} "
                                       f"({g.get('gpsSats')} sats)")
            await r.step("arm", {"type": "command", "id": "a1", "name": "arm"},
                         lambda g: g.get("type") == "ack" and g.get("id") == "a1",
                         lambda g: g["text"])
            await r.step("the console sees it armed", None,
                         lambda g: g.get("type") == "telemetry" and g.get("armed"),
                         lambda g: f"mode {g.get('mode')}")
            await r.step("switch to AUTO.MISSION",
                         {"type": "command", "id": "s1", "name": "set_mode",
                          "args": {"main": 4, "sub": 4}},
                         lambda g: g.get("type") == "ack" and g.get("id") == "s1",
                         lambda g: g["text"])
            await r.step("mission progress arrives", None,
                         lambda g: g.get("type") == "mission_reached",
                         lambda g: f"reached item {g['seq']}")
            await r.step("fly-to-here mid-mission",
                         {"type": "command", "id": "r1", "name": "reposition",
                          "args": {"lat": HOME_LAT + 0.01, "lon": HOME_LON, "alt": 90}},
                         lambda g: g.get("type") == "ack" and g.get("id") == "r1",
                         lambda g: g["text"])

            if args.reboot and px4 is None:
                print(" (--reboot needs the stand-in; power-cycle the real one"
                      " yourself and watch for the `vehicle_reboot` step)")
            if args.reboot and px4 is not None:
                print(" the autopilot restarts mid-mission")
                px4.reboot_now = True
                await r.step("gs reports the reboot", None,
                             lambda g: g.get("type") == "vehicle_reboot",
                             lambda g: f"bootMs {g['bootMs']}, aborted {g['aborted']}")
                await r.step("telemetry resumes on its own", None,
                             lambda g: (g.get("type") == "telemetry"
                                        and g.get("linkState") == "alive"
                                        and (g.get("bootMs") or 10 ** 9) < 5000),
                             lambda g: f"bootMs {g.get('bootMs')}, "
                                       f"dataAge {g.get('dataAgeMs')} ms")
                await r.step("still commandable after the reboot",
                             {"type": "command", "id": "a2", "name": "arm"},
                             lambda g: g.get("type") == "ack" and g.get("id") == "a2",
                             lambda g: g["text"])

            print(" come home")
            await r.step("RTL", {"type": "command", "id": "h1", "name": "rtl"},
                         lambda g: g.get("type") == "ack" and g.get("id") == "h1",
                         lambda g: g["text"])
            await r.step("the console sees AUTO.RTL", None,
                         lambda g: g.get("type") == "telemetry" and g.get("mode") == "AUTO.RTL",
                         lambda g: f"mode {g['mode']}")
            await r.step("disarm", {"type": "command", "id": "d1", "name": "disarm"},
                         lambda g: g.get("type") == "ack" and g.get("id") == "d1",
                         lambda g: g["text"])
            await r.step("the console sees it disarmed", None,
                         lambda g: g.get("type") == "telemetry" and g.get("armed") is False,
                         lambda g: "armed=false")

            # What did the daemon decide? This is the question a field failure
            # always comes down to, so the rehearsal ends by asking it.
            st = await r.step("ask the daemon what it decided", {"type": "status"},
                              lambda g: g.get("type") == "status",
                              lambda g: f"{g['endpoint']} @ {g['linkBudgetBps']} B/s, "
                                        f"params={g['paramFetch']}, vehicle={g['vehicle']}")

            frames = [g for g in r.seen if g.get("type") == "telemetry"]
            ages = [g.get("ages", {}) for g in frames if g.get("ages")]
            print("\n over the whole run")
            print(f"  telemetry frames seen         {len(frames)}")
            print(f"  frames carrying per-stream ages {len(ages)}")
            if ages:
                print(f"  stream groups reported        {sorted(ages[-1])}")
            print(f"  link reopens                  {b.link_reopens}")
            print(f"  swallowed handler errors      {b.handler_errors}")
            if px4 is not None:
                print(f"  GCS heartbeats PX4 received   {px4.gcs_heartbeats}"
                      + ("" if px4.gcs_heartbeats
                         else "   <-- PX4 would call the datalink lost"))
                print(f"  radio frames dropped          {px4.radio.dropped}")
            if st:
                print(f"  gs says                       "
                      f"up {st['upMs'] / 1000:.0f}s, {st['clients']} client(s), "
                      f"{st['linkReopens']} reopen(s), "
                      f"{st['handlerErrors']} handler error(s)")
            bad = [s for s in r.steps if not s.ok]
            print()
            if bad:
                print(f"FAILED {len(bad)}/{len(r.steps)}: " + ", ".join(s.name for s in bad))
            else:
                print(f"all {len(r.steps)} steps ok — "
                      f"{sum(s.secs for s in r.steps):.1f}s for the whole day")
            if b.handler_errors:
                print(f"NOTE: {b.handler_errors} handler errors were swallowed; check the log")
            return 1 if (bad or b.handler_errors) else 0
    finally:
        if px4 is not None:
            px4.stop()
        serve.cancel()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bps", type=float, default=SIK_57600_BPS)
    ap.add_argument("--latency", type=float, default=0.12)
    ap.add_argument("--loss", type=float, default=0.0)
    ap.add_argument("--items", type=int, default=12, help="mission items")
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--budget", type=float, default=45.0, help="per-step budget, seconds")
    ap.add_argument("--wait-ready", action="store_true",
                    help="before arming, wait for the autopilot to report a valid "
                         "EKF and a 3D GPS fix. Use this with --attach against a "
                         "real PX4, which refuses to arm for tens of seconds into "
                         "a fresh run -- otherwise `arm` fails and reads as a "
                         "Commandant bug rather than an aircraft that is not ready.")
    ap.add_argument("--attach", default="", metavar="ENDPOINT",
                    help="drive a REAL autopilot instead of the stand-in: an "
                         "endpoint gs understands (`auto`, udpin:0.0.0.0:14550 for "
                         "PX4 SITL, serial:/dev/ttyACM0:115200 for one over USB). "
                         "The link model is not simulated in this mode.")
    ap.add_argument("--reboot", action="store_true",
                    help="restart the autopilot mid-mission and check the recovery")
    ap.add_argument("--net", action="store_true",
                    help="run on a fat pipe instead of the radio model")
    return asyncio.run(fly(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
