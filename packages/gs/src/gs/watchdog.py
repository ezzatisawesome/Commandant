"""Tell systemd gs is alive -- and only while it actually is.

Why: `Restart=always` restarts a gs that CRASHES. A gs that HANGS -- the mav
thread stuck in a write to a serial peer that stopped reading, the asyncio loop
wedged -- keeps its pid, so systemd sees nothing wrong while PX4 stops hearing a
ground station and every console shows the last frame it got. MEASURED on a pty
nobody reads: pymavlink's serial write (no write_timeout) blocked for good after
15 heartbeats.

So each loop that must keep turning calls `beat(name)`, and a separate thread
pings systemd's watchdog (WATCHDOG=1) only while every registered loop has
beaten within STALL_S. A stall stops the pings, and systemd's WatchdogSec kills
and restarts gs. The stall is logged once, with every thread's stack, so the
restart leaves the evidence of what hung behind in the journal.

Without systemd (no NOTIFY_SOCKET), the same stall detection still runs and
logs; nothing is killed, because nothing would bring gs back.
"""

from __future__ import annotations

import faulthandler
import os
import socket
import sys
import threading
import time
from collections.abc import Callable, Mapping

# Longer than any step a beating loop may legitimately block in: the mav
# thread's longest is the reopen backoff (LINK_REOPEN_MAX_S, 10 s); one probe
# of an autodetect candidate is at most 3 s and beats in between.
STALL_S = 15.0
# How often the stall check runs when systemd has not set an interval.
CHECK_S = 5.0


def notify(state: str, env: Mapping[str, str] = os.environ) -> bool:
    """Send one sd_notify datagram. False when not under systemd, or it failed."""
    addr = env.get("NOTIFY_SOCKET")
    if not addr:
        return False
    if addr.startswith("@"):
        addr = "\0" + addr[1:]          # Linux abstract namespace
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            s.connect(addr)
            s.sendall(state.encode())
        return True
    except OSError:
        return False


def watchdog_interval_s(env: Mapping[str, str] = os.environ) -> float | None:
    """systemd's WatchdogSec for THIS process, in seconds, or None."""
    usec = env.get("WATCHDOG_USEC")
    pid = env.get("WATCHDOG_PID")
    if not usec or (pid and pid != str(os.getpid())):
        return None
    try:
        s = int(usec) / 1e6
    except ValueError:
        return None
    return s if s > 0 else None


class Watchdog:
    """Liveness of named loops, and the decision whether to ping systemd."""

    def __init__(self, stall_s: float = STALL_S,
                 clock: Callable[[], float] = time.monotonic,
                 send: Callable[[str], bool] = notify) -> None:
        self.stall_s = stall_s
        self._clock = clock
        self._send = send
        self._beats: dict[str, float] = {}
        self._reported: frozenset[str] = frozenset()
        self.pings = 0
        self.stalls = 0

    def beat(self, name: str) -> None:
        # One dict store: atomic under the GIL, so no lock on the hot path.
        self._beats[name] = self._clock()

    def ages_s(self) -> dict[str, float]:
        now = self._clock()
        return {n: now - at for n, at in dict(self._beats).items()}

    def stalled(self) -> list[str]:
        return sorted(n for n, age in self.ages_s().items() if age > self.stall_s)

    def check(self) -> bool:
        """One watchdog decision: ping if every loop is live. True if pinged."""
        stalled = self.stalled()
        if not stalled:
            self._reported = frozenset()
            if self._beats and self._send("WATCHDOG=1"):
                self.pings += 1
                return True
            return False
        if frozenset(stalled) != self._reported:
            self._reported = frozenset(stalled)
            self.stalls += 1
            ages = self.ages_s()
            print("[gs] watchdog: " + ", ".join(f"{n} loop silent {ages[n]:.0f}s"
                                                for n in stalled)
                  + "; not pinging systemd, which restarts gs if it stays this way. "
                  "Every thread's stack follows.", flush=True)
            try:
                faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
            except Exception:
                pass            # stderr may not have a fileno; the line above stands
        return False

    def start(self, env: Mapping[str, str] = os.environ) -> threading.Thread:
        """The pinging thread. Pings at a third of systemd's interval."""
        interval = watchdog_interval_s(env)
        period = interval / 3 if interval else CHECK_S
        if interval:
            print(f"[gs] systemd watchdog: {interval:.0f}s; a loop silent "
                  f"{self.stall_s:.0f}s stops the pings")

        def run() -> None:
            while True:
                time.sleep(period)
                try:
                    self.check()
                except Exception as exc:     # never let the watchdog itself die quietly
                    print(f"[gs] watchdog check raised {exc!r}", flush=True)

        t = threading.Thread(target=run, name="gs-watchdog", daemon=True)
        t.start()
        return t
