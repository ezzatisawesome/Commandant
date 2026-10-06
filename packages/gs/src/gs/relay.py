"""Outbound publisher: push this hub's telemetry to the public relay.

Strictly one-way. The hub dials out, writes, and never reads a reply, so there
is no inbound path from the internet to the aircraft even if the relay were
hostile or compromised. Command authority stays on the hub's own WiFi.

Enabled with `python -m gs --relay wss://commandant.guppi.com/publish
--relay-token …`; absent those flags the daemon behaves exactly as before.

Two things it must never do: block the 25 Hz broadcast loop, or grow without
bound while the uplink is down. Both are handled by a latest-wins slot for
telemetry (a dropped frame is irrelevant, the next supersedes it) plus a bounded
queue for sparse events (statustext, mission/fence readbacks).
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from typing import Any

import websockets

# Telemetry is republished at this rate, not the full 25 Hz: a viewer over the
# internet cannot perceive more, and a field hotspot should not pay for it.
DEFAULT_HZ = 5.0

# Sparse events waiting for the uplink. Past this the oldest is dropped rather
# than buffering a whole flight in RAM.
EVENT_QUEUE_MAX = 256

RECONNECT_MIN_S = 1.0
RECONNECT_MAX_S = 30.0

# Kinds that are state (latest-wins, rate-limited) rather than events.
_STATE_KINDS = ("telemetry",)


class RelayPublisher:
    """Owns one outbound websocket. Call `offer()` from any thread; the asyncio
    task drains and sends. `offer()` never blocks and never raises."""

    def __init__(self, url: str, token: str, hz: float = DEFAULT_HZ,
                 flight_id: str | None = None) -> None:
        self.url = url
        self.token = token
        self.min_interval = 1.0 / hz if hz > 0 else 0.0
        self.flight_id = flight_id

        self._loop: asyncio.AbstractEventLoop | None = None
        self._latest: dict[str, str] = {}        # kind -> newest payload (state)
        self._events: list[str] = []             # ordered sparse events
        self._wake: asyncio.Event | None = None
        self._last_sent_at: dict[str, float] = {}

        # Diagnostics for the operator (printed on transitions).
        self.connected = False
        self.sent = 0
        self.dropped = 0

    # --- producer side (mav thread / broadcast loop) ------------------------
    def offer(self, payload: str, kind: str) -> None:
        """Hand a JSON payload to the uplink. Safe from any thread."""
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(self._enqueue, payload, kind)
        except RuntimeError:
            pass  # loop closing during shutdown

    def _enqueue(self, payload: str, kind: str) -> None:
        if kind in _STATE_KINDS:
            # Latest-wins: an older unsent frame is worthless.
            if kind in self._latest:
                self.dropped += 1
            self._latest[kind] = payload
        else:
            if len(self._events) >= EVENT_QUEUE_MAX:
                self._events.pop(0)
                self.dropped += 1
            self._events.append(payload)
        if self._wake is not None:
            self._wake.set()

    # --- consumer side (its own task) ---------------------------------------
    def _due(self, kind: str, now: float) -> bool:
        if self.min_interval <= 0:
            return True
        return now - self._last_sent_at.get(kind, 0.0) >= self.min_interval

    async def _pump(self, ws: Any) -> None:
        assert self._wake is not None
        while True:
            # Events first: they are one-shot and must not be starved by state.
            while self._events:
                await ws.send(self._events.pop(0))
                self.sent += 1
            now = time.monotonic()
            for kind in list(self._latest):
                if self._due(kind, now):
                    await ws.send(self._latest.pop(kind))
                    self._last_sent_at[kind] = now
                    self.sent += 1
            if not self._events and not self._latest:
                self._wake.clear()
                # Wake on new data, or on the next rate-limit boundary.
                timeout = self.min_interval if self.min_interval > 0 else None
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(min(self.min_interval, 0.05) or 0.01)

    async def run(self) -> None:
        """Connect, pump, reconnect forever. Never raises out."""
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        delay = RECONNECT_MIN_S
        headers = {"Authorization": f"Bearer {self.token}"}
        while True:
            try:
                async with websockets.connect(
                    self.url, additional_headers=headers,
                    ping_interval=20, ping_timeout=20, open_timeout=10,
                ) as ws:
                    self.connected = True
                    delay = RECONNECT_MIN_S
                    print(f"[gs] relay uplink connected: {self.url}")
                    if self.flight_id:
                        await ws.send(json.dumps(
                            {"type": "flight", "id": self.flight_id,
                             "startedAt": int(time.time() * 1000)}))
                        self.sent += 1
                    await self._pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                was = self.connected
                self.connected = False
                if was:
                    print(f"[gs] relay uplink lost: {exc!r}")
                # Jittered backoff so a fleet of hubs doesn't synchronize.
                await asyncio.sleep(delay * (0.8 + 0.4 * random.random()))
                delay = min(delay * 2, RECONNECT_MAX_S)
