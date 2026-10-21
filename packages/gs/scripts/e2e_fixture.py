#!/usr/bin/env python
"""A vehicle and a daemon on fixed ports, for the browser test to fly.

The console's end-to-end test needs something to talk to, and it has to be the
REAL daemon — the point of that test is the whole stack, so a mock WebSocket
would answer the wrong question. This puts gs on :8790 (where the console looks
by default) in front of the same stand-in autopilot the rehearsals use, which is
written to be indistinguishable from PX4 SITL, a HITL rig or the airframe.

    uv run python scripts/e2e_fixture.py            # a fat pipe
    uv run python scripts/e2e_fixture.py --loss 0.05 --bps 3456

Prints READY on a line of its own once gs has locked onto the vehicle, so the
caller can wait for it instead of sleeping.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("MAVLINK20", "1")

from radio_soak import SIK_57600_BPS, SimAutopilot  # noqa: E402

from gs.bridge import Bridge  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ws-port", type=int, default=8790)
    ap.add_argument("--mav-port", type=int, default=14550)
    ap.add_argument("--json-port", type=int, default=14555)
    ap.add_argument("--bps", type=float, default=1_000_000.0)
    ap.add_argument("--latency", type=float, default=0.0)
    ap.add_argument("--loss", type=float, default=0.0)
    a = ap.parse_args()

    px4 = SimAutopilot(a.mav_port, (a.bps, a.latency, a.loss)).start()
    b = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{a.mav_port}",
               json_port=a.json_port, ws_port=a.ws_port, budget_bps=a.bps)
    # Bridge.run() starts the mav and JSON loops itself. Starting them here too
    # ran two mav loops in one process, both binding the same UDP port -- the
    # second logged "Address already in use" every ten seconds forever, which
    # looked exactly like a leaked process from a previous run and sent me
    # hunting the wrong thing twice.

    def announce() -> None:
        # READY means the daemon has a vehicle, not merely that it is listening:
        # a browser that connects before the lock sees `connecting` and the test
        # would race the fixture rather than the code under test.
        while b._vehicle is None:
            time.sleep(0.05)
        print("READY", flush=True)
    threading.Thread(target=announce, daemon=True).start()

    def die_with_parent() -> None:
        """Exit when whoever started us goes away.

        `uv run python` is a wrapper, so killing the process the test spawned can
        leave this Python alive — and an orphaned stand-in autopilot still
        streaming at sysid 1 makes gs see two clocks on one sysid. It reports
        that correctly, which then clears the console's view of the vehicle and
        fails unrelated checks three sections later. Five runs of the browser
        test were debugged against that before the pattern was clear.
        Process-group kills and `pkill` both missed it at least once; noticing
        our own reparenting does not."""
        parent = os.getppid()
        while True:
            time.sleep(0.5)
            if os.getppid() != parent:
                print("[fixture] parent gone; exiting", flush=True)
                px4.stop()
                os._exit(0)
    threading.Thread(target=die_with_parent, daemon=True).start()

    try:
        b.run()
    except KeyboardInterrupt:
        pass
    finally:
        px4.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
