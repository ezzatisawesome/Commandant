"""The relay: one publisher (the hub), many viewers (browsers).

Design constraints, in priority order:

1. **No path from a viewer to the aircraft.** Nothing in this process parses,
   inspects or acts on anything a viewer sends, and the publisher socket is
   never written to. This is structural; there is no "read-only mode" flag
   that could be wrong.

   What a viewer sends is *not* discarded by the transport -- an earlier
   version of this docstring claimed it was, and that was false. websockets
   parses inbound frames and queues them in the connection's assembler
   whether or not anyone reads them, so the bytes sit in this process until
   the queue fills and TCP backpressure stops the sender. Measured with the
   old defaults (max_size 1 MiB, max_queue 16): eight viewers each sending
   1 MiB messages parked ~20 MB *each*, on a 256 MB machine that allows 400
   connections and asks viewers for no token. `_drop_slow_viewers` could not
   see any of it, because it only looks at the *write* buffer.

   The amount a viewer can park is therefore bounded by flow control, via
   MAX_FRAME_BYTES x MAX_QUEUED_FRAMES below -- a few hundred KB, not 20 MB.
   Still never interpreted; now also never large.

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
import secrets
import time
from http import HTTPStatus
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request

# Message kinds we retain for late joiners. `telemetry` is the 5 Hz frame; the
# others are sparse events a new viewer still needs to render a correct screen.
RETAINED = ("telemetry", "link", "mission", "fence", "rally", "flight")

# A viewer whose write buffer exceeds this is skipped for that frame (see 3).
SLOW_VIEWER_BYTES = 256 * 1024

# Inbound frame limits, applied to every connection (see constraint 1).
#
# `max_size` has to clear the largest thing the PUBLISHER legitimately sends,
# because it applies to every connection and rejecting a publisher frame closes
# the uplink. That is not the 5 Hz telemetry tick (a few hundred bytes) but a
# retained `mission`: gs puts no cap on item count, and MEASURED at ~115 bytes
# of JSON per waypoint, 500 items is 57 KiB and 1000 items is 114 KiB. A 64 KiB
# limit would have taken the public feed down for any large plan, so this sits
# well above the biggest plausible plan instead.
MAX_FRAME_BYTES = 256 * 1024
# The viewer bound is carried by the queue depth instead, which costs the
# publisher nothing: it is read continuously, so its queue never builds.
MAX_QUEUED_FRAMES = 1

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
        # There used to be a `frames_dropped` beside this, incremented on the
        # line next to `viewers_dropped` -- once per closed viewer. It counted
        # viewers, not frames, so the two figures were always identical and
        # neither one told you how many frames went undelivered. The relay
        # cannot know that number (a closed socket's backlog is bytes in a
        # kernel buffer, not countable frames), so rather than keep a
        # plausible-looking counter that means nothing -- the exact problem the
        # slow-viewer work existed to fix -- there is one counter, and its name
        # matches what it counts.
        self.viewers_dropped = 0

    # --- fan-out -----------------------------------------------------------
    def _drop_slow_viewers(self) -> int:
        """Close viewers whose write buffer is running away, and return how many.

        Constraint 3 above said a slow viewer cannot affect the hub or other
        viewers. It was implemented in a `_fan_out` helper that **nothing ever
        called** -- every broadcast went through `websockets.broadcast`, so
        SLOW_VIEWER_BYTES was dead code and the drop counter was permanently 0,
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
            # Claim the slot BEFORE awaiting the old socket's close. Awaiting
            # with `_publisher` set to None left a window in which a third
            # connection saw the slot free, took it, and was then overwritten
            # when this one resumed -- two hubs interleaving frames into one
            # stream. Unreachable with a single hub, reachable with one
            # reconnecting fast.
            old, self._publisher = self._publisher, ws
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
            # A viewer has no inbound protocol, so the FIRST data frame one
            # sends is already a protocol violation and the socket goes. The
            # content is never looked at -- constraint 1 is untouched -- only
            # the fact that something arrived.
            #
            # This replaced a bare `wait_closed()`, which held the socket open
            # without reading it. Not reading is not the same as nothing
            # arriving: websockets parses inbound frames into the connection's
            # queue regardless, so an unread socket was a place to park memory
            # inside this process (~20 MB per viewer, measured). Closing on
            # first arrival caps it at one frame, and MAX_QUEUED_FRAMES stalls
            # the sender on TCP backpressure meanwhile. Control frames (ping,
            # pong, close) never reach here, so a browser that only answers
            # pings is unaffected -- as is the view build, which refuses to
            # transmit at its own send chokepoint.
            async for _ in ws:
                print("[relay] closing a viewer that sent data; viewers have "
                      "no inbound protocol")
                await ws.close(code=1003, reason="viewers do not send")
                break
        finally:
            self._viewers.discard(ws)

    # --- routing ------------------------------------------------------------
    async def _handler(self, ws: ServerConnection) -> None:
        path = getattr(ws.request, "path", "/") if ws.request else "/"
        if path.startswith("/publish"):
            token = self._token_from(ws, path)
            # Constant-time, and fail closed on an unset token. A timing attack
            # across a WebSocket handshake is impractical -- network jitter
            # dwarfs a string compare -- so this is hygiene rather than a
            # measured hole. It is also free, and this is the one component
            # exposed to the internet.
            if not self.token or not secrets.compare_digest(token or "", self.token):
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
            elif quiet <= STALE_AFTER_S and told:
                # Retract it. This used to only reset `told` and broadcast
                # nothing, which left viewers showing "lost" over a moving
                # aircraft for the rest of the flight: the hub emits a `link`
                # frame only when ITS state transitions (gs/bridge.py), so when
                # the uplink came back the hub resumed sending telemetry and no
                # new `link` -- and the retained "lost" meant a fresh page load
                # got the same wrong answer.
                #
                # Careful about whose link this is: the relay's staleness is
                # about the hub->relay uplink, while the hub's own `link` state
                # is about PX4->hub. Two different facts sharing one field, so
                # whichever side spoke last wins; saying "alive" here only
                # claims that the hub is reaching us again.
                told = False
                alive = json.dumps({"type": "link", "state": "alive",
                                    "lastMsgMs": _now_ms()})
                self._retained["link"] = alive
                await self._broadcast(alive)

    # --- health ---------------------------------------------------------------
    def _health_body(self) -> str:
        last = self._last_publish_at
        return json.dumps({
            "ok": True,
            "viewers": len(self._viewers),
            "publisher_connected": self._publisher is not None,
            "frames_in": self.frames_in,
            "viewers_dropped": self.viewers_dropped,
            "seconds_since_last_publish":
                None if last == 0.0 else round(time.monotonic() - last, 3),
        })

    def _process_request(self, connection: ServerConnection, request: Request):
        """Answer GET /healthz with plain HTTP instead of a WebSocket upgrade.

        Two comments and a test name referred to "/healthz" while no such route
        existed: `_handler` knew `/publish` and treated every other path as a
        viewer, so an HTTP probe of /healthz got a WebSocket handshake failure
        and the counters were unreachable in production. websockets' own
        `process_request` hook is the supported way to do this -- returning a
        Response here skips the upgrade entirely."""
        path = request.path.split("?", 1)[0]
        if path.rstrip("/") not in ("/healthz",):
            return None
        response = connection.respond(HTTPStatus.OK, self._health_body() + "\n")
        # respond() labels the body text/plain; it is JSON.
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = "application/json"
        return response

    async def serve_forever(self) -> None:
        # Short ping cycle, which is the other half of the slow-viewer defence:
        # websockets' own docs recommend keeping these low "to prevent excessive
        # memory usage from slow connections", since a stalled socket is only
        # reclaimed when its ping times out. 20 s each meant up to 40 s of a
        # 5 Hz stream buffered per dead-but-unclosed viewer.
        async with serve(self._handler, self.host, self.port,
                         ping_interval=10, ping_timeout=10,
                         process_request=self._process_request,
                         max_size=MAX_FRAME_BYTES, max_queue=MAX_QUEUED_FRAMES):
            print(f"[relay] listening on ws://{self.host}:{self.port}"
                  f"  (publish at /publish, watch at /, health at /healthz)")
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
