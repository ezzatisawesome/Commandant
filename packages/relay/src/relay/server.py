"""The relay: one publisher (the hub), many viewers (browsers).

Design constraints, in priority order:

1. **No path from a viewer to the aircraft.** Viewer sockets are never read.
   The publisher socket is never written to. This is structural; there is no
   "read-only mode" flag that could be wrong.
2. **A fresh page load is instant.** The last frame of each kind is retained and
   replayed to a new viewer, so a browser does not wait up to a second for the
   next telemetry tick (the same trick as Guppi's last-value KV).
3. **A slow viewer cannot affect the hub or other viewers.** Fan-out drops
   frames for a backed-up socket rather than queueing without bound: telemetry
   is state, not events, so the next frame supersedes the one dropped.
4. **The hub authenticates; viewers do not.** Publishing requires a bearer
   token. Watching is open (what is on screen is a plane flying, not secrets).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection, serve

# Message kinds we retain for late joiners. `telemetry` is the 5 Hz frame; the
# others are sparse events a new viewer still needs to render a correct screen.
RETAINED = ("telemetry", "link", "mission", "fence", "rally", "flight")

# A viewer whose write buffer exceeds this is skipped for that frame (see 3).
SLOW_VIEWER_BYTES = 256 * 1024

STALE_AFTER_S = 10.0  # no publisher frame for this long -> viewers told "lost"


def _now_ms() -> int:
    return int(time.time() * 1000)


class Relay:
    def __init__(self, token: str, host: str = "0.0.0.0", port: int = 8791) -> None:
        self.token = token
        self.host = host
        self.port = port

        self._viewers: set[ServerConnection] = set()
        self._publisher: ServerConnection | None = None
        self._retained: dict[str, str] = {}
        self._last_publish_at = 0.0
        # Diagnostics, surfaced by /healthz.
        self.frames_in = 0
        self.frames_dropped = 0

    # --- fan-out -----------------------------------------------------------
    def _fan_out(self, payload: str) -> None:
        """Send to every viewer, skipping any that is not keeping up. Never
        awaits: a blocked viewer must not delay the publisher's next frame."""
        for ws in list(self._viewers):
            try:
                transport = getattr(ws, "transport", None)
                if transport is not None and transport.get_write_buffer_size() > SLOW_VIEWER_BYTES:
                    self.frames_dropped += 1
                    continue
                ws.send(payload, text=True)  # returns a coroutine in some versions
            except Exception:
                self.frames_dropped += 1

    async def _broadcast(self, payload: str) -> None:
        websockets.broadcast(self._viewers, payload)

    # --- publisher (the hub) ----------------------------------------------
    async def _handle_publisher(self, ws: ServerConnection) -> None:
        if self._publisher is not None:
            # A second hub claiming the stream is almost always a stale socket
            # from a reconnect; the newcomer wins and the old one is closed.
            old, self._publisher = self._publisher, None
            await old.close(code=4000, reason="superseded by a new publisher")
        self._publisher = ws
        print(f"[relay] publisher connected ({len(self._viewers)} viewers watching)")
        try:
            async for raw in ws:
                if not isinstance(raw, str):
                    continue
                self.frames_in += 1
                self._last_publish_at = time.monotonic()
                # Retain by kind for late joiners, then fan out verbatim. The
                # relay does not interpret the payload beyond its `type`.
                try:
                    kind = json.loads(raw).get("type")
                except Exception:
                    continue
                if kind in RETAINED:
                    self._retained[kind] = raw
                elif kind == "statustext":
                    pass  # events: forwarded live, not retained
                await self._broadcast(raw)
        except Exception as exc:
            print(f"[relay] publisher dropped: {exc!r}")
        finally:
            if self._publisher is ws:
                self._publisher = None
                # Tell watchers the hub is gone rather than freezing the last frame.
                lost = json.dumps({"type": "link", "state": "lost", "lastMsgMs": _now_ms()})
                self._retained["link"] = lost
                await self._broadcast(lost)
            print("[relay] publisher disconnected")

    # --- viewer (a browser) -------------------------------------------------
    async def _handle_viewer(self, ws: ServerConnection) -> None:
        self._viewers.add(ws)
        print(f"[relay] viewer connected ({len(self._viewers)} total)")
        try:
            # Late-joiner bootstrap: the current state, before the next tick.
            for kind in RETAINED:
                payload = self._retained.get(kind)
                if payload is not None:
                    await ws.send(payload)
            if self._publisher is None:
                await ws.send(json.dumps({"type": "link", "state": "lost", "lastMsgMs": 0}))
            # Hold the socket open WITHOUT reading it. A viewer has no inbound
            # protocol; anything it sends is ignored at the transport level.
            await ws.wait_closed()
        finally:
            self._viewers.discard(ws)

    # --- routing ------------------------------------------------------------
    async def _handler(self, ws: ServerConnection) -> None:
        path = getattr(ws.request, "path", "/") if ws.request else "/"
        if path.startswith("/publish"):
            token = self._token_from(ws, path)
            if not self.token or token != self.token:
                await ws.close(code=4003, reason="bad token")
                return
            await self._handle_publisher(ws)
        else:
            await self._handle_viewer(ws)

    @staticmethod
    def _token_from(ws: ServerConnection, path: str) -> str | None:
        """Token from the Authorization header, else a ?token= query param (a
        browser-less hub can set a header; the query form eases curl testing)."""
        auth = ""
        if ws.request is not None:
            auth = ws.request.headers.get("Authorization", "") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        if "?" in path:
            from urllib.parse import parse_qs, urlparse
            qs = parse_qs(urlparse(path).query)
            vals = qs.get("token")
            if vals:
                return vals[0]
        return None

    # --- staleness watchdog --------------------------------------------------
    async def _watchdog(self) -> None:
        """If the publisher socket stays open but stops sending (a wedged hub, a
        half-open TCP connection), viewers must still learn the link is stale."""
        told = False
        while True:
            await asyncio.sleep(1.0)
            if self._publisher is None or self._last_publish_at == 0.0:
                continue
            quiet = time.monotonic() - self._last_publish_at
            if quiet > STALE_AFTER_S and not told:
                told = True
                await self._broadcast(json.dumps(
                    {"type": "link", "state": "lost", "lastMsgMs": _now_ms()}))
            elif quiet <= STALE_AFTER_S:
                told = False

    async def serve_forever(self) -> None:
        async with serve(self._handler, self.host, self.port,
                         ping_interval=20, ping_timeout=20, max_size=2 ** 20):
            print(f"[relay] listening on ws://{self.host}:{self.port}"
                  f"  (publish at /publish, watch at /)")
            await self._watchdog()

    def run(self) -> None:
        asyncio.run(self.serve_forever())


def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="relay", description=__doc__)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8791)))
    p.add_argument("--token", default=os.environ.get("RELAY_TOKEN", ""),
                   help="bearer token the hub must present to publish "
                        "(env RELAY_TOKEN; publishing is refused if unset)")
    a = p.parse_args(argv)
    if not a.token:
        print("[relay] refusing to start without a token: set --token or RELAY_TOKEN")
        return 2
    Relay(token=a.token, host=a.host, port=a.port).run()
    return 0
