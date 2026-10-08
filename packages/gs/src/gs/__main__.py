"""Entry point for the ground-station daemon.

Phase 0: the MAVLink/JSON -> WebSocket telemetry bridge, ported off the old
in-Next bridge. Command authority, params and missions land incrementally per
docs/roadmap.md.
"""

from __future__ import annotations

import argparse
import os
import time

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
    parser.add_argument("--relay", default=os.environ.get("COMMANDANT_RELAY", ""),
                        help="publish telemetry outbound to a relay, e.g. "
                             "wss://commandant.guppi.com/publish (env COMMANDANT_RELAY). "
                             "Outbound only: the relay can never command this hub.")
    parser.add_argument("--relay-token", default=os.environ.get("COMMANDANT_RELAY_TOKEN", ""),
                        help="bearer token for --relay (env COMMANDANT_RELAY_TOKEN)")
    parser.add_argument("--relay-hz", type=float, default=5.0,
                        help="telemetry rate republished to the relay (default 5)")
    parser.add_argument("--flight-id", default="",
                        help="label for this flight on the relay (default: a UTC timestamp)")
    args = parser.parse_args()

    relay = None
    if args.relay:
        if not args.relay_token:
            parser.error("--relay needs --relay-token (or COMMANDANT_RELAY_TOKEN)")
        from .relay import RelayPublisher
        flight_id = args.flight_id or time.strftime("flight-%Y%m%d-%H%M%S", time.gmtime())
        relay = RelayPublisher(url=args.relay, token=args.relay_token,
                               hz=args.relay_hz, flight_id=flight_id)
        print(f"[gs] relay uplink: {args.relay} as {flight_id} "
              f"({args.relay_hz:g} Hz, outbound only)")

    print(f"gs {__version__} — telemetry bridge")
    Bridge(
        mavlink_endpoint=args.mavlink,
        json_port=args.json_port,
        ws_host=args.ws_host,
        ws_port=args.ws_port,
        baud=args.baud,
        relay=relay,
    ).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
