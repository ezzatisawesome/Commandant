"""PX4's EVENT messages, decoded against the firmware's metadata.

The two frames below are REAL: recorded on the live JSBSim rig the moment PX4
refused AUTO.MISSION. The first is the reason, which PX4 dropped as a
STATUSTEXT and gs therefore never showed; the second is the "not possible"
headline that did arrive as text. Decoding is PX4's own libevents parser,
vendored; the fixture is a three-event slice of the real all_events.json.
"""

from __future__ import annotations

import lzma
from pathlib import Path

from gs.events import EventDecoder, find_metadata

FIX = Path(__file__).parent / "fixtures" / "px4_events_min.json"
FRAME_REFUSAL = bytes.fromhex("fd0d00007c01019a010091168101746b05001a000000638af1")
FRAME_NOT_POSSIBLE = bytes.fromhex("fd120000c601019a01009743a0012c6c05001b000000620000040403b951")


def test_the_dropped_rejection_reason_is_readable_from_the_event():
    d = EventDecoder(FIX).decode(FRAME_REFUSAL)
    assert d is not None
    assert d["text"] == "Mission rejected: Landing waypoint/pattern required"
    assert d["event"] == "navigator_mis_land_missing"
    assert d["severity"] == 3            # Error, on STATUSTEXT's own scale


def test_an_enum_argument_is_rendered_as_its_name():
    """'{2}' is a px4::navigation_mode_t; the raw byte is 3. The operator
    should read the mode, not the number."""
    d = EventDecoder(FIX).decode(FRAME_NOT_POSSIBLE)
    assert d is not None
    assert "Mission" in d["text"], d["text"]
    assert d["text"].startswith("Switching to mode")
    assert d["severity"] == 2


def test_a_frame_that_is_not_an_event_is_ignored():
    hb = bytes.fromhex("fd090000000101000000" + "00" * 9 + "0000")
    assert EventDecoder(FIX).decode(hb) is None
    assert EventDecoder.from_frame(b"\xfe\x00") is None


def test_a_machine_only_event_is_not_shown_to_a_person():
    # Same frame as the refusal with log_levels' low nibble set to 8 (protocol).
    f = bytearray(FRAME_REFUSAL)
    f[10 + 12] = (f[10 + 12] & 0xF0) | 8
    assert EventDecoder(FIX).decode(bytes(f)) is None


def test_an_id_the_metadata_does_not_know_is_counted_not_guessed():
    f = bytearray(FRAME_REFUSAL)
    f[10:14] = (0xDEAD | (1 << 24)).to_bytes(4, "little")
    dec = EventDecoder(FIX)
    assert dec.decode(bytes(f)) is None
    assert dec.unknown == 1 and dec.decoded == 0


def test_compressed_metadata_loads_too(tmp_path):
    """The firmware ships it as all_events.json.xz under etc/extras."""
    xz = tmp_path / "all_events.json.xz"
    xz.write_bytes(lzma.compress(FIX.read_bytes()))
    assert EventDecoder(xz).decode(FRAME_REFUSAL)["event"] == "navigator_mis_land_missing"


def test_metadata_discovery_prefers_an_explicit_path(monkeypatch, tmp_path):
    monkeypatch.delenv("GS_EVENTS_META", raising=False)
    assert find_metadata(str(FIX)) == FIX
    assert find_metadata(str(tmp_path / "missing.json")) is None
    monkeypatch.setenv("GS_EVENTS_META", str(FIX))
    assert find_metadata(None) == FIX


def test_a_corrupted_length_field_does_not_crash_the_decoder():
    """`bytes(_PAYLOAD_LEN - len(payload))` raised "ValueError: negative count"
    for any length field above the 53-byte cap, and from_frame was called from
    outside decode()'s try, so it reached the bridge's receive loop unguarded.
    Reachable rather than theoretical: msgid 410 is absent from this pymavlink's
    mavlink_map, so EVENTs arrive as unknown messages and an unknown msgid gets
    no CRC validation -- one corrupted radio byte, or one damaged record in a
    recovered log, is enough."""
    dec = EventDecoder(FIX)
    for length in (54, 60, 0xFF):
        f = bytearray(FRAME_REFUSAL)
        f[1] = length
        assert EventDecoder.from_frame(bytes(f)) is None, length
        assert dec.decode(bytes(f)) is None, length
    # A truncated frame (the payload shorter than its own length field says)
    # must be refused the same way, not sliced into nonsense.
    assert dec.decode(FRAME_REFUSAL[:12]) is None
    # And the good frame still decodes after all that.
    assert dec.decode(FRAME_REFUSAL)["event"] == "navigator_mis_land_missing"
