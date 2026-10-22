"""What the hub believes from senders it has not authenticated, and what it
abandons when the link underneath it changes.

The command websocket has a token because, as `_serve` says every start, the hub
runs an open WiFi on a flight line and anyone in range can reach it. These are
the paths that had no equivalent check:

  * the JSON telemetry feed, an unauthenticated UDP socket whose values went
    into `latest` unexamined and rode every 25 Hz frame to every console;
  * mission/fence/rally plan reads, which any client could loop to hold the
    operator's own uploads off the link;
  * mission/fence/rally item coordinates, which defaulted to 0/0 when absent;
  * and the console fan-out, whose backlog is this process's memory.

Plus the one that is not about a hostile sender at all: a link reopen left every
in-flight handshake addressed to whatever answers on the new link.
"""

from __future__ import annotations

import os

os.environ.setdefault("MAVLINK20", "1")

import pytest                                                    # noqa: E402

from gs.bridge import (                                           # noqa: E402
    CLIENT_BACKLOG_MAX_BYTES,
    PLAN_PULL_COOLDOWN_MS,
    json_value_ok,
    mission_item_fields,
    validate_fence_plan,
)

from test_flight_ready import _bridge, _capturing_loop            # noqa: E402


# --- the unauthenticated JSON feed -----------------------------------------

@pytest.mark.parametrize("key, value", [
    ("alt", {"nested": [1, 2, 3]}),     # a dict where a number belongs
    ("alt", "120"),                     # a string that merely looks numeric
    ("alt", True),                      # bool is an int subclass in Python
    ("armed", "sure"),                  # a string where a bool belongs
    ("armed", 1),                        # and an int, for the same reason
    ("mode", {"x": 1}),
    ("mode", ""),                        # a mode with no name is not a mode
    ("mode", "A" * 200_000),            # one packet, every frame, 25 Hz
    ("lat", "not-a-latitude"),
    ("lat", 500.0),                      # out of range, not a reading
    ("lon", -2000.0),
    ("batteryRemaining", [99] * 10),
    ("batteryRemaining", 900.0),        # a percentage cannot be 900
    ("voltage", -5.0),
])
def test_the_json_feed_cannot_write_unbelievable_values(key, value):
    assert json_value_ok(key, value) is False, (key, value)
    b = _bridge(json_port=0)
    b._apply_json({key: value})
    assert key not in b.latest, f"{key}={value!r} was believed"
    assert b.json_rejected == 1


@pytest.mark.parametrize("key, value", [
    ("alt", 120.5), ("alt", 0), ("lat", 37.4), ("lat", 0.0), ("lon", -122.1),
    ("armed", True), ("armed", False), ("mode", "AUTO.MISSION"),
    ("batteryRemaining", 71), ("voltage", 24.8), ("current", -1.5),
])
def test_believable_values_still_get_through(key, value):
    assert json_value_ok(key, value) is True, (key, value)
    b = _bridge(json_port=0)
    b._apply_json({key: value})
    assert b.latest.get(key) == value
    assert b.json_rejected == 0


def test_a_nan_is_a_reading_that_is_absent_not_a_wrong_type():
    """dumps() renders it as null, which is the contract the console reads --
    see test_nan_from_json_feed_does_not_poison_frames. Rejecting it outright
    would drop the key and turn "no reading" into "never seen", which the
    per-group `ages` exist to keep distinct."""
    b = _bridge(json_port=0)
    b._apply_json({"alt": float("nan")})
    assert "alt" in b.latest
    assert b.json_rejected == 0


def test_a_packet_of_pure_garbage_does_not_fake_a_live_link():
    """`last_json_at` was set at the top of _apply_json, before anything was
    examined, so one malformed UDP packet from anyone in WiFi range made
    _link_state report `alive` with a fabricated position -- when there was no
    aircraft at all."""
    from gs.bridge import _mono_ms
    b = _bridge(json_port=0)
    b._apply_json({"lat": "x", "alt": {"n": 1}, "armed": "yes"})
    assert b.last_json_at == 0, "a frame with nothing believable counted as telemetry"
    assert b._link_state(_mono_ms(), b.last_mav_at or b.last_json_at) == "connecting"


