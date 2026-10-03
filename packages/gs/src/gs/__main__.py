"""Entry point for the ground-station daemon.

Phase 0 stub: real wiring (pymavlink link manager, WS/HTTP contract, command
authority) lands incrementally per docs/roadmap.md. For now this just confirms
the package runs.
"""

from __future__ import annotations

import argparse

from . import __version__


def main() -> int:
    parser = argparse.ArgumentParser(prog="gs", description="Commandant ground-station daemon")
    parser.add_argument("--version", action="version", version=f"gs {__version__}")
    # Placeholder for the real link/endpoint args (mavlink-router output, WS port).
    parser.add_argument("--mavlink", default="udpin:0.0.0.0:14550",
                        help="MAVLink endpoint to attach to (via mavlink-router)")
    parser.add_argument("--ws-port", type=int, default=8790,
                        help="WebSocket port for the console UI")
    args = parser.parse_args()

    print(f"gs {__version__} — stub. mavlink={args.mavlink} ws-port={args.ws_port}")
    print("Phase 0 not yet wired; see docs/roadmap.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
