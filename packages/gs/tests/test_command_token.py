"""Watching the aircraft is open; arming it is not.

gs binds 0.0.0.0 and handed command authority to whoever claimed it first. The
hub's whole premise is an open WiFi on a flight line that people join and open a
page on, so that meant anyone within radio range of the hub could arm the
aircraft. The relay had a token for its own publish socket; the one that can
actually fly the plane had none.

The fix gates ONE message -- the claim -- because that is the only door to
authority. These tests pin that the door is the only door.
"""

from __future__ import annotations

import asyncio
import json
import os

os.environ.setdefault("MAVLINK20", "1")

from pymavlink.dialects.v20 import common as m         # noqa: E402

from gs.bridge import Bridge                           # noqa: E402

TOKEN = "correct-horse-battery-staple"


def _b(**kw):
    kw.setdefault("mavlink_endpoint", "udpin:127.0.0.1:1")
    return Bridge(**kw)


def _run(coro):
    return asyncio.run(coro)


class Sock:
    """A websocket that remembers what gs said to it."""

    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    def acks(self):
        return [m for m in self.sent if m.get("type") == "ack"]


async def _claim(b, ws, token=None, force=False, cid="c1"):
    msg = {"type": "claim", "id": cid, "force": force}
    if token is not None:
        msg["token"] = token
    await b._on_ws_message(ws, json.dumps(msg))


def test_without_a_token_nobody_can_take_command():
    async def scenario():
        b = _b(command_token=TOKEN)
        b._loop = asyncio.get_running_loop()
        ws = Sock()
        await _claim(b, ws)                      # no token offered at all
        assert b._commander is None, "granted authority to an unauthenticated client"
        ack = ws.acks()[-1]
        assert ack["ok"] is False
        assert "token" in ack["text"].lower(), ack["text"]
    _run(scenario())


def test_a_wrong_token_is_refused():
    async def scenario():
        b = _b(command_token=TOKEN)
        b._loop = asyncio.get_running_loop()
        ws = Sock()
        await _claim(b, ws, token="hunter2")
        assert b._commander is None
        assert ws.acks()[-1]["ok"] is False
    _run(scenario())


def test_the_right_token_gets_command():
    async def scenario():
        b = _b(command_token=TOKEN)
        b._loop = asyncio.get_running_loop()
        ws = Sock()
        await _claim(b, ws, token=TOKEN)
        assert b._commander is ws, "refused the correct token"
        assert ws.acks()[-1]["ok"] is True
    _run(scenario())


def test_a_forced_takeover_still_needs_the_token():
    """`force` exists so a pilot can take authority from a phone left on the
    page. It is not a way around the secret -- that would make the secret
    decorative, since force is a flag the attacker also sets."""
    async def scenario():
        b = _b(command_token=TOKEN)
        b._loop = asyncio.get_running_loop()
        good, bad = Sock(), Sock()
        await _claim(b, good, token=TOKEN)
        assert b._commander is good
        await _claim(b, bad, token="hunter2", force=True, cid="c2")
        assert b._commander is good, "force walked past the token"
    _run(scenario())


def test_every_privileged_message_is_refused_without_authority():
    """The claim is gated and nothing else is, which is only safe if authority
    is genuinely the gate on everything. Asserted here rather than assumed, and
    it is the test that should fail if someone adds a privileged message that
    checks something other than `_commander`."""
    async def scenario():
        b = _b(command_token=TOKEN)
        b._loop = asyncio.get_running_loop()
        ws = Sock()
        await _claim(b, ws, token="nope")        # never becomes commander
        assert b._commander is None

        privileged = [
            {"type": "command", "id": "x1", "mav_cmd": int(m.MAV_CMD_COMPONENT_ARM_DISARM),
             "params": [1, 0, 0, 0, 0, 0, 0]},
            {"type": "param_set", "id": "x2", "name": "FW_AIRSPD_TRIM",
             "value": 15.0, "ptype": 9},
            {"type": "mission_push", "id": "x3", "items": []},
            {"type": "fence_push", "id": "x4", "items": []},
            # `param_refresh` is NOT in this list, and that is deliberate: it is
            # a read, open to viewers by design (H22). It is rate-limited for
            # non-commanders instead -- see the cooldown test below.
        ]
        for msg in privileged:
            ws.sent.clear()
            await b._on_ws_message(ws, json.dumps(msg))
            # Refusals come back in whichever envelope that message uses --
            # `ack` for commands and plans, `param_ack` for a parameter write.
            # What matters is ok:false and a reason, not the wrapper.
            refused = [a for a in ws.sent if a.get("ok") is False]
            assert refused, f"{msg['type']} was not refused outright: {ws.sent}"
            assert any("not commander" in (a.get("text") or "")
                       for a in refused), f"{msg['type']} gave no reason: {refused}"
    _run(scenario())


