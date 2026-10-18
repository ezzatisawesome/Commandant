#!/usr/bin/env python
"""Diff the telemetry frame gs builds now against the one it built at a git ref.

The emitted frame IS the console's contract, and the branch that builds it is a
long elif chain that gets restructured (the _on_mav lock-scope split was the
largest single change of the 2026-10-18 pass). Unit tests cover the branches
one at a time; this feeds ONE identical MAVLink sequence into both versions and
diffs the whole resulting frame, field by field, which is what a reviewer of
such a change actually wants to know.

    cd packages/gs && uv run python scripts/frame_diff.py                # vs HEAD~1
    uv run python scripts/frame_diff.py --ref 657fe0f                    # vs any ref

Exits non-zero if a pre-existing field changed value. New fields are reported
but not failed — adding to the frame is how the contract grows.
"""

from __future__ import annotations

import argparse
import importlib
import math
import os
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace

os.environ.setdefault("MAVLINK20", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_SRC = os.path.join(HERE, "..", "src")


def _checkout(ref: str, into: str) -> str:
    """Materialise gs/bridge.py from `ref` next to the current package files."""
    pkg = os.path.join(into, "gs")
    os.makedirs(pkg, exist_ok=True)
    blob = subprocess.run(
        ["git", "show", f"{ref}:packages/gs/src/gs/bridge.py"],
        capture_output=True, text=True, cwd=HERE, check=True).stdout
    with open(os.path.join(pkg, "bridge.py"), "w") as fh:
        fh.write(blob)
    shutil.copy(os.path.join(REPO_SRC, "gs", "__init__.py"), pkg)
    return into

def msg(t, **f):
    ns = SimpleNamespace(**f)
    ns.get_type = lambda: t
    ns.get_srcSystem = lambda: 1
    ns.get_srcComponent = lambda: 1
    return ns

def sequence():
    m = __import__("pymavlink.mavutil", fromlist=["mavutil"]).mavlink
    return [
        msg("HEARTBEAT", type=1, autopilot=12, base_mode=128,
            custom_mode=(4<<16)|(4<<24), system_status=4),
        msg("GLOBAL_POSITION_INT", time_boot_ms=600000, lat=373985511, lon=-1221488530,
            alt=233400, hdg=9130, vx=1420, vy=110, vz=-30),
        msg("ATTITUDE", roll=0.012, pitch=0.08, yaw=1.59),
        msg("VFR_HUD", airspeed=15.1, groundspeed=14.2, heading=91, throttle=62, alt=233.4, climb=0.3),
        msg("BATTERY_STATUS", voltages=[24310]+[65535]*9, current_battery=412, battery_remaining=78),
        msg("ACTUATOR_OUTPUT_STATUS", actuator=[1500]*5+[1550,1450,1600]+[0]*24),
        msg("SYS_STATUS", onboard_control_sensors_enabled=0x3F,
            onboard_control_sensors_health=0x3F, battery_remaining=78),
        msg("WIND_COV", wind_x=3.0, wind_y=1.0, wind_z=0.1, var_horiz=0.08, var_vert=0.05),
        msg("GPS_RAW_INT", fix_type=3, satellites_visible=14),
        msg("EKF_STATUS_REPORT", flags=0xFFFF),
        msg("POSITION_TARGET_GLOBAL_INT", coordinate_frame=6, type_mask=0,
            lat_int=373991000, lon_int=-1221480000, alt=240.0),
        msg("GLOBAL_POSITION_INT", time_boot_ms=600100, lat=373985600, lon=-1221488400,
            alt=233500, hdg=9140, vx=1425, vy=112, vz=-28),
    ]

class Conn:
    class Mav:
        def __getattr__(self, n):
            if n.endswith("_send"): return lambda *a: None
            raise AttributeError(n)
    def __init__(self): self.mav = self.Mav()
    def recv_match(self, **k): return None
    def close(self): pass

def run(src_dir: str, label: str) -> dict:
    for mod in list(sys.modules):
        if mod == "gs" or mod.startswith("gs."):
            del sys.modules[mod]
    sys.path.insert(0, src_dir)
    try:
        bm = importlib.import_module("gs.bridge")
        b = bm.Bridge(mavlink_endpoint="udpin:127.0.0.1:1")
        b._loop = type("L", (), {"call_soon_threadsafe": lambda s, fn, *a: None})()
        conn = Conn()
        for mm in sequence():
            b._on_mav(conn, mm)
        return dict(b.latest)
    finally:
        sys.path.remove(src_dir)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", default="HEAD~1", help="git ref to compare against")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        old_dir = _checkout(args.ref, tmp)
        before = run(old_dir, args.ref)
        after = run(os.path.abspath(REPO_SRC), "working tree")

    keys = sorted(set(before) | set(after))
    same = changed = added = removed = 0
    print(f"{'field':18s} {args.ref[:20]:>22s} {'working tree':>22s}")
    print("-" * 66)
    for k in keys:
        a, b = before.get(k, "<absent>"), after.get(k, "<absent>")
        eq = (a == b) or (isinstance(a, float) and isinstance(b, float)
                          and math.isclose(a, b, rel_tol=1e-12))
        if eq:
            same += 1
        elif k not in before:
            added += 1
            print(f"{k:18s} {'<absent>':>22s} {str(b):>22s}   NEW")
        elif k not in after:
            removed += 1
            print(f"{k:18s} {str(a):>22s} {'<absent>':>22s}   *** REMOVED")
        else:
            changed += 1
            print(f"{k:18s} {str(a):>22s} {str(b):>22s}   *** CHANGED")
    print("-" * 66)
    print(f"{same} identical, {added} new, {changed} changed, {removed} removed")
    bad = changed + removed
    print("\n" + ("*** a pre-existing telemetry field changed — investigate"
                  if bad else "no pre-existing telemetry field changed"))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
