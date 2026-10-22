"""PX4's long messages arrive in pieces.

MAVLink 2 STATUSTEXT holds 50 characters; anything longer is split across
messages sharing an `id` and numbered by `chunk_seq`, and the receiver joins
them. gs ignored both fields, so the longest messages -- which are the ones
that explain why the autopilot refused something -- reached the operator broken
mid-word across two log lines.

MEASURED against real PX4 (SITL, no barometer, asked to arm):
    sev=2 id=15 chunk_seq=0 'Arming denied: Resolve system health failures firs'
    sev=2 id=15 chunk_seq=1 't'
The stand-in autopilot only ever sent short strings, which is why five passes of
testing against it could not see this.
"""

from __future__ import annotations

import os

os.environ.setdefault("MAVLINK20", "1")

from gs.bridge import STATUSTEXT_RUN_TIMEOUT_MS                  # noqa: E402

from test_flight_ready import _bridge, _capturing_loop           # noqa: E402


class Chunk:
    """A STATUSTEXT as pymavlink presents one."""

    def __init__(self, text, sid=0, seq=0, severity=2):
        self.text = text
        self.id = sid
        self.chunk_seq = seq
        self.severity = severity


def _texts(events):
    return [e["text"] for e in events if e.get("type") == "statustext"]


def _b():
    events: list = []
    b = _bridge()
    b._loop = _capturing_loop(events)
    return b, events


def test_the_real_px4_arming_refusal_arrives_as_one_sentence():
    b, events = _b()
    b._on_statustext(Chunk("Arming denied: Resolve system health failures firs", sid=15, seq=0))
    assert _texts(events) == [], "emitted an incomplete first chunk"
    b._on_statustext(Chunk("t", sid=15, seq=1))
    assert _texts(events) == ["Arming denied: Resolve system health failures first"]


def test_an_unchunked_message_is_not_delayed():
    """id == 0 means not chunked, and is the common case: it must not wait for a
    terminator that is never coming."""
    b, events = _b()
    b._on_statustext(Chunk("Switching to Return", sid=0, seq=0))
    assert _texts(events) == ["Switching to Return"]


def test_chunks_that_arrive_out_of_order_are_still_joined_in_order():
    """A radio reorders. The sequence number is there to be used."""
    b, events = _b()
    b._on_statustext(Chunk("B" * 50, sid=7, seq=1))
    b._on_statustext(Chunk("A" * 50, sid=7, seq=0))
    b._on_statustext(Chunk("C", sid=7, seq=2))
    assert _texts(events) == ["A" * 50 + "B" * 50 + "C"]


def test_a_lost_chunk_still_delivers_what_arrived_marked_partial():
    """The alternative is silence about a refusal. A partial reason an operator
    can see is partial beats no reason at all."""
    b, events = _b()
    b._on_statustext(Chunk("A" * 50, sid=9, seq=0))
    b._on_statustext(Chunk("tail", sid=9, seq=2))      # seq 1 never came
    got = _texts(events)
    assert len(got) == 1, got
    assert got[0].startswith("A" * 50)
    assert "incomplete" in got[0], got[0]


def test_a_run_whose_last_chunk_never_comes_is_flushed_when_it_goes_quiet():
    b, events = _b()
    b._on_statustext(Chunk("A" * 50, sid=11, seq=0))
    assert _texts(events) == []
    b._text_runs[11]["at"] -= STATUSTEXT_RUN_TIMEOUT_MS + 1
    b._expire_text_runs()
    assert _texts(events) == ["A" * 50], "a lost final chunk lost the message"


def test_two_interleaved_runs_do_not_contaminate_each_other():
    """The `id` field exists so that concurrent runs CAN interleave, so a new id
    must not disturb a pending one -- my first version flushed the old run and
    would have truncated a message that was merely interleaved. Abandoned runs
    are the timeout's job, not this one's."""
    b, events = _b()
    b._on_statustext(Chunk("A" * 50, sid=1, seq=0))
    b._on_statustext(Chunk("B" * 50, sid=2, seq=0))
    b._on_statustext(Chunk("bee", sid=2, seq=1))
    assert _texts(events) == ["B" * 50 + "bee"], _texts(events)
    b._on_statustext(Chunk("ay", sid=1, seq=1))
    assert _texts(events) == ["B" * 50 + "bee", "A" * 50 + "ay"], _texts(events)