def test_telemetry_is_not_gated_because_watching_is_the_point():
    """A spectator on the hub's WiFi should see the aircraft fly. Gating the
    frame broadcast would have been the easy over-correction, and it would break
    the thing the hub exists to do."""
    b = _b(command_token=TOKEN)
    assert b._token_ok(None) is False            # cannot command
    # ...but the broadcast path takes no token and knows nothing about one.
    import inspect
    src = inspect.getsource(b._broadcast)
    assert "token" not in src, "the broadcast grew a token check"


def test_an_unset_token_keeps_the_old_behaviour_deliberately():
    """Bench and SITL work would be miserable if a token were mandatory, and a
    daemon that refuses to run without one gets run with the check patched out.
    Unsecured is a configuration, announced at startup, not an accident."""
    async def scenario():
        b = _b(command_token="")
        b._loop = asyncio.get_running_loop()
        ws = Sock()
        await _claim(b, ws)
        assert b._commander is ws
    _run(scenario())
    assert _b(command_token="").status()["commandTokenRequired"] is False
    assert _b(command_token=TOKEN).status()["commandTokenRequired"] is True


def test_the_token_itself_is_never_in_the_status_snapshot():
    """`commandant status` is something you run in front of other people, and
    status is broadcast to every connected client -- including the ones that
    could not claim authority."""
    s = _b(command_token=TOKEN).status()
    assert TOKEN not in json.dumps(s)


def test_a_viewer_cannot_hold_the_link_by_re_reading_parameters():
    """H22 keeps a parameter refresh open to any client on the grounds that it
    is a read, that concurrent requests dedupe and that the walk is paced to a
    share of the link. All true -- and none of it covers REPETITION. A walk is
    ~10 s of 30% of a 57600 radio, so a client asking again the moment each one
    finishes holds that 30% indefinitely, during someone's flight, with no
    recourse for the operator.

    The commander is exempt on purpose: a vehicle reboot clears every parameter
    and re-reading at once is the right response, so a cooldown that blocked the
    pilot would be a worse bug than the one it fixes."""
    async def scenario():
        b = _b()
        b._loop = asyncio.get_running_loop()
        pilot, viewer = Sock(), Sock()
        await _claim(b, pilot)
        assert b._commander is pilot

        await b._on_ws_message(viewer, json.dumps({"type": "param_refresh", "id": "v1"}))
        assert not b._param_queue.empty(), "a viewer's first refresh was refused"
        while not b._param_queue.empty():
            b._param_queue.get_nowait()

        viewer.sent.clear()
        await b._on_ws_message(viewer, json.dumps({"type": "param_refresh", "id": "v2"}))
        assert b._param_queue.empty(), "a viewer re-read the whole set immediately"
        told = [x for x in viewer.sent if x.get("error")]
        assert told and "shared" in told[-1]["error"], told
        assert "again in" in told[-1]["error"], "did not say when it could retry"

        # The pilot is never made to wait.
        await b._on_ws_message(pilot, json.dumps({"type": "param_refresh", "id": "p1"}))
        assert not b._param_queue.empty(), "the commander was rate-limited"
    _run(scenario())


def test_the_token_rides_on_the_claim_and_nothing_else_needs_one():
    """A deliberately small surface. Gating each privileged message would be a
    list to keep in step with the code, and that list is wrong the first time
    somebody adds a message. Authority is already the gate on everything, so
    the secret sits on the one door into authority."""
    import inspect

    from gs.bridge import Bridge as B
    src = inspect.getsource(B._on_ws_message)
    # Exactly one token check, and it is in the claim branch.
    assert src.count("_token_ok") == 1, "the token check spread beyond the claim"
    claim_part = src[src.index('mtype == "claim"'):src.index('elif mtype == "command"')]
    assert "_token_ok" in claim_part, "the token check is not on the claim"


def test_an_empty_offer_is_not_equal_to_an_unset_token():
    """`secrets.compare_digest("", "")` is True, so a hub that meant to require
    a token and shipped an empty one would accept an empty offer. The guard is
    that an empty CONFIGURED token means unsecured-by-configuration, which is
    announced, and anything else demands a non-empty match."""
    b = _b(command_token=TOKEN)
    assert b._token_ok("") is False
    assert b._token_ok(None) is False
    assert b._token_ok(0) is False
    assert b._token_ok(TOKEN) is True
