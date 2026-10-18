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
        self.viewers_dropped = 0

    # --- fan-out -----------------------------------------------------------
    def _drop_slow_viewers(self) -> int:
        """Close viewers whose write buffer is running away, and return how many.

        Constraint 3 above said a slow viewer cannot affect the hub or other
        viewers. It was implemented in a `_fan_out` helper that **nothing ever
        called** -- every broadcast went through `websockets.broadcast`, so
        SLOW_VIEWER_BYTES was dead code and `frames_dropped` was permanently 0,
        which made the /healthz figure meaningless as well.

        That matters because `broadcast` is explicitly not flow-controlled. From
        its own documentation: "pushes the message synchronously to all
        connections even if their write buffers are overflowing. There's no
        backpressure... messages will pile up in its write buffer until the
        connection times out." This is the one component on the public
        internet, viewers are unauthenticated, and it runs on a single small
        machine -- so a phone on bad cell data watching a 5 Hz stream grows a
        buffer inside this process, and anyone can open one.

        `broadcast` is still the right primitive (one serialisation, no
        awaiting, so no viewer can delay another). What was missing is getting
        rid of a viewer that cannot keep up. Closing it is also the better
        outcome for that viewer: it reconnects and gets the retained state,
        which is a correct current screen, rather than a backlog of frames that
        were superseded while they sat in a queue."""
        dropped = 0
        for ws in list(self._viewers):
            transport = getattr(ws, "transport", None)
            if transport is None:
                continue
            try:
                buffered = transport.get_write_buffer_size()
            except Exception:
                continue
            if buffered > SLOW_VIEWER_BYTES:
                self._viewers.discard(ws)
                self.frames_dropped += 1
                self.viewers_dropped += 1
                dropped += 1
                # Fire-and-forget: closing must not delay the publisher's
                # frame. Scheduled on the running loop rather than with
                # ensure_future, which reaches for the "current" loop and is
                # deprecated (and soon an error) when there isn't one -- the
                # viewer is already out of the set, so having nowhere to
                # schedule the close is not a reason to keep serving it.
                try:
                    asyncio.get_running_loop().create_task(
                        ws.close(code=1013, reason="too slow"))
                except RuntimeError:
                    pass
        if dropped:
            print(f"[relay] dropped {dropped} viewer(s) over "
                  f"{SLOW_VIEWER_BYTES} B of unsent data")
        return dropped

    async def _broadcast(self, payload: str) -> None:
        self._drop_slow_viewers()
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
                # The flight is over. DROP the retained state: keeping the last
                # telemetry frame would mean the next viewer — possibly days later,
                # possibly before a different flight — opens the page and sees an
                # aircraft sitting at the previous flight's final position. Within a
                # flight retention is what makes a page load instant; across flights
                # it is stale data wearing a live aircraft's clothes.
                self._retained.clear()
                lost = json.dumps({"type": "link", "state": "lost", "lastMsgMs": _now_ms()})
                self._retained["link"] = lost
                await self._broadcast(lost)
            print("[relay] publisher disconnected; retained state cleared")

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
            if self._publisher is None and "link" not in self._retained:
                # No hub has ever published here. (When one has and then left, the
                # retained `link` already said "lost" — don't say it twice.)
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
                # Same reasoning as a disconnect: a hub that holds its socket open
                # but stops sending is not flying, so its last frame must not be
                # replayed to someone who arrives later.
                self._retained.pop("telemetry", None)
                lost = json.dumps({"type": "link", "state": "lost", "lastMsgMs": _now_ms()})
                self._retained["link"] = lost
                await self._broadcast(lost)
            elif quiet <= STALE_AFTER_S:
                told = False

    async def serve_forever(self) -> None:
        # Short ping cycle, which is the other half of the slow-viewer defence:
        # websockets' own docs recommend keeping these low "to prevent excessive
        # memory usage from slow connections", since a stalled socket is only
        # reclaimed when its ping times out. 20 s each meant up to 40 s of a
        # 5 Hz stream buffered per dead-but-unclosed viewer.
        async with serve(self._handler, self.host, self.port,
                         ping_interval=10, ping_timeout=10, max_size=2 ** 20):
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