def test_a_sender_that_never_terminates_cannot_grow_memory():
    b, events = _b()
    for i in range(40):
        b._on_statustext(Chunk("x" * 50, sid=3, seq=i))
    assert len(b._text_runs) == 0, "held an unterminated run open"
    assert _texts(events), "never emitted anything"


def test_a_nul_terminator_ends_a_run_even_at_full_width():
    """The spec allows a NUL inside the 50 bytes as the end marker."""
    b, events = _b()
    b._on_statustext(Chunk("done\x00", sid=4, seq=0))
    assert _texts(events) == ["done"]


# --- the other thing real PX4 showed, which the stand-in never could ---------

def test_a_stream_that_never_comes_is_not_asked_for_every_second_forever():
    """Found against real PX4: gs re-asked for three streams once a second for
    as long as it ran, and PX4 ACCEPTED every one of them -- 66 COMMAND_ACKs in
    25 s. It is not refusing; it simply has no such data to send (no airspeed
    sensor means no WIND_COV, no configured actuators means no
    ACTUATOR_OUTPUT_STATUS). The stand-in always answered, so the loop always
    terminated and five passes of testing never saw it.

    On a 57600 half-duplex radio that standing conversation is 201 B/s, 5.8% of
    air time, permanently, to re-ask a question already answered."""
    from gs.bridge import (MSG_WIND_COV, STREAM_REQ_MAX_MS,
                           STREAM_REQ_MIN_MS)

    b, _ = _b()
    b._vehicle = (1, 1)

    class Conn:
        def __init__(self):
            self.sent = 0
            self.mav = self

        def command_long_send(self, *a, **k):
            self.sent += 1

    conn = Conn()
    # One hour of heartbeats, for a stream that never arrives.
    now = 0
    for _ in range(3600):
        now += 1000
        b._mono_now = now
        import gs.bridge as mod
        mod._mono_ms = lambda n=now: n
        b._request_message(conn, 1, 1, MSG_WIND_COV)

    # Unbounded would be 3600. Backoff caps it at roughly one a minute.
    assert conn.sent < 80, f"sent {conn.sent} requests in an hour"
    assert conn.sent > 5, "stopped asking altogether; a lost request never recovers"


def test_a_vehicle_reboot_asks_again_promptly_not_at_the_backed_off_rate():
    """A rebooted autopilot is back on PX4's defaults and never saw our
    SET_MESSAGE_INTERVALs, so patience built up against the previous instance
    must not carry over."""
    from gs.bridge import MSG_WIND_COV

    b, _ = _b()
    b._req_tries[MSG_WIND_COV] = 12
    b._last_req_at[MSG_WIND_COV] = 1
    b._vehicle = (1, 1)
    b._on_vehicle_reboot(0, 1234)
    assert b._req_tries == {}, "a reboot inherited the old backoff"


def test_a_reboot_is_noticed_on_a_vehicle_that_never_reports_a_position():
    """gs read the vehicle's uptime clock from GLOBAL_POSITION_INT and nowhere
    else. MEASURED against real PX4 with no position estimate: 22 SYSTEM_TIME
    and ZERO GLOBAL_POSITION_INT in 25 seconds. So on a bench, indoors, on a
    HITL rig, or simply before GPS lock, gs could not detect a reboot at all --
    and a reboot is the event that invalidates every cached parameter, which is
    the entire reason gs announces one."""
    b, events = _b()
    b._vehicle = (1, 1)

    class SysTime:
        def __init__(self, boot):
            self.time_boot_ms = boot
        def get_type(self): return "SYSTEM_TIME"
        def get_srcSystem(self): return 1
        def get_srcComponent(self): return 1

    for boot in (30_000, 31_000, 32_000):
        b._on_mav_state(0, "SYSTEM_TIME", SysTime(boot))
    assert b._reboot_pending is None, "called a rising clock a reboot"
    assert b.latest["bootMs"] == 32_000

    b._on_mav_state(0, "SYSTEM_TIME", SysTime(400))      # the vehicle restarted
    assert b._reboot_pending == 400, "a reboot went unnoticed without a position"


