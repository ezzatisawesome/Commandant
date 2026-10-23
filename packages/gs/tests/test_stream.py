"""Stream control: the rate change that reports what the autopilot said.

This used to be fire-and-forget. gs pushed a COMMAND_LONG onto a misc queue and
never looked for the reply, so PX4's COMMAND_ACK arrived, matched nothing in the
pending registry, and was dropped -- a rate the autopilot refused looked exactly
like one it took. It is a tracked command now, and these tests hold that:

  * the ACCEPTED path round-trips an ack to the client that asked;
  * an UNSUPPORTED result comes back as ok:false WITH the reason, which is the
    whole reason for the change;
  * the Hz -> microsecond mapping (including "0 means stop") is correct and
    lives in exactly one place;
  * authority still applies, because this changes what the vehicle transmits.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest
import websockets

# Importing the bridge first sets MAVLINK20=1 so pymavlink loads the v2 dialect.
from gs.bridge import Bridge, build_command
from pymavlink import mavutil


async def _recv_until(ws, predicate, tries=200, timeout=0.5):
    for _ in range(tries):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            continue
        if predicate(msg):
            return msg
    return None


def _fake_px4(port: int, ack_result: int, stop: threading.Event, seen: list) -> None:
    """Heartbeat so gs learns our address, then ack any COMMAND_LONG, recording
    the SET_MESSAGE_INTERVAL ones so the test can read the wire values."""
    px4 = mavutil.mavlink_connection(
        f"udpout:127.0.0.1:{port}", source_system=1, source_component=1)
    last_hb = 0.0
    while not stop.is_set():
        now = time.time()
        if now - last_hb > 0.1:
            px4.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_FIXED_WING, mavutil.mavlink.MAV_AUTOPILOT_PX4,
                0, 0, mavutil.mavlink.MAV_STATE_ACTIVE)
            last_hb = now
        msg = px4.recv_match(blocking=True, timeout=0.1)
        if msg is not None and msg.get_type() == "COMMAND_LONG":
            if msg.command == mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL:
                seen.append((msg.param1, msg.param2))
            px4.mav.command_ack_send(msg.command, ack_result)


def _run_stream(ports, ack_result, msg_id=30, hz=10.0):
    """Claim authority, ask for a rate, return (ack, wire params PX4 saw)."""
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
                    json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()
    stop = threading.Event()
    seen: list = []
    threading.Thread(target=_fake_px4, args=(ports["mav"], ack_result, stop, seen),
                     daemon=True).start()
    out = {}

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.4)  # let gs learn PX4's address from heartbeats
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            await ws.send(json.dumps({"type": "claim", "id": "c1"}))
            claim = await _recv_until(ws, lambda m: m.get("type") == "ack" and m.get("id") == "c1")
            assert claim and claim["ok"] is True

            await ws.send(json.dumps({
                "type": "command", "id": "s1", "name": "set_message_interval",
                "args": {"msgId": msg_id, "hz": hz},
            }))
            out["ack"] = await _recv_until(
                ws, lambda m: m.get("type") == "ack" and m.get("id") == "s1")
        serve_task.cancel()

    try:
        asyncio.run(scenario())
    finally:
        stop.set()
    return out.get("ack"), seen


def _period_for(seen: list, msg_id: int) -> float:
    """The period PX4 was asked to use for `msg_id`.

    gs requests a few extra streams of its own at startup (375, 87, 231), so the
    recording holds those too; pick out the one this test asked for rather than
    whichever arrived first.
    """
    for p1, p2 in seen:
        if round(p1) == msg_id:
            return p2
    raise AssertionError(f"PX4 never saw a SET_MESSAGE_INTERVAL for {msg_id}: {seen}")


def test_stream_change_is_acked(ports):
    ack, seen = _run_stream(ports, mavutil.mavlink.MAV_RESULT_ACCEPTED, msg_id=30, hz=10.0)
    assert ack is not None, "no ack for a stream rate change"
    assert ack["ok"] is True
    assert ack["result"] == 0
    assert ack["text"] == "accepted"
    # And the vehicle was asked for the right thing: message 30 at 100_000 us.
    assert _period_for(seen, 30) == pytest.approx(100_000, rel=1e-3)


def test_unsupported_rate_says_so(ports):
    # The case that motivated all this: PX4 declining the request. Before, this
    # was indistinguishable from success.
    ack, _ = _run_stream(ports, mavutil.mavlink.MAV_RESULT_UNSUPPORTED)
    assert ack is not None
    assert ack["ok"] is False
    assert ack["text"] == "unsupported"


def test_zero_hz_asks_px4_to_stop_the_stream(ports):
    _, seen = _run_stream(ports, mavutil.mavlink.MAV_RESULT_ACCEPTED, msg_id=147, hz=0)
    # -1, not 0: PX4 reads 0 as "default rate", which is not what "off" means.
    assert _period_for(seen, 147) == pytest.approx(-1)


def test_stream_change_needs_authority(ports):
    bridge = Bridge(mavlink_endpoint=f"udpin:127.0.0.1:{ports['mav']}",
                    json_port=ports["json"], ws_port=ports["ws"])
    threading.Thread(target=bridge._mav_loop, daemon=True).start()

    async def scenario():
        serve_task = asyncio.create_task(bridge._serve())
        await asyncio.sleep(0.3)
        async with websockets.connect(f"ws://127.0.0.1:{ports['ws']}") as ws:
            # No claim: a rate change alters what the vehicle transmits for every
            # client on the link, so it is commander-only like any command.
            await ws.send(json.dumps({
                "type": "command", "id": "x1", "name": "set_message_interval",
                "args": {"msgId": 30, "hz": 5},
            }))
            ack = await _recv_until(ws, lambda m: m.get("type") == "ack" and m.get("id") == "x1")
            assert ack is not None
            assert ack["ok"] is False
            assert ack["text"] == "not commander"
        serve_task.cancel()

    asyncio.run(scenario())


# --- the Hz -> microseconds mapping, which both paths now share --------------

def test_rate_maps_to_microsecond_period():
    cmd, params = build_command("set_message_interval", {"msgId": 30, "hz": 10})
    assert cmd == mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL
    assert params[0] == pytest.approx(30)
    assert params[1] == pytest.approx(100_000)
    assert params[2:] == [0, 0, 0, 0, 0]


@pytest.mark.parametrize("hz", [0, 0.0, -1, None])
def test_no_rate_disables_the_stream(hz):
    _, params = build_command("set_message_interval", {"msgId": 33, "hz": hz})
    # -1, not 0: PX4 reads 0 as "default rate", which is not what "off" means.
    assert params[1] == pytest.approx(-1)


def test_fractional_rates_survive():
    # A battery at one sample every ten seconds is a legitimate ask.
    _, params = build_command("set_message_interval", {"msgId": 147, "hz": 0.1})
    assert params[1] == pytest.approx(10_000_000)


@pytest.mark.parametrize("args", [
    {},                                 # no msgId at all
    {"msgId": None, "hz": 5},
    {"msgId": "ATTITUDE", "hz": 5},     # a label, not an id
    {"msgId": -3, "hz": 5},
    {"msgId": 30, "hz": float("nan")},  # 1e6/nan would be nan on the wire
])
def test_malformed_requests_are_refused(args):
    # build_command's ValueError is what the WS handler turns into an ok:false
    # ack, so a bad request is answered rather than crashing the handler.
    with pytest.raises(ValueError):
        build_command("set_message_interval", args)