def test_the_battery_readout_is_protected_while_a_real_aircraft_is_flying():
    """voltage/current/batteryRemaining stay feed-owned even with a vehicle
    locked, because PX4 SITL's BATTERY_STATUS is a dummy. That makes these
    checks the only thing between a stray packet and the number an operator
    uses to decide whether to come home."""
    b = _bridge(json_port=0)
    b._vehicle = (1, 1)
    b.latest.update({"voltage": 24.8, "current": 3.1, "batteryRemaining": 71})
    b._apply_json({"voltage": "0.1", "current": [0], "batteryRemaining": 900})
    assert b.latest["voltage"] == 24.8
    assert b.latest["current"] == 3.1
    assert b.latest["batteryRemaining"] == 71


def test_one_packet_cannot_bloat_every_telemetry_frame():
    """Measured before the cap: a 200 kB `mode` took the frame from ~1 kB to
    200 kB, re-broadcast at 25 Hz to every console -- 5 MB/s per client off one
    UDP packet."""
    from gs.bridge import dumps
    b = _bridge(json_port=0)
    b._apply_json({"mode": "A" * 200_000})
    assert len(dumps(dict(b.latest))) < 10_000


def test_the_json_feed_bind_address_can_be_narrowed():
    """`--ws-host` existed for the command socket; this had no equivalent and
    was pinned to every interface."""
    b = _bridge(json_port=0, json_host="127.0.0.1")
    assert b.json_host == "127.0.0.1"
    assert b.status()["jsonHost"] == "127.0.0.1"


# --- plan item coordinates -------------------------------------------------

@pytest.mark.parametrize("kind", [
    "waypoint", "loiter_unlim", "loiter_time", "loiter_turns",
    "fence_inclusion", "fence_exclusion",
    "fence_circle_inclusion", "fence_circle_exclusion", "rally",
])
def test_an_item_that_needs_a_position_refuses_to_default_to_the_null_island(kind):
    """`float(item.get("lat") or 0.0)` was the whole of it, so a missing or null
    coordinate became 0/0 silently -- a fence or a rally point off the coast of
    Africa, and the rally point is where the aircraft diverts to."""
    params = {"vertexCount": 3} if kind.startswith("fence_i") or kind.startswith("fence_e") else {}
    if kind.startswith("fence_circle"):
        params = {"radius": 50}
    with pytest.raises(ValueError, match="lat is required"):
        mission_item_fields(0, {"kind": kind, "alt": 50, "params": params})
    with pytest.raises(ValueError, match="lon is required"):
        mission_item_fields(0, {"kind": kind, "lat": 37.4, "alt": 50, "params": params})


@pytest.mark.parametrize("kind", ["takeoff", "land", "rtl"])
def test_items_that_mean_here_may_still_omit_a_position(kind):
    """A PX4 convention, not an oversight: takeoff and land with lat/lon 0 mean
    "at the current position", which is how a plan that starts from wherever the
    aircraft happens to be is written. RTL is MAV_FRAME_MISSION and carries
    nothing at all."""
    item = {"kind": kind}
    if kind == "takeoff":
        item["alt"] = 30
    f = mission_item_fields(0, item)
    assert f["x"] == 0 and f["y"] == 0


def test_a_mission_takeoff_to_the_ground_is_refused_like_the_verb_is():
    """build_command already refuses `takeoff` with alt <= 0 as "the last thing
    between a malformed request and an aircraft". A mission item said the same
    thing and was sent."""
    with pytest.raises(ValueError, match="alt must be above 0"):
        mission_item_fields(0, {"kind": "takeoff", "alt": 0})
    with pytest.raises(ValueError, match="alt must be above 0"):
        mission_item_fields(0, {"kind": "takeoff", "alt": -5})


