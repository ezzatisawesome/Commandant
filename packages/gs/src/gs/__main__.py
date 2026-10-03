"""Entry point for the ground-station daemon.

Phase 0: the MAVLink/JSON -> WebSocket telemetry bridge, ported off the old
in-Next bridge. Command authority, params and missions land incrementally per
docs/roadmap.md.
"""

from __future__ import annotations

import argparse

from . import __version__
from .bridge import Bridge


def main() -> int:
    parser = argparse.ArgumentParser(prog="gs", description="Commandant ground-station daemon")
    parser.add_argument("--version", action="version", version=f"gs {__version__}")
    parser.add_argument("--mavlink", default="udpin:0.0.0.0:14550",
                        help="MAVLink endpoint: udpin/udpout/tcp:host:port, "
                             "serial:<device>[:baud], or a bare /dev/… device (the hub radio)")
    parser.add_argument("--baud", type=int, default=57600,
                        help="serial baud when --mavlink is a serial device")
    parser.add_argument("--json-port", type=int, default=14555,
                        help="UDP port for the sim's flightlink JSON telemetry")
    parser.add_argument("--ws-host", default="0.0.0.0", help="WebSocket bind host")
    parser.add_argument("--ws-port", type=int, default=8790,
                        help="WebSocket port for the console UI")
    args = parser.parse_args()

    print(f"gs {__version__} — telemetry bridge")
    Bridge(
        mavlink_endpoint=args.mavlink,
        json_port=args.json_port,
        ws_host=args.ws_host,
        ws_port=args.ws_port,
        baud=args.baud,
    ).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
