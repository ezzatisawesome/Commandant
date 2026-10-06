"""Relay behaviour, with the read-only guarantee as the headline test.

The relay is the only Commandant component exposed to the internet, so its
contract is narrow and worth pinning precisely: a viewer can receive and can
never transmit anywhere that matters, a late joiner sees current state at once,
and the publisher needs a token.
"""

from __future__ import annotations

import asyncio
import json
import socket

import pytest
import websockets

from relay.server import Relay


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Harness:
    """A running relay plus helpers to connect publishers and viewers."""

    def __init__(self, token: str = "t0k3n") -> None:
        self.token = token
        self.port = _free_port()
        self.relay = Relay(token=token, host="127.0.0.1", port=self.port)
        self._task: asyncio.Task | None = None

    async def __aenter__(self) -> "Harness":
        self._task = asyncio.create_task(self.relay.serve_forever())
        await asyncio.sleep(0.2)
        return self

    async def __aexit__(self, *exc) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    def publish_url(self, token: str | None = None) -> str:
        t = self.token if token is None else token
        return f"ws://127.0.0.1:{self.port}/publish?token={t}"

    def watch_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/"

    async def publisher(self, token: str | None = None):
        return await websockets.connect(self.publish_url(token))

    async def viewer(self):
        return await websockets.connect(self.watch_url())


async def _recv_until(ws, predicate, tries=40, timeout=0.5):
    for _ in range(tries):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            continue
        if predicate(msg):
            return msg
    return None


TELEM = {"type": "telemetry", "t": 1, "connected": True, "linkState": "alive",
         "lat": 37.4, "lon": -122.1, "alt": 120, "mode": "AUTO.MISSION"}


@pytest.mark.asyncio
async def test_frame_reaches_every_viewer():
    async with Harness() as h:
        pub = await h.publisher()
        v1 = await h.viewer()
        v2 = await h.viewer()
        await asyncio.sleep(0.1)
        await pub.send(json.dumps(TELEM))
        for v in (v1, v2):
            got = await _recv_until(v, lambda m: m.get("type") == "telemetry")
            assert got is not None and got["lat"] == 37.4
        await pub.close(); await v1.close(); await v2.close()


@pytest.mark.asyncio
async def test_publishing_requires_the_token():
    async with Harness() as h:
        with pytest.raises(Exception):
            ws = await h.publisher(token="wrong")
            await ws.recv()
        # And a viewer connection needs no token at all.
        v = await h.viewer()
        assert v.state.name in ("OPEN", "CONNECTING")
        await v.close()


@pytest.mark.asyncio
async def test_a_viewer_can_never_reach_the_publisher():
    """THE safety property: anything a viewer sends is discarded, and the
    publisher socket is never written to. A hostile browser has no route to the
    aircraft because no code path exists, not because a flag says so."""
    async with Harness() as h:
        pub = await h.publisher()
        v = await h.viewer()
        await asyncio.sleep(0.1)
        # A viewer tries every shape of command the hub would understand.
        for hostile in ({"type": "claim", "id": "x"},
                        {"type": "command", "id": "x", "name": "arm", "args": {}},
                        {"type": "command", "id": "x", "name": "disarm", "args": {}},
                        {"type": "param_set", "id": "x", "name": "NAV_RCL_ACT", "value": 0},
                        {"type": "mission_push", "id": "x", "items": []}):
            await v.send(json.dumps(hostile))
        await asyncio.sleep(0.3)
        # The publisher received nothing whatsoever.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(pub.recv(), timeout=0.4)
        # And the relay is still healthy: a real frame still flows.
        await pub.send(json.dumps(TELEM))
        assert await _recv_until(v, lambda m: m.get("type") == "telemetry") is not None
        await pub.close(); await v.close()


@pytest.mark.asyncio
async def test_late_joiner_gets_current_state_immediately():
    """A fresh page load must not wait for the next tick to draw the aircraft."""
    async with Harness() as h:
        pub = await h.publisher()
        await asyncio.sleep(0.1)
        await pub.send(json.dumps(TELEM))
        await pub.send(json.dumps({"type": "mission", "count": 1, "items": [
            {"seq": 0, "kind": "waypoint", "lat": 37.4, "lon": -122.1, "alt": 100}]}))
        await asyncio.sleep(0.2)

        v = await h.viewer()  # joins after both messages were sent
        kinds = set()
        for _ in range(6):
            try:
                kinds.add(json.loads(await asyncio.wait_for(v.recv(), timeout=0.5))["type"])
            except asyncio.TimeoutError:
                break
        assert "telemetry" in kinds and "mission" in kinds
        await pub.close(); await v.close()


@pytest.mark.asyncio
async def test_viewers_are_told_when_the_hub_disappears():
    """Freezing the last frame would read as a live aircraft. It must not."""
    async with Harness() as h:
        pub = await h.publisher()
        v = await h.viewer()
        await asyncio.sleep(0.1)
        await pub.send(json.dumps(TELEM))
        assert await _recv_until(v, lambda m: m.get("type") == "telemetry") is not None
        await pub.close()
        lost = await _recv_until(v, lambda m: m.get("type") == "link" and m.get("state") == "lost")
        assert lost is not None
        # A viewer arriving while no hub is publishing is told the same thing.
        v2 = await h.viewer()
        assert await _recv_until(v2, lambda m: m.get("state") == "lost") is not None
        await v.close(); await v2.close()


@pytest.mark.asyncio
async def test_reconnecting_hub_supersedes_its_stale_socket():
    """A hub that reconnects after a network blip must take over the stream
    rather than be refused by its own half-open previous connection."""
    async with Harness() as h:
        old = await h.publisher()
        await asyncio.sleep(0.1)
        new = await h.publisher()
        await asyncio.sleep(0.2)
        v = await h.viewer()
        await asyncio.sleep(0.1)
        await new.send(json.dumps(TELEM))
        assert await _recv_until(v, lambda m: m.get("type") == "telemetry") is not None
        assert h.relay._publisher is not None
        await new.close(); await v.close()
        try:
            await old.close()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_a_dead_viewer_does_not_stop_the_others():
    async with Harness() as h:
        pub = await h.publisher()
        doomed = await h.viewer()
        alive = await h.viewer()
        await asyncio.sleep(0.1)
        await doomed.close()
        await asyncio.sleep(0.1)
        for i in range(10):
            await pub.send(json.dumps({**TELEM, "t": i}))
        got = await _recv_until(alive, lambda m: m.get("type") == "telemetry")
        assert got is not None
        await pub.close(); await alive.close()


@pytest.mark.asyncio
async def test_junk_from_the_publisher_is_ignored():
    async with Harness() as h:
        pub = await h.publisher()
        v = await h.viewer()
        await asyncio.sleep(0.1)
        await pub.send("not json")
        await pub.send(json.dumps([1, 2, 3]))
        await pub.send(json.dumps(TELEM))
        assert await _recv_until(v, lambda m: m.get("type") == "telemetry") is not None
        await pub.close(); await v.close()