@pytest.mark.parametrize("lat, lon", [(500.0, 0.0), (0.0, 2000.0), (91.0, 0.0)])
def test_out_of_range_coordinates_are_refused_before_the_int32_overflows(lat, lon):
    """Past about +/-214 degrees the 1e7 scaling overflows int32 and the upload
    was reported as a radio "timeout" -- blaming the link for a client fault,
    after MISSION_COUNT had already gone out and left PX4 mid-transfer."""
    with pytest.raises(ValueError, match="outside"):
        mission_item_fields(0, {"kind": "waypoint", "lat": lat, "lon": lon, "alt": 50})


def test_a_fence_with_no_coordinates_no_longer_passes_validation():
    """validate_fence_plan exists so that `accepted` means the fence is real. It
    checked vertex counts and radii and never looked at the coordinates, so a
    three-vertex inclusion fence with no position at all was accepted."""
    plan = [{"kind": "fence_inclusion", "params": {}} for _ in range(3)]
    checked = validate_fence_plan(plan)          # count check still passes
    with pytest.raises(ValueError, match="required"):
        [mission_item_fields(i, it) for i, it in enumerate(checked)]


def test_a_non_finite_coordinate_is_refused():
    with pytest.raises(ValueError, match="finite"):
        mission_item_fields(0, {"kind": "waypoint", "lat": float("nan"),
                                "lon": -122.1, "alt": 50})


# --- a link reopen abandons what belonged to the old link ------------------

def test_a_link_reopen_abandons_every_in_flight_handshake():
    """The reopen docstring's own scenario is what made this dangerous: unplug
    the autopilot, attach the radio to an aircraft with a different MAV_SYS_ID,
    and an arm still in `_pending` was retransmitted on the NEW link, addressed
    to TARGET_SYSTEM because the sysid lock had just been dropped. The client
    was then told accepted/timeout about an aircraft it never aimed at.
    _on_vehicle_reboot had always aborted all four; _on_reopen aborted none."""
    events: list = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    b._vehicle = (7, 1)
    b._pending["c1"] = {"mav_cmd": 400, "params": [1, 0, 0, 0, 0, 0, 0],
                        "tries": 1, "at": 0}
    b._param_set_pending["MAV_SYS_ID"] = {"id": "p1", "name": "MAV_SYS_ID",
                                          "value": 2, "tries": 1, "at": 0}
    b._mission = {"op": "upload", "id": "m1", "rtype": "mission",
                  "ack_type": "mission_ack", "items": [], "seq": 0,
                  "tries": 1, "at": 0, "count": 1}

    b._on_reopen()

    assert b._pending == {}, "an arm survived the link it was addressed to"
    assert b._param_set_pending == {}
    assert b._mission is None
    assert b._vehicle is None
    # All three were told why, and told the same thing: the link went away, not
    # "timeout", which is what they would each have reported on their own clock
    # and which points the operator at the radio instead of the reconnect.
    failed = [e for e in events if e.get("ok") is False]
    assert len(failed) == 3, events
    assert {e.get("text") for e in failed} == {"link reopened"}, events
    assert {e.get("id") for e in failed} == {"c1", "p1", "m1"}, events


