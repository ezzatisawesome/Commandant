"""Read one file from the vehicle over MAVLink FTP.

Why: PX4's refusal reasons arrive as EVENTs, readable only against the
firmware's own metadata (events.py). gs looked for that file on disk, so on
thror -- the Pi that flies the 6X in HITL -- it found none and every arming
refusal reached the operator as nothing, and on a laptop with two PX4 builds it
took the SITL file for the board. The board carries its own copy
(`mftp://etc/extras/all_events.json.xz`, advertised in component_general.json),
which is by construction the one that matches the firmware that is flying.

A state machine with no I/O of its own: `request()` says what to send,
`reply()` folds in what came back. The bridge drives it from the mav thread
like every other protocol, which keeps every send on the one connection.

One request is outstanding at a time and a lost reply is resent with the SAME
sequence number, which PX4 answers by replaying its last reply. Plain ReadFile,
not burst: on a radio a burst is a flood, and 16 kB is ~70 round trips.
"""

from __future__ import annotations

import struct

# PayloadHeader in PX4's mavlink_ftp.h: seq u16, session u8, opcode u8, size u8,
# req_opcode u8, burst_complete u8, padding u8, offset u32; then data.
_HDR = struct.Struct("<HBBBBBxI")
PAYLOAD_LEN = 251
DATA_MAX = PAYLOAD_LEN - _HDR.size          # 239

OP_TERMINATE = 1
OP_OPEN_RO = 4
OP_READ = 5
RSP_ACK = 128
RSP_NAK = 129
ERR_EOF = 6
ERR_NO_SESSIONS = 5

_OP_NAMES = {OP_OPEN_RO: "open", OP_READ: "read", OP_TERMINATE: "close"}

REPLY_TIMEOUT_MS = 1000
MAX_TRIES = 5
# A file this large is not event metadata; refuse it rather than pull it over a radio.
MAX_FILE_BYTES = 512 * 1024


def payload(seq: int, opcode: int, *, session: int = 0, size: int = 0,
            offset: int = 0, data: bytes = b"") -> bytes:
    body = _HDR.pack(seq & 0xFFFF, session, opcode, size, 0, 0, offset) + data
    return body.ljust(PAYLOAD_LEN, b"\0")


def parse(raw: bytes | list[int]) -> tuple[int, int, int, int, int, int, bytes]:
    """(seq, session, opcode, size, req_opcode, offset, data) of one payload."""
    raw = bytes(raw)
    seq, session, opcode, size, req_opcode, _burst, offset = _HDR.unpack_from(raw)
    return seq, session, opcode, size, req_opcode, offset, raw[_HDR.size:_HDR.size + size]


class FtpRead:
    """Read `path` in DATA_MAX chunks. `state` ends at "done" or "failed"."""

    def __init__(self, path: str) -> None:
        self.path = path.encode("ascii")
        self.state = "open"
        self.data = bytearray()
        self.size: int | None = None
        self.session = 0
        self.error: str | None = None
        self._seq = 0
        self._sent: bytes | None = None
        self._sent_at = 0
        self._tries = 0
        self._close_then_fail = False

    @property
    def finished(self) -> bool:
        return self.state in ("done", "failed")

    def request(self, now_ms: int) -> bytes | None:
        """The payload to transmit now, if any: a new request, or a resend."""
        if self.finished:
            return None
        if self._sent is not None:
            if now_ms - self._sent_at < REPLY_TIMEOUT_MS:
                return None
            if self._tries >= MAX_TRIES:
                if self.state == "terminate":
                    self._closed()              # the close is a courtesy; never wait on it
                else:
                    self._fail(f"no reply to {_OP_NAMES[self._sent[3]]} after {MAX_TRIES} tries")
                return None
            self._tries += 1
            self._sent_at = now_ms
            return self._sent                   # same seq: PX4 replays its reply
        self._seq = (self._seq + 1) & 0xFFFF
        if self.state == "open":
            out = payload(self._seq, OP_OPEN_RO, size=len(self.path), data=self.path)
        elif self.state == "read":
            out = payload(self._seq, OP_READ, session=self.session,
                          size=DATA_MAX, offset=len(self.data))
        else:
            out = payload(self._seq, OP_TERMINATE, session=self.session)
        self._sent, self._sent_at, self._tries = out, now_ms, 1
        return out

    def reply(self, raw: bytes | list[int]) -> None:
        """Fold in one FILE_TRANSFER_PROTOCOL payload from the vehicle."""
        if self.finished or self._sent is None:
            return
        seq, session, opcode, size, req_opcode, offset, data = parse(raw)
        if seq != ((self._seq + 1) & 0xFFFF):
            return      # a stale reply, or another client's transfer
        sent_op = self._sent[3]
        if req_opcode != sent_op or opcode not in (RSP_ACK, RSP_NAK):
            return
        self._sent = None
        if opcode == RSP_NAK:
            err = data[0] if data else -1
            if sent_op == OP_READ and err == ERR_EOF:
                self._finish_read()
            elif sent_op == OP_TERMINATE:
                self._closed()
            elif err == ERR_NO_SESSIONS:
                # Someone else's transfer holds PX4's one session. Backing off
                # is right; resetting sessions would kill theirs.
                self._fail("the vehicle's FTP session is in use by another client")
            else:
                self._fail(f"{_OP_NAMES[sent_op]} refused (error {err})")
            return
        if sent_op == OP_OPEN_RO:
            if len(data) < 4:
                self._fail("open reply carried no file size")
                return
            self.size = struct.unpack_from("<I", data)[0]
            if self.size > MAX_FILE_BYTES:
                self._fail(f"file is {self.size} B, past the {MAX_FILE_BYTES} B limit")
                return
            self.session = session
            self.state = "read" if self.size else "terminate"
        elif sent_op == OP_READ:
            if offset != len(self.data):
                return      # not the chunk we asked for; the resend will get it
            self.data += data
            if size == 0 or (self.size is not None and len(self.data) >= self.size):
                self._finish_read()
        else:
            self._closed()

    def _closed(self) -> None:
        self.state = "failed" if self._close_then_fail else "done"

    def _finish_read(self) -> None:
        if self.size is not None and len(self.data) != self.size:
            self._fail(f"read {len(self.data)} of {self.size} B")
            return
        self.state = "terminate"

    def _fail(self, why: str) -> None:
        self.error = why
        if self.size is not None and self.state == "read":
            # The file is open: close it first, or PX4's one session stays
            # held and the next client is refused.
            self._close_then_fail = True
            self._sent = None
            self.state = "terminate"
        else:
            self.state = "failed"
