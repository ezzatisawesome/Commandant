"""Entry point for the ground-station daemon.

Phase 0: the MAVLink/JSON -> WebSocket telemetry bridge, ported off the old
in-Next bridge. Command authority, params and missions land incrementally per
docs/roadmap.md.
"""

from __future__ import annotations

import argparse
import os
import time
from typing import Any

from . import __version__
from .bridge import Bridge


def print_status(host: str, port: int) -> int:
    """Connect to a running daemon, ask for its status, print it, exit.

    Deliberately a client of the same WS verb the console uses rather than a
    second code path: a diagnostic that reads the daemon's state through a
    different route than the UI can disagree with the UI, and then you are
    debugging the diagnostic. 0.0.0.0 is a bind address, not a destination, so
    it is dialled as localhost."""
    import asyncio
    import json

    import websockets

    target = "127.0.0.1" if host in ("0.0.0.0", "", "::") else host
    url = f"ws://{target}:{port}"

    async def ask() -> int:
        try:
            async with websockets.connect(url, open_timeout=5) as ws:
                await ws.send(json.dumps({"type": "status"}))
                for _ in range(200):          # skip the telemetry stream
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                    if msg.get("type") == "status":
                        _print_status(msg)
                        return 0
                print(f"[gs] no status reply from {url} (is it an older daemon?)")
                return 1
        except Exception as exc:
            print(f"[gs] cannot reach a daemon on {url}: {exc}")
            print("      Is it running? --ws-port must match the one it serves.")
            return 1

    return asyncio.run(ask())


