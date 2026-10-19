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