def test_a_reopen_takes_the_lock_for_the_state_the_other_threads_read():
    """`_vehicle` and `_src_at` are read by the JSON thread and the broadcast
    loop, every other access takes the lock, and these two writes did not --
    which is how the feed could see "no vehicle locked" mid-flight on every
    reconnect and accept position and armed state from an unauthenticated
    packet."""
    import threading

    class SpyLock:
        """A real lock that records whether the shared-state writes were made
        while it was held."""

        def __init__(self):
            self._lock = threading.Lock()
            self.held = False
            self.entered = 0

        def __enter__(self):
            self.entered += 1
            self.held = True
            return self._lock.__enter__()

        def __exit__(self, *exc):
            self.held = False
            return self._lock.__exit__(*exc)

    b = _bridge()
    b._loop = _capturing_loop([])
    b._vehicle = (7, 1)
    b._src_at["attitude"] = 123
    spy = SpyLock()
    b._lock = spy
    # Watch the write itself, not just that the lock was taken somewhere: record
    # the lock state at the moment `_src_at` is cleared.
    seen: list[bool] = []
    real_clear = b._src_at.clear

    class WatchedDict(dict):
        def clear(self):
            seen.append(spy.held)
            super().clear()

    b._src_at = WatchedDict(b._src_at)
    b._on_reopen()
    assert seen == [True], (
        "_on_reopen cleared `_src_at` outside the lock that every other access "
        f"to it takes (lock held during clear: {seen})")
    assert b._vehicle is None and b._src_at == {}
    assert spy.entered >= 1


# --- the console fan-out ---------------------------------------------------

class _FakeTransport:
    def __init__(self, buffered: int):
        self._buffered = buffered

    def get_write_buffer_size(self) -> int:
        return self._buffered


class _FakeClient:
    def __init__(self, buffered: int):
        self.transport = _FakeTransport(buffered)
        self.closed_with: tuple | None = None

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


def test_a_console_that_cannot_keep_up_is_dropped():
    """`websockets.broadcast` is not flow-controlled, so a wedged console's
    backlog is this process's memory -- on a Pi, in the flight-critical
    daemon. The relay had this defect and was given a guard; the hub, which
    matters more, had three broadcast sites and no write-buffer check at all."""
    b = _bridge()
    fast = _FakeClient(0)
    slow = _FakeClient(CLIENT_BACKLOG_MAX_BYTES + 1)
    b._clients = {fast, slow}
    assert b._drop_slow_clients() == 1
    assert slow not in b._clients and fast in b._clients
    assert b.clients_dropped == 1
    assert b.status()["clientsDropped"] == 1


def test_dropping_the_commander_releases_authority_rather_than_stranding_it():
    """Authority is held by a socket. Dropping that socket silently would leave
    the operator with an inert command bar and no explanation."""
    b = _bridge()
    slow = _FakeClient(CLIENT_BACKLOG_MAX_BYTES + 1)
    b._clients = {slow}
    b._commander = slow
    b._drop_slow_clients()
    assert b._commander is None


def test_a_console_merely_a_little_behind_is_left_alone():
    """Dropping a console costs the operator command authority until they
    reconnect, so the threshold sits well past what the 5 s ping cycle already
    allows (~10 s of 25 Hz telemetry)."""
    b = _bridge()
    ok = _FakeClient(CLIENT_BACKLOG_MAX_BYTES - 1)
    b._clients = {ok}
    assert b._drop_slow_clients() == 0
    assert ok in b._clients


def test_a_client_with_no_transport_is_left_alone():
    class Bare:
        pass
    b = _bridge()
    bare = Bare()
    b._clients = {bare}
    assert b._drop_slow_clients() == 0
    assert bare in b._clients


def test_every_broadcast_runs_the_slow_client_check():
    """The relay's version of this guard sat in a helper nothing ever called,
    so the threshold was dead code for as long as it existed. Pin the call."""
    import inspect
    from gs import bridge as mod
    src = inspect.getsource(mod.Bridge)
    for site in ("websockets.broadcast(self._clients, payload)",):
        assert src.count(site) >= 1
    assert "self._drop_slow_clients()" in inspect.getsource(mod.Bridge._do_broadcast)


def test_the_plan_pull_cooldown_is_a_real_bound():
    """A pull holds gs's single mission slot for up to ~4.5 s against a vehicle
    that does not answer, and pulls were open to any client with no cooldown --
    so a loop of them refused the operator's own geofence upload as "busy" for
    as long as anyone cared to keep asking."""
    assert 0 < PLAN_PULL_COOLDOWN_MS <= 60_000