def _print_status(s: dict) -> None:
    def line(k: str, v: Any) -> None:
        print(f"  {k:22s} {v}")

    print(f"\ngs {s.get('version')} — up {s.get('upMs', 0) / 1000:.0f}s\n")
    print(" link")
    line("endpoint", f"{s.get('endpoint')}"
                     + ("" if s.get("configuredEndpoint") == s.get("endpoint")
                        else f"   (asked for {s.get('configuredEndpoint')})"))
    line("budget", f"{s.get('linkBudgetBps')} B/s"
                   + ("  [pinned]" if s.get("linkBudgetPinned") else "  [inferred]"))
    line("param fetch", s.get("paramFetch"))
    line("state", f"{s.get('linkState')}"
                  + (f", data {s.get('dataAgeMs')} ms old"
                     if s.get("dataAgeMs") is not None else ""))
    line("vehicle", s.get("vehicle") or "none locked")
    ages = s.get("streamAges") or {}
    if ages:
        line("streams", ", ".join(f"{g} {ms / 1000:.1f}s" for g, ms in sorted(ages.items())))
    print("\n authority")
    # The field question this answers: "why will it not let me arm?"
    line("command token", "REQUIRED" if s.get("commandTokenRequired")
         else "not set — anyone who can reach this port can command")
    print("\n clients")
    line("connected", s.get("clients"))
    line("commander held", s.get("commanderHeld"))
    busy = [f"{s.get('pendingCommands')} command(s)" if s.get("pendingCommands") else "",
            f"{s.get('pendingParamSets')} param set(s)" if s.get("pendingParamSets") else "",
            (f"param refresh {s['paramRefresh']['received']}/{s['paramRefresh']['count']}"
             if s.get("paramRefresh") else ""),
            (f"{s['missionOp']['plane']} {s['missionOp']['op']}"
             if s.get("missionOp") else "")]
    line("in flight", ", ".join(b for b in busy if b) or "nothing")
    # The two that are survivable by design, and so worth saying out loud.
    reopens, errors = s.get("linkReopens", 0), s.get("handlerErrors", 0)
    print("\n quietly survived")
    line("link reopens", f"{reopens}" + ("" if not reopens else "   <-- the link has been dropping"))
    line("handler errors", f"{errors}" + ("" if not errors else "   <-- check the daemon log"))
    ev = s.get("events") or {}
    if ev.get("metadata"):
        line("PX4 events", f"decoded {ev.get('decoded', 0)}, unknown {ev.get('unknown', 0)}  "
                           f"({os.path.basename(ev['metadata'])})")
    elif ev.get("missed"):
        line("PX4 events", f"{ev['missed']} UNREADABLE — set --events-meta; refusal reasons are being lost")
    trimmed = s.get("trimmedStreams")
    if trimmed:
        # Said plainly, because the alternative is someone hunting a message in
        # a flight log that gs deliberately turned off.
        line("trimmed streams", ", ".join(trimmed) + "  (gs reads none of these)")
    fl = s.get("flightLog") or {}
    print("\n flight log")
    if not fl.get("enabled") and fl.get("error"):
        line("state", f"STOPPED — {fl['error']}")
    elif not fl.get("enabled"):
        line("state", "off (--no-log)")
    else:
        line("writing", fl.get("path"))
        if fl.get("jsonRecords"):
            # Only when the feed is actually in use, so a plain PX4 flight is
            # not told about a file it has no reason to care about.
            line("json sidecar", f"{fl['jsonRecords']} frames  "
                                 f"({os.path.basename(fl.get('jsonPath') or '')})")
        line("records", f"{fl.get('records', 0)}"
                        + (f"   <-- {fl['dropped']} DROPPED, the disk is not keeping up"
                           if fl.get("dropped") else ""))
        line("on disk", f"{fl.get('bytes', 0) / 1e6:.1f} MB"
                        + (f", {fl['rotations']} rotation(s)" if fl.get("rotations") else "")
                        + (f", {fl['pruned']} pruned" if fl.get("pruned") else ""))
        if not fl.get("clockWasSet"):
            # Worth saying before someone correlates this log with a video.
            line("clock", "was NOT set when this log opened — times are relative")
    if s.get("relay") is not None:
        r = s["relay"]
        print("\n relay uplink")
        line("connected", r.get("connected"))
        line("sent / dropped", f"{r.get('sent')} / {r.get('dropped')}")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(prog="gs", description="Commandant ground-station daemon")
    parser.add_argument("--version", action="version", version=f"gs {__version__}")
    parser.add_argument("--mavlink", default="auto",
                        help="MAVLink endpoint: `auto` (default — probe USB/radio "
                             "serial devices, then udp:14550 and tcp:5760, and "
                             "re-probe on every reopen), or an explicit "
                             "udpin/udpout/tcp:host:port, serial:<device>[:baud], "
                             "or bare /dev/… device")
    parser.add_argument("--baud", type=int, default=57600,
                        help="serial baud when --mavlink is a serial device")
    parser.add_argument("--link-budget", type=float, default=None, metavar="BYTES_PER_SEC",
                        help="pin the MAVLink link's usable goodput instead of inferring "
                             "it from the endpoint. Needed when a proxy (mavlink-router) "
                             "makes a telemetry radio look like a UDP socket: gs would "
                             "otherwise ask a 57600 link for fat-pipe stream rates and a "
                             "PARAM_REQUEST_LIST flood. A 57600 SiK link is about 3456.")
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
    parser.add_argument("--status", action="store_true",
                        help="ask a RUNNING daemon what it decided and exit. The "
                             "same snapshot the console can request, over the same "
                             "socket -- a field hub has ssh, not a browser.")
    parser.add_argument("--replay", metavar="FILE.tlog",
                        help="serve a recorded flight instead of a live link. "
                             "The console connects as usual and every frame is "
                             "marked as a replay. The .jsonl sidecar beside the "
                             "file is interleaved automatically.")
    parser.add_argument("--replay-speed", type=float, default=1.0,
                        metavar="X", help="replay faster or slower (default 1x)")
    parser.add_argument("--replay-loop", action="store_true",
                        help="start again at the end")
    parser.add_argument("--events-meta", default=None, metavar="all_events.json",
                        help="PX4 event metadata for the FLASHED firmware "
                             "(build/<target>/events/all_events.json[.xz]). Without "
                             "it, the reason PX4 refused a mission or a mode never "
                             "reaches the console. Default: $GS_EVENTS_META, else "
                             "autodetected under $PX4_DIR or a mojave-px4 sibling.")
    parser.add_argument("--keep-all-streams", action="store_true",
                        help="do not ask the vehicle to stop sending messages "
                             "gs never reads. Keeps them in the flight log, at "
                             "about 12 kB/s and half the hub's decode CPU on a "
                             "USB or HITL link.")
    parser.add_argument("--command-token",
                        default=os.environ.get("GS_COMMAND_TOKEN", ""),
                        help="secret a console must present to take command "
                             "authority; telemetry stays open to everyone. "
                             "Empty means anyone who can reach the port can fly "
                             "the aircraft (and gs says so at startup).")
    parser.add_argument("--log-dir", default=os.environ.get("GS_LOG_DIR", "logs"),
                        metavar="DIR",
                        help="where to write replayable .tlog flight logs "
                             "(default: ./logs, or $GS_LOG_DIR)")
    parser.add_argument("--no-log", action="store_true",
                        help="do not record a flight log")
    parser.add_argument("--flight-id", default="",
                        help="label for this flight on the relay (default: a UTC timestamp)")
    args = parser.parse_args()

    if args.status:
        return print_status(args.ws_host, args.ws_port)

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
    if args.replay:
        # No live link: a replay serves the console and talks to no vehicle.
        Bridge(
            ws_host=args.ws_host, ws_port=args.ws_port, json_port=args.json_port,
        ).run_replay(args.replay, args.replay_speed, args.replay_loop)
        return 0
    Bridge(
        mavlink_endpoint=args.mavlink,
        json_port=args.json_port,
        ws_host=args.ws_host,
        ws_port=args.ws_port,
        baud=args.baud,
        relay=relay,
        budget_bps=args.link_budget,
        log_dir=None if args.no_log else args.log_dir,
        command_token=args.command_token,
        trim_streams=not args.keep_all_streams,
        events_meta=args.events_meta,
    ).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
