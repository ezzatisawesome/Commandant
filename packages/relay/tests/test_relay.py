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


@pytest.mark.asyncio
async def test_a_finished_flight_is_not_replayed_to_a_later_viewer():
    """Retention makes a page load instant DURING a flight. After the hub goes
    away it must not hand the next viewer the last frame, or the page shows an
    aircraft parked at the previous flight's final position as though it were
    live."""
    async with Harness() as h:
        pub = await h.publisher()
        await asyncio.sleep(0.1)
        await pub.send(json.dumps(TELEM))
        await pub.send(json.dumps({"type": "mission", "count": 1, "items": [
            {"seq": 0, "kind": "waypoint", "lat": 37.4, "lon": -122.1, "alt": 100}]}))
        await asyncio.sleep(0.2)
        # Mid-flight: a joiner does get the current state at once.
        mid = await h.viewer()
        assert await _recv_until(mid, lambda m: m.get("type") == "telemetry") is not None
        await mid.close()

        await pub.close()          # flight over
        await asyncio.sleep(0.3)

        after = await h.viewer()
        kinds = []
        for _ in range(5):
            try:
                kinds.append(json.loads(await asyncio.wait_for(after.recv(), timeout=0.4))["type"])
            except asyncio.TimeoutError:
                break
        assert "telemetry" not in kinds, f"stale flight replayed: {kinds}"
        assert "mission" not in kinds, f"stale plan replayed: {kinds}"
        assert kinds == ["link"]
        await after.close()


@pytest.mark.asyncio
async def test_a_wedged_hub_also_stops_being_replayed(monkeypatch):
    """A hub whose socket stays open but stops sending is not flying either."""
    from relay import server as mod
    monkeypatch.setattr(mod, "STALE_AFTER_S", 0.3)
    async with Harness() as h:
        pub = await h.publisher()
        await asyncio.sleep(0.1)
        await pub.send(json.dumps(TELEM))
        await asyncio.sleep(1.6)   # go quiet without closing

        late = await h.viewer()
        kinds = []
        for _ in range(4):
            try:
                kinds.append(json.loads(await asyncio.wait_for(late.recv(), timeout=0.4))["type"])
            except asyncio.TimeoutError:
                break
        assert "telemetry" not in kinds, f"stale frame replayed: {kinds}"
        await late.close(); await pub.close()


# --- a slow viewer must not grow a buffer inside this process ---------------

class FakeTransport:
    def __init__(self, buffered: int):
        self._buffered = buffered

    def get_write_buffer_size(self) -> int:
        return self._buffered


class FakeViewer:
    """Stands in for a viewer socket with a given amount of unsent data."""

    def __init__(self, buffered: int):
        self.transport = FakeTransport(buffered)
        self.closed_with: tuple | None = None

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


def test_a_viewer_that_cannot_keep_up_is_dropped():
    """Constraint 3 -- a slow viewer cannot affect the hub or other viewers --
    was implemented in a `_fan_out` helper that nothing ever called. Every
    broadcast went through `websockets.broadcast`, which is explicitly NOT
    flow-controlled: per its own docs it "pushes the message synchronously to
    all connections even if their write buffers are overflowing... messages
    will pile up in its write buffer". This is the only component on the public
    internet, viewers are unauthenticated, and it runs on one small machine.

    So the buffer check has to actually run. Closing the slow viewer is also
    better for that viewer: it reconnects and gets the retained state, which is
    a correct current screen rather than a backlog of superseded frames."""
    from relay.server import SLOW_VIEWER_BYTES

    relay = Relay(token="t", host="127.0.0.1", port=0)
    keeping_up = FakeViewer(1024)
    backed_up = FakeViewer(SLOW_VIEWER_BYTES + 1)
    relay._viewers.update({keeping_up, backed_up})

    async def scenario():
        assert relay._drop_slow_viewers() == 1
        await asyncio.sleep(0)       # let the fire-and-forget close run

    asyncio.run(scenario())


    assert backed_up not in relay._viewers, "a runaway viewer was kept"
    assert keeping_up in relay._viewers, "dropped a viewer that was keeping up"
    assert relay.viewers_dropped == 1
    assert backed_up.closed_with is not None
    assert backed_up.closed_with[0] == 1013      # "try again later"


def test_every_broadcast_runs_the_slow_viewer_check():
    """The bug was not a wrong check, it was a check nothing called. Pin the
    call site, not just the helper."""
    relay = Relay(token="t", host="127.0.0.1", port=0)
    called = []
    relay._drop_slow_viewers = lambda: called.append(True) or 0

    async def scenario():
        await relay._broadcast(json.dumps({"type": "telemetry"}))
    asyncio.run(scenario())
    assert called, "a broadcast went out without checking for slow viewers"


def test_dropping_a_slow_viewer_is_counted_for_healthz():
    """`frames_dropped` was permanently 0, which made the /healthz figure a
    reassuring lie. It has to move when something is actually dropped."""
    from relay.server import SLOW_VIEWER_BYTES

    relay = Relay(token="t", host="127.0.0.1", port=0)
    relay._viewers.add(FakeViewer(SLOW_VIEWER_BYTES * 4))
    assert relay.frames_dropped == 0
    relay._drop_slow_viewers()
    assert relay.frames_dropped == 1
    assert relay.viewers_dropped == 1


def test_a_viewer_with_no_transport_is_left_alone():
    """Not every connection object exposes a transport; an unknown buffer state
    is not evidence of a slow viewer, and guessing would disconnect healthy
    browsers."""
    relay = Relay(token="t", host="127.0.0.1", port=0)

    class NoTransport:
        transport = None
    v = NoTransport()
    relay._viewers.add(v)
    assert relay._drop_slow_viewers() == 0
    assert v in relay._viewers
    assert relay.viewers_dropped == 0


def test_the_token_is_compared_in_constant_time():
    # A source-inspection guard, deliberately: the property is "which function
    # is used", and timing cannot be asserted reliably in a test.
    """Hygiene, not a measured hole: a timing attack across a WebSocket
    handshake is impractical because network jitter dwarfs a string compare.
    It is free, though, and this is the one component on the internet."""
    import inspect

    from relay import server
    src = inspect.getsource(server.Relay._handler)
    assert "compare_digest" in src, "token compared with a plain !="


async def test_an_unset_token_refuses_every_publish():
    """Fail closed, for real rather than by inspection: a relay started with no
    token must not become an open write endpoint on the internet."""
    async with Harness(token="") as h:
        for attempt in ("", "anything", "None"):
            with pytest.raises(Exception):
                pub = await websockets.connect(
                    f"ws://127.0.0.1:{h.port}/publish?token={attempt}")
                await pub.send(json.dumps({"type": "telemetry", "lat": 1}))
                await pub.recv()          # closed by the relay
        assert h.relay._publisher is None
        assert h.relay.frames_in == 0


def test_a_superseding_publisher_claims_the_slot_before_awaiting():
    # Also source inspection. The behavioural version needs a three-way race
    # with a controllable close, which would be flaky for a window this narrow;
    # an ordering guard is the honest trade.
    """`_publisher` was set to None while awaiting the old socket's close,
    leaving a window where a third connection saw the slot free, took it, and
    was overwritten when the first resumed — two hubs interleaving frames into
    one stream. Unreachable with a single hub, reachable with one reconnecting
    fast."""
    import inspect
    src = inspect.getsource(Relay._handle_publisher)
    claim = src.index("old, self._publisher = self._publisher")
    await_close = src.index("await old.close")
    assert claim < await_close
    assert "self._publisher, ws" in src, "still clears the slot before awaiting"