def test_the_position_handler_still_refuses_a_reordered_frame():
    """The discriminator moved; its judgement must not have. A straggler's
    POSITION is as stale as its clock, so the frame is dropped whole."""
    b, _ = _b()
    b._vehicle = (1, 1)

    class Gpi:
        def __init__(self, boot, lat):
            self.time_boot_ms, self.lat = boot, int(lat * 1e7)
            self.lon, self.alt, self.relative_alt = 0, 0, 0
            self.vx = self.vy = self.vz = 0
            self.hdg = 0
        def get_type(self): return "GLOBAL_POSITION_INT"

    for boot, lat in ((30_000, 37.1), (31_000, 37.2)):
        b._on_mav_state(0, "GLOBAL_POSITION_INT", Gpi(boot, lat))
    assert b.latest["lat"] == 37.2
    # A straggler from 2 s earlier: below REBOOT_GAP_MS, so it is held as a
    # suspect and its position must not land.
    b._on_mav_state(0, "GLOBAL_POSITION_INT", Gpi(29_000, 99.9))
    assert b.latest["lat"] == 37.2, "a reordered frame moved the aircraft"


# --- asking the vehicle to stop sending what gs never reads ------------------

class _TrimConn:
    def __init__(self):
        self.sent = []
        self.mav = self

    def command_long_send(self, tsys, tcomp, cmd, conf, p1, p2, *rest):
        self.sent.append((cmd, int(p1), int(p2)))


def test_streams_gs_never_reads_are_turned_off_at_the_source():
    """MEASURED against real PX4 over a fat pipe: 7986 messages in 30 s, of
    which HIGHRES_IMU, ATTITUDE_QUATERNION, LOCAL_POSITION_NED and ODOMETRY
    were 3984 -- half the traffic, decoded and discarded. 11.9 kB/s, 43 MB an
    hour, and 5.5% of a core here (an estimated 28% of a Pi 4's).

    Trimming them took the same rig to 131 msg/s and 3.4% of a core."""
    from gs.bridge import STREAM_REQ_MIN_MS, _TRIMMABLE
    import gs.bridge as mod

    b, _ = _b()
    b._vehicle = (1, 1)
    conn = _TrimConn()
    b._trim_stream(conn, "ODOMETRY")
    assert len(conn.sent) == 1, "did not ask the vehicle to stop"
    cmd, msg_id, interval = conn.sent[0]
    assert cmd == 511, "not SET_MESSAGE_INTERVAL"
    assert msg_id == _TRIMMABLE["ODOMETRY"]
    assert interval == -1, "-1 is the value that means stop; anything else is a rate"


def test_a_message_gs_does_read_is_never_trimmed():
    b, _ = _b()
    b._vehicle = (1, 1)
    conn = _TrimConn()
    for t in ("ATTITUDE", "GLOBAL_POSITION_INT", "SYS_STATUS", "STATUSTEXT"):
        b._trim_stream(conn, t)
    assert conn.sent == [], f"asked to stop a stream gs uses: {conn.sent}"


def test_trimming_can_be_turned_off_for_a_fuller_log():
    """The flight log loses what is trimmed, which is the real cost of this.
    PX4's own onboard ulog keeps far more, but the choice belongs to whoever is
    flying."""
    b, _ = _b()
    b._vehicle = (1, 1)
    b.trim_streams = False
    conn = _TrimConn()
    b._trim_stream(conn, "ODOMETRY")
    assert conn.sent == []


def test_a_firmware_that_ignores_the_request_is_not_asked_forever():
    """Triggered by RECEIVING the message, so a firmware that does not honour
    it would otherwise be asked once per arrival -- 25 times a second for
    ODOMETRY, which is worse than the problem."""
    from gs.bridge import _TRIMMABLE
    import gs.bridge as mod

    b, _ = _b()
    b._vehicle = (1, 1)
    conn = _TrimConn()
    now = 0
    for _ in range(25 * 60):            # a minute of ODOMETRY at 25 Hz
        now += 40
        mod._mono_ms = lambda n=now: n
        b._trim_stream(conn, "ODOMETRY")
    assert len(conn.sent) < 12, f"asked {len(conn.sent)} times in a minute"
    assert len(conn.sent) >= 1


