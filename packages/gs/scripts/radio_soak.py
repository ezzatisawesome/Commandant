#!/usr/bin/env python
"""Run gs's real protocol state machines across a simulated telemetry radio.

Every timeout and retry constant in `bridge.py` was tuned against localhost
UDP, where latency is ~0, loss is 0 and bandwidth is irrelevant. The hub's link
is none of those things. This drives the actual command / param / mission
handshakes through a link with configurable bandwidth, one-way latency and
packet loss, and reports what completes and how long it takes.

It is a soak tool, not a unit test -- a run takes minutes and is stochastic, so
it is deliberately outside the pytest suite. Use it when changing a protocol
state machine or any of the timing constants.

    cd packages/gs && uv run python scripts/radio_soak.py
    uv run python scripts/radio_soak.py --bps 3456 --latency 0.12 --loss 0.1 \
        --items 40 --seeds 1,2,3

It found the mission-upload restart livelock: at 5 % loss a 40-item upload sent
39 MISSION_COUNT kickoffs and never completed, with no timeout ever reported,
because each restart counted as progress and reset the retry budget.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import os
import random
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
os.environ.setdefault("MAVLINK20", "1")

import websockets  # noqa: E402
from pymavlink import mavutil  # noqa: E402

from gs.bridge import MISSION_MAX_TRIES, Bridge  # noqa: E402

m = mavutil.mavlink

# A SiK radio at 57600 air rate, after its own framing/ECC/duty cycle. Matches
# bridge.link_budget_bps's model of the same link.
SIK_57600_BPS = 3456
FRAME_BYTES = 60   # a representative MAVLink 2 frame, for the token bucket


class Radio:
    """Token-bucket bandwidth + one-way latency + loss, on the autopilot side."""

    def __init__(self, conn, bps: float, latency_s: float, loss: float):
        self.conn, self.bps, self.latency_s, self.loss = conn, bps, latency_s, loss
        self.q: collections.deque = collections.deque()
        self.sent_bytes = 0
        self.dropped = 0
        self._lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()

    def send(self, fn: str, *a) -> None:
        if random.random() < self.loss:
            self.dropped += 1
            return
        with self._lock:
            self.q.append((time.monotonic() + self.latency_s, fn, a))

    def _pump(self) -> None:
        tokens, last = 0.0, time.monotonic()
        while True:
            now = time.monotonic()
            tokens = min(self.bps * 0.5, tokens + (now - last) * self.bps)
            last = now
            with self._lock:
                item = self.q.popleft() if (self.q and self.q[0][0] <= now) else None
            if item is None:
                time.sleep(0.005)
                continue
            _, fn, a = item
            while tokens < FRAME_BYTES:
                time.sleep(0.005)
                now = time.monotonic()
                tokens = min(self.bps * 0.5, tokens + (now - last) * self.bps)
                last = now
            tokens -= FRAME_BYTES
            self.sent_bytes += FRAME_BYTES
            try:
                getattr(self.conn.mav, fn)(*a)
            except Exception as exc:
                print(f"  [sim] tx error: {exc}")


class SimAutopilot:
    """Enough PX4 to exercise the handshakes: heartbeat + position, COMMAND_ACK,
    the param list/read/set replies, and the mission upload pull sequence. It is
    deliberately indistinguishable from HITL or a real airframe, which is the
    property gs is built on."""

    def __init__(self, gs_port: int, radio: tuple[float, float, float], n_params: int = 400):
        self.conn = mavutil.mavlink_connection(
            f"udpout:127.0.0.1:{gs_port}", source_system=1, source_component=1)
        self.radio = Radio(self.conn, *radio)
        self.loss = radio[2]
        self.armed = False
        self.mission: dict[int, object] = {}
        self.mission_expect: int | None = None
        self.kickoffs = 0
        self.params = {f"P_{i:03d}": float(i) for i in range(n_params)}
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._tx, daemon=True).start()
        threading.Thread(target=self._rx, daemon=True).start()
        return self

    def stop(self):
        self._stop.set()

    def _tx(self):
        boot = 0
        while not self._stop.is_set():
            boot += 200
            self.radio.send("heartbeat_send", m.MAV_TYPE_FIXED_WING, m.MAV_AUTOPILOT_PX4,
                            128 if self.armed else 0, (4 << 16) | (4 << 24),
                            m.MAV_STATE_ACTIVE)
            self.radio.send("global_position_int_send", boot, 374000000, -1221000000,
                            120000, 9000, 1500, 0, 0, 9000)
            time.sleep(0.2)

    def _rx(self):
        while not self._stop.is_set():
            msg = self.conn.recv_match(blocking=True, timeout=0.2)
            if msg is None or random.random() < self.loss:   # uplink loss
                continue
            t = msg.get_type()
            if t == "COMMAND_LONG":
                if msg.command == m.MAV_CMD_SET_MESSAGE_INTERVAL:
                    continue
                if msg.command == m.MAV_CMD_COMPONENT_ARM_DISARM:
                    self.armed = bool(msg.param1)
                self.radio.send("command_ack_send", msg.command, m.MAV_RESULT_ACCEPTED)
            elif t == "PARAM_REQUEST_LIST":
                for i, (n, v) in enumerate(sorted(self.params.items())):
                    self.radio.send("param_value_send", n.encode(), v,
                                    m.MAV_PARAM_TYPE_REAL32, len(self.params), i)
            elif t == "PARAM_REQUEST_READ":
                names = sorted(self.params)
                if 0 <= msg.param_index < len(names):
                    n = names[msg.param_index]
                    self.radio.send("param_value_send", n.encode(), self.params[n],
                                    m.MAV_PARAM_TYPE_REAL32, len(names), msg.param_index)
            elif t == "MISSION_COUNT":
                # A MISSION_COUNT mid-transfer discards everything and restarts,
                # per the MAVLink mission protocol. This is the behaviour that
                # made the pre-fix retry livelock.
                self.kickoffs += 1
                self.mission = {}
                self.mission_expect = msg.count
                self.radio.send("mission_request_int_send", 255, 190, 0, msg.mission_type)
            elif t == "MISSION_ITEM_INT":
                self.mission[msg.seq] = msg
                if len(self.mission) >= (self.mission_expect or 0):
                    self.radio.send("mission_ack_send", 255, 190, 0, msg.mission_type)
                else:
                    nxt = next(s for s in range(self.mission_expect)
                               if s not in self.mission)
                    self.radio.send("mission_request_int_send", 255, 190, nxt,
                                    msg.mission_type)


def _free_port(kind):
    with socket.socket(socket.AF_INET, kind) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def soak(bps, latency_s, loss, n_items, seed, budget_s=120.0):
    random.seed(seed)
    mav_p, ws_p, json_p = (_free_port(socket.SOCK_DGRAM), _free_port(socket.SOCK_STREAM),
                           _free_port(socket.SOCK_DGRAM))
    px4 = SimAutopilot(mav_p, (bps, latency_s, loss)).start()
    # budget_bps matters: the simulated radio sits between us and the autopilot,
    # but the socket gs opens is UDP, so an inferred budget would read a fat pipe
    # and gs would make every fat-pipe choice -- 25 Hz stream requests and a
    # PARAM_REQUEST_LIST flood. Pinning it is what a real serial endpoint, or a
    # `--link-budget` behind mavlink-router, would have told it. Without this the
    # tool silently measures the wrong configuration; it did, until it was caught
    # measuring a contention fix that could not possibly have engaged.
    b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{mav_p}",
               json_port=json_p, ws_port=ws_p, budget_bps=bps)
    threading.Thread(target=b._mav_loop, daemon=True).start()
    out = {}

    async def scenario():
        serve = asyncio.create_task(b._serve())
        await asyncio.sleep(0.5)
        async with websockets.connect(f"ws://127.0.0.1:{ws_p}") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "k"}))

            async def wait(pred, budget):
                t0 = time.monotonic()
                while time.monotonic() - t0 < budget:
                    try:
                        got = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.5))
                    except asyncio.TimeoutError:
                        continue
                    if pred(got):
                        return got, time.monotonic() - t0
                return None, time.monotonic() - t0

            await wait(lambda g: g.get("linkState") == "alive", 20)

            await ws.send(json.dumps({"type": "command", "id": "a1", "name": "arm"}))
            got, dt = await wait(lambda g: g.get("type") == "ack" and g.get("id") == "a1", 25)
            out["arm"] = (bool(got and got.get("ok")), dt)

            items = ([{"kind": "takeoff", "lat": 37.4, "lon": -122.1, "alt": 50}]
                     + [{"kind": "waypoint", "lat": 37.4 + i * 1e-4, "lon": -122.1, "alt": 60}
                        for i in range(n_items - 2)]
                     + [{"kind": "rtl", "lat": 0, "lon": 0, "alt": 0}])
            await ws.send(json.dumps({"type": "mission_push", "id": "m1", "items": items}))
            got, dt = await wait(
                lambda g: g.get("type") == "mission_ack" and g.get("id") == "m1", budget_s)
            out["mission"] = (bool(got and got.get("ok")), dt,
                              got.get("text") if got else "NO REPLY AT ALL")

            await ws.send(json.dumps({"type": "param_refresh"}))
            got, dt = await wait(
                lambda g: g.get("type") == "param_progress" and g.get("done"), budget_s)
            out["params"] = (got.get("received") if got else 0,
                             got.get("count") if got else 0, dt,
                             got.get("error") if got else "NO REPLY AT ALL")
        serve.cancel()

    try:
        asyncio.run(scenario())
    finally:
        px4.stop()
    out["kickoffs"] = px4.kickoffs
    out["dropped"] = px4.radio.dropped
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bps", type=float, default=SIK_57600_BPS, help="link goodput, bytes/s")
    ap.add_argument("--latency", type=float, default=0.12, help="one-way latency, seconds")
    ap.add_argument("--loss", type=float, default=0.05, help="packet loss, 0..1")
    ap.add_argument("--items", type=int, default=40, help="mission items to upload")
    ap.add_argument("--seeds", default="1,2,3", help="comma-separated RNG seeds")
    ap.add_argument("--budget", type=float, default=120.0, help="per-op budget, seconds")
    a = ap.parse_args()

    print(f"link: {a.bps:.0f} B/s, {a.latency * 1000:.0f} ms one-way, {a.loss:.0%} loss; "
          f"{a.items}-item mission\n")
    print("seed  arm          mission                              params")
    bad = 0
    for seed in [int(s) for s in a.seeds.split(",")]:
        r = soak(a.bps, a.latency, a.loss, a.items, seed, a.budget)
        arm_ok, arm_t = r["arm"]
        mok, mt, mtext = r["mission"]
        pr, pc, pt, perr = r["params"]
        # A completed upload is not enough. Every MISSION_COUNT past the first
        # is the autopilot being told to discard the transfer and restart from
        # seq 0, so a run that "succeeds" after ten kickoffs has a defect in it
        # -- that is the shape of the livelock this tool was written to find,
        # and on an unlucky seed the same code never completes at all.
        restarting = r["kickoffs"] > MISSION_MAX_TRIES + 1
        bad += (not arm_ok) + (not mok) + (pr != pc) + restarting
        print(f"{seed:<5} {str(arm_ok):5s} {arm_t:5.1f}s  "
              f"{str(mok):5s} {mt:6.1f}s {r['kickoffs']:2d} kickoff(s)"
              f"{'!' if restarting else ' '} {mtext:<18s}  "
              f"{pr}/{pc} {pt:6.1f}s {perr or ''}")
    print(f"\n{'FAILURES: ' + str(bad) if bad else 'all operations completed'}"
          + ("   (! = the upload was restarted, not resumed)" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
