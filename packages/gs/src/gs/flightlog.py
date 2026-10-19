"""A replayable record of everything that crossed the link.

gs decoded every frame and then dropped it. That makes a field anomaly
unreproducible: you cannot replay it, diff it against a good flight, or show
anyone what the radio actually carried -- only describe it from memory, which is
exactly what a debrief should not rest on.

FORMAT. The standard telemetry log: each record is an 8-byte big-endian
microsecond timestamp followed by the raw MAVLink frame, concatenated with no
framing of its own (the frame's own length field is the framing). pymavlink,
MAVExplorer and QGroundControl all read this directly, so the log is useful
without anything from this repo -- which is the point. A custom format would
have been easier to write and useless on a laptop that does not have Commandant
checked out.

CLOCKS. The hub is a Raspberry Pi with no RTC: its wall clock is wrong until
something tells it otherwise, and then it STEPS, possibly mid-flight. Timestamps
are therefore anchored once at startup and advanced by monotonic deltas, so a
step cannot make the log go backwards or open a hole in it. If the clock looked
unset when the log opened, the filename says so rather than implying a date
nobody should trust.

BLOCKING. Writes happen on their own thread behind a bounded queue. An SD card
flush can block for tens of milliseconds, and the MAVLink receive loop is not a
place to discover that -- it is the thread that notices the aircraft. If the
queue fills, records are DROPPED and counted: losing part of the log is a bad
day, and blocking the link to avoid it would be a worse one.
"""

from __future__ import annotations

import os
import queue
import struct
import threading
import time
from pathlib import Path

# A record is 8 bytes of timestamp plus the frame; MAVLink 2 frames run to 280
# bytes, so files are sized in megabytes rather than records.
MAX_FILE_BYTES = 32 * 1024 * 1024
# Total across all files. A 57600 radio carries ~12 MB/hour, so this is days of
# flying; a USB link is far faster, which is exactly why the cap exists. The hub
# boots from an SD card, and a full card is a daemon that cannot write anything,
# including the logs that would explain why.
MAX_TOTAL_BYTES = 512 * 1024 * 1024
# Bounded so a stalled disk cannot grow it without limit. At 100 Hz of traffic
# this is ~80 seconds of slack, far more than any plausible flush.
QUEUE_MAX = 8192
# Two different timers, because they buy two different things and conflating
# them is how the first version of this file justified the wrong one.
#
# flush() moves our userspace buffer into the OS page cache. It does NOT reach
# the card, so it protects against gs DYING -- kill -9, OOM, a systemd restart,
# an unhandled crash -- and not against power loss. At a 57600 radio's ~3.5 kB/s
# the 64 kB buffer holds ~18 seconds of flight, which is how much a crash would
# otherwise take with it. It also makes the file readable while gs is running.
FLUSH_INTERVAL_S = 1.0
# fsync() is the one that reaches the device, and it is the only thing that
# survives the battery coming off -- which is the flight you most want the log
# from. It costs real write amplification on an SD card, so it runs on a much
# longer timer and bounds loss to that interval rather than eliminating it.
# A filesystem's own commit (ext4 defaults to 5 s) already bounds this; doing it
# here makes the bound ours rather than a mount option nobody checked. Set to 0
# to leave durability entirely to the filesystem.
#
# NOT MEASURED ON A REAL PI SD CARD: the cost here is reasoned, not timed. It
# runs on the writer thread behind the queue, so a slow fsync shows up as queue
# depth and then as `dropped`, never as a stalled link.
FSYNC_INTERVAL_S = 10.0
# Below this the wall clock has obviously never been set (2020-01-01).
CLOCK_SANE_EPOCH = 1_577_836_800