def test_local_position_ned_is_never_trimmed_because_this_airframe_wants_it():
    """gs reads LOCAL_POSITION_NED no more than it reads the other three, so by
    the logic of the trim it belongs in that list. It is deliberately not,
    because this aircraft's own px4-rc.mavlink carries

        mavlink stream -r 50 -s LOCAL_POSITION_NED -u $udp_gcs_port_local

    and nobody now remembers what consumes it. SET_MESSAGE_INTERVAL is scoped to
    the CHANNEL rather than to the client that asked, so switching it off would
    switch it off for every other tool on that link -- silently, decided by a
    ground station with no knowledge of what else is listening. The CPU it costs
    is measured and bounded; what the trim would break is unknown, and that
    asymmetry is the whole argument.

    If it is ever established that nothing needs it, adding one line here is the
    change -- and it is worth 18 more messages a second."""
    from gs.bridge import _TRIMMABLE

    assert "LOCAL_POSITION_NED" not in _TRIMMABLE
    b, _ = _b()
    b._vehicle = (1, 1)
    conn = _TrimConn()
    b._trim_stream(conn, "LOCAL_POSITION_NED")
    assert conn.sent == [], "asked the vehicle to stop a stream it was told to send"


def test_px4s_estimator_status_sets_ekf_ok_like_ardupilots_report_does():
    """gs listened for EKF_STATUS_REPORT, which is ArduPilot's message. PX4 sends
    ESTIMATOR_STATUS with the same `flags` bitmask. MEASURED on the live JSBSim
    rig: 61 ESTIMATOR_STATUS and zero EKF_STATUS_REPORT in two minutes -- so
    `ekfOk` was never set and the console's EKF chip read as unknown for the
    whole flight, against the firmware this aircraft actually runs."""
    from pymavlink import mavutil as mu
    m = mu.mavlink
    b, _ = _b()
    b._vehicle = (1, 1)
    good = m.ESTIMATOR_ATTITUDE | m.ESTIMATOR_VELOCITY_HORIZ | m.ESTIMATOR_POS_HORIZ_ABS

    class Est:
        def __init__(self, flags): self.flags = flags
        def get_type(self): return "ESTIMATOR_STATUS"

    b._on_mav_state(0, "ESTIMATOR_STATUS", Est(good | m.ESTIMATOR_POS_VERT_ABS))
    assert b.latest.get("ekfOk") is True
    assert "ekf" in b._src_at, "the EKF stream age was not stamped"
    b._on_mav_state(0, "ESTIMATOR_STATUS", Est(m.ESTIMATOR_ATTITUDE))
    assert b.latest.get("ekfOk") is False


def test_a_stream_that_stops_after_a_reboot_is_asked_for_again():
    """The request gate was 'have we ever seen one?', satisfied forever by a
    value from a vehicle that no longer exists. MEASURED on the live JSBSim
    rig: ACTUATOR_OUTPUT_STATUS at ~1350/min for ten minutes, PX4 restarted,
    the stream stopped, and gs sent no re-request for seventeen minutes."""
    import gs.bridge as mod
    from gs.bridge import MSG_ACTUATOR_OUTPUT_STATUS, STREAM_STALE_MS

    b, _ = _b()
    b._vehicle = (1, 1)
    conn = _TrimConn()

    class HB:
        type = 1; autopilot = 12; base_mode = 0; custom_mode = 0; system_status = 4
        def get_type(self): return "HEARTBEAT"
        def get_srcSystem(self): return 1
        def get_srcComponent(self): return 1

    now = [1_000_000]
    mod._mono_ms = lambda: now[0]
    # Actuators have been arriving: the stream is fresh, so no request.
    b._src_at["actuators"] = now[0]; b._src_at["wind"] = now[0]
    b.latest["aileron"] = 0.1; b.latest["windSpeed"] = 2.0     # the old gate's inputs
    b._on_mav_protocol(conn, now[0], "HEARTBEAT", HB())
    from gs.bridge import MSG_WIND_COV
    extras = {MSG_ACTUATOR_OUTPUT_STATUS, MSG_WIND_COV}
    assert not [p1 for (_, p1, _) in conn.sent if p1 in extras], \
        f"asked for a stream that is arriving: {conn.sent}"
    # The vehicle reboots; the stream stops; `latest` still holds the old value.
    b._on_vehicle_reboot(now[0], 100)
    now[0] += STREAM_STALE_MS + 1000
    b._on_mav_protocol(conn, now[0], "HEARTBEAT", HB())
    asked = [p1 for (_, p1, _) in conn.sent]
    assert MSG_ACTUATOR_OUTPUT_STATUS in asked, f"never re-asked after the reboot: {conn.sent}"
