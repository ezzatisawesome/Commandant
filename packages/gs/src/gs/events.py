"""Turn PX4's EVENT messages into sentences.

PX4 (since v1.13) reports why it refused something through the events
protocol: an EVENT message (id 410) carrying a numeric event id and packed
arguments, meaningful only against metadata the firmware build generates
(`build/<target>/events/all_events.json`). The legacy STATUSTEXT is sent too
-- usually. MEASURED on the live JSBSim rig: the navigator rejected a mission
("Landing waypoint/pattern required"), the STATUSTEXT was dropped inside PX4
before it reached the link, and the EVENT arrived fine, as the very first event
of the run. gs could not read it, so the operator saw "Switching to Mission is
currently not available" and nothing else. QGroundControl, which decodes
events, would have shown the reason.

This module is the difference. The parsing itself is PX4's own libevents
parser, vendored unmodified; what is here is the wire framing, the metadata
discovery, and the mapping onto the statustext severities the console already
displays.

The metadata must match the firmware. It is per build, so the one for the
flashed `px4_fmu-v6x` image lives beside the SITL one in the same tree and
either may be pointed at with --events-meta. An id the metadata does not know
is reported as such rather than guessed at.
"""

from __future__ import annotations

import json
import lzma
import os
import struct
from pathlib import Path
from typing import Any

from .vendor.libevents_parse import Parser, ParserException

# EVENT (410) payload, wire order (MAVLink sorts fields by size): id u32,
# event_time_boot_ms u32, sequence u16, destination_component u8,
# destination_system u8, log_levels u8, arguments u8[40]. 53 bytes; MAVLink 2
# truncates trailing zeros, so the payload on the wire may be shorter.
EVENT_MSG_ID = 410
_HEADER = struct.Struct("<IIHBBB")
_PAYLOAD_LEN = _HEADER.size + 40
# MAVLink 2 frame: magic, len, incompat, compat, seq, sysid, compid, msgid[3].
_FRAME_HEADER_LEN = 10

# The low nibble of log_levels is the EXTERNAL level, on the syslog scale that
# STATUSTEXT.severity already uses: 0 emergency .. 7 debug. 8 is "protocol"
# (machine-to-machine, never for a person) and 9 is disabled.
LEVEL_PROTOCOL = 8
LEVEL_DISABLED = 9

# Where a build leaves its metadata, relative to a PX4 checkout. The sibling
# checkout this aircraft uses is tried last, so an explicit path always wins.
_CANDIDATES = (
    "build/px4_sitl_default/events/all_events.json",
    "build/px4_fmu-v6x_default/events/all_events.json",
)


def find_metadata(explicit: str | None = None) -> Path | None:
    """The metadata file to use: the explicit path, else $GS_EVENTS_META, else
    the first candidate under $PX4_DIR or a `mojave-px4` sibling checkout."""
    for p in (explicit, os.environ.get("GS_EVENTS_META")):
        if p:
            return Path(p) if Path(p).exists() else None
    roots = [os.environ.get("PX4_DIR")]
    here = Path(__file__).resolve()
    roots += [str(here.parents[i] / "mojave-px4") for i in (4, 5) if i < len(here.parents)]
    for r in roots:
        if not r:
            continue
        for c in _CANDIDATES:
            p = Path(r) / c
            if p.exists():
                return p
    return None


class EventDecoder:
    def __init__(self, metadata: str | os.PathLike[str]) -> None:
        self.path = Path(metadata)
        raw = self.path.read_bytes()
        if self.path.suffix == ".xz":
            raw = lzma.decompress(raw)
        self._parser = Parser()
        self._parser.load_definitions(json.loads(raw))
        # Operators are not developers: drop <profile name="dev"> content.
        self._parser.set_profile("normal")
        self.decoded = 0
        self.unknown = 0

    @classmethod
    def from_frame(cls, frame: bytes) -> tuple[int, int, bytes] | None:
        """(event_id, external_level, arguments) from a raw MAVLink 2 frame
        carrying message 410, or None if it is not one. Static so it can be
        used without metadata, e.g. to count what is being missed."""
        if len(frame) < _FRAME_HEADER_LEN or frame[0] != 0xFD:
            return None
        msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16)
        if msgid != EVENT_MSG_ID:
            return None
        payload = frame[_FRAME_HEADER_LEN:_FRAME_HEADER_LEN + frame[1]]
        payload = payload + bytes(_PAYLOAD_LEN - len(payload))   # un-truncate
        eid, _t, _seq, _dc, _ds, levels = _HEADER.unpack_from(payload, 0)
        return eid, levels & 0x0F, payload[_HEADER.size:]

    def decode(self, frame: bytes) -> dict[str, Any] | None:
        """A statustext-shaped dict for a person, or None if the frame is not an
        EVENT, is machine-only, or (with `unknown` counted) has no metadata."""
        parsed = self.from_frame(frame)
        if parsed is None:
            return None
        eid, level, args = parsed
        if level >= LEVEL_PROTOCOL:
            return None
        try:
            ev = self._parser.parse(eid, args)
        except (ParserException, KeyError, struct.error, ValueError):
            ev = None
        if ev is None:                      # the parser's own answer for an unknown id
            self.unknown += 1
            return None
        self.decoded += 1
        return {"severity": level, "text": ev.message(), "event": ev.name(),
                "group": ev.group()}