class FlightLog:
    """Append raw MAVLink frames to rotating .tlog files, off the link thread."""

    def __init__(self, directory: str | os.PathLike[str],
                 max_file_bytes: int = MAX_FILE_BYTES,
                 max_total_bytes: int = MAX_TOTAL_BYTES,
                 queue_max: int = QUEUE_MAX,
                 flush_interval_s: float = FLUSH_INTERVAL_S,
                 fsync_interval_s: float = FSYNC_INTERVAL_S) -> None:
        self.dir = Path(directory)
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes
        self.flush_interval_s = flush_interval_s
        self.fsync_interval_s = fsync_interval_s
        self.fsyncs = 0
        self._q: queue.Queue[tuple[int, bytes] | None] = queue.Queue(maxsize=queue_max)
        self._thread: threading.Thread | None = None
        self._fh = None
        self.path: Path | None = None
        # Counters, read by status(). Dropped is the one that matters: a log
        # with a silent hole in it is worse than one that admits the hole.
        self.written = 0
        self.dropped = 0
        self.bytes_written = 0
        self.rotations = 0
        self.pruned = 0
        self.error: str | None = None
        self.enabled = True
        # One wall-clock anchor, advanced by monotonic deltas. See CLOCKS.
        self._wall0_us = int(time.time() * 1_000_000)
        self._mono0 = time.monotonic()
        self.clock_was_set = time.time() >= CLOCK_SANE_EPOCH

    # --- the link thread's half -------------------------------------------
    def stamp_us(self) -> int:
        return self._wall0_us + int((time.monotonic() - self._mono0) * 1_000_000)

    def write(self, frame: bytes | bytearray | None) -> None:
        """Queue one raw frame. Never blocks, never raises: this is called from
        the MAVLink receive loop and from every send, and a logger that can
        interrupt either is not worth having."""
        if not self.enabled or not frame:
            return
        try:
            self._q.put_nowait((self.stamp_us(), bytes(frame)))
        except queue.Full:
            self.dropped += 1

    # --- lifecycle ---------------------------------------------------------
    def start(self) -> "FlightLog":
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._open_file()
        except OSError as exc:
            self._fail(f"cannot open flight log in {self.dir}: {exc}")
            return self
        self._thread = threading.Thread(target=self._run, name="flightlog", daemon=True)
        self._thread.start()
        print(f"[gs] flight log: {self.path}")
        return self

    def stop(self, timeout: float = 5.0) -> None:
        """Flush and close. Called on shutdown; the tail of a log is usually the
        interesting part, so this waits rather than abandoning the queue."""
        if self._thread is None:
            self._close_file()
            return
        self.enabled = False
        try:
            self._q.put(None, timeout=1.0)
        except queue.Full:
            pass
        self._thread.join(timeout=timeout)
        self._close_file()

    # --- the writer thread's half -----------------------------------------
    def _sync(self) -> None:
        """Push the page cache to the device. Flush first: fsync does not know
        about our userspace buffer."""
        if self._fh is None or not self.fsync_interval_s:
            return
        if not self._safely(self._fh.flush):
            return
        try:
            fd = self._fh.fileno()
        except Exception:
            return      # not a real file (a closed handle, or a test double)
        if self._safely(os.fsync, fd):
            self.fsyncs += 1

    def _run(self) -> None:
        last_flush = last_sync = time.monotonic()
        while True:
            try:
                item = self._q.get(timeout=self.flush_interval_s)
            except queue.Empty:
                item = None
                if self._fh is not None:
                    self._safely(self._fh.flush)
                    last_flush = time.monotonic()
                    if time.monotonic() - last_sync >= self.fsync_interval_s:
                        self._sync()
                        last_sync = time.monotonic()
                continue
            if item is None:
                break
            stamp, frame = item
            if self._fh is None:
                continue
            rec = struct.pack(">Q", stamp) + frame
            if not self._safely(self._fh.write, rec):
                continue
            self.written += 1
            self.bytes_written += len(rec)
            if self._fh.tell() >= self.max_file_bytes:
                self._rotate()
            if time.monotonic() - last_flush >= self.flush_interval_s:
                self._safely(self._fh.flush)
                last_flush = time.monotonic()
            if time.monotonic() - last_sync >= self.fsync_interval_s:
                self._sync()
                last_sync = time.monotonic()
        if self._fh is not None:
            self._sync()

    def _open_file(self) -> None:
        if self.clock_was_set:
            name = time.strftime("commandant-%Y%m%d-%H%M%S")
        else:
            # Naming this with a 1970 date would invite someone to trust it.
            name = f"commandant-nortc-{os.getpid()}-{self.rotations}"
        # Second resolution is not enough on a fast link: two rotations inside
        # one second produced the SAME name, reopened the same file in append
        # mode, and left one file growing past the cap that could never be
        # pruned (the live file is never deleted) -- the full-card failure the
        # cap exists to prevent, reached by way of the code meant to prevent it.
        candidate = self.dir / f"{name}.tlog"
        n = 1
        while candidate.exists():
            n += 1
            candidate = self.dir / f"{name}-{n}.tlog"
        self.path = candidate
        self._fh = open(self.path, "ab", buffering=1024 * 64)
        self._prune()

    def _rotate(self) -> None:
        self._close_file()
        self.rotations += 1
        try:
            self._open_file()
        except OSError as exc:
            self._fail(f"cannot rotate flight log: {exc}")

    def _close_file(self) -> None:
        if self._fh is not None:
            self._sync()
            self._safely(self._fh.close)
            self._fh = None

    def _prune(self) -> None:
        """Keep the directory under its cap, oldest first. The current file is
        never pruned: deleting what is being written to would lose the flight in
        progress to save the one before it."""
        try:
            logs = sorted(self.dir.glob("commandant-*.tlog"),
                          key=lambda p: p.stat().st_mtime)
        except OSError:
            return
        total = 0
        for p in logs:
            try:
                total += p.stat().st_size
            except OSError:
                pass
        for p in logs:
            if total <= self.max_total_bytes:
                break
            if self.path is not None and p == self.path:
                continue
            try:
                size = p.stat().st_size
                p.unlink()
                total -= size
                self.pruned += 1
            except OSError:
                pass

    def _safely(self, fn, *args) -> bool:
        """Any disk error disables logging and is reported once. A full SD card
        must not take the aircraft's telemetry down with it."""
        try:
            fn(*args)
            return True
        except OSError as exc:
            self._fail(f"flight log write failed: {exc}")
            return False

    def _fail(self, msg: str) -> None:
        if self.error is None:
            self.error = msg
            print(f"[gs] {msg}; continuing without a flight log")
        self.enabled = False

    def status(self) -> dict:
        return {
            "path": str(self.path) if self.path else None,
            "enabled": self.enabled,
            "records": self.written,
            "dropped": self.dropped,
            "bytes": self.bytes_written,
            "rotations": self.rotations,
            "fsyncs": self.fsyncs,
            "pruned": self.pruned,
            "clockWasSet": self.clock_was_set,
            "error": self.error,
        }
