"""The hub staying up on its own (2026-11-11).

A gs that hangs, a Pixhawk that re-enumerates, a Pi on a weak supply, and a
fresh install that could not open a serial port at all. Every test here except
the host-health ones fails on the code before the fix.
"""

from __future__ import annotations

import os
import shutil
import socket
import tempfile
import threading
import time
import tomllib
from pathlib import Path

from gs import bridge as bridgemod
from gs import host as hostmod
from gs.bridge import Bridge, link_budget_bps, open_connection, stable_device_path
from gs.watchdog import Watchdog, notify, watchdog_interval_s

from test_robustness import FakeConn

GS_ROOT = Path(__file__).resolve().parents[1]


# --- a serial link at all ---------------------------------------------------

def test_pyserial_is_a_declared_dependency():
    """pymavlink imports `serial` only when a serial link opens, and does not
    depend on it. MEASURED: gs's own venv had no pyserial, so every radio and
    USB autopilot probed as "unusable (No module named 'serial')". HITL on
    thror hid it: the bridge hands gs MAVLink over UDP."""
    deps = tomllib.loads((GS_ROOT / "pyproject.toml").read_text())["project"]["dependencies"]
    assert any(d.split(">")[0].split("=")[0].strip() == "pyserial" for d in deps)
    import serial  # noqa: F401  -- installed, not just declared


def test_a_serial_peer_that_stops_reading_does_not_freeze_gs():
    """MEASURED: on a pty nobody reads, pymavlink's write blocked for good after
    15 heartbeats -- the mav thread, its GCS heartbeat to PX4, and every reopen
    with it. A write must give up and say so."""
    master, slave = os.openpty()
    try:
        conn = open_connection(f"serial:{os.ttyname(slave)}:115200")
        results: list[int] = []

        def spam():
            while not results or results[-1] != -1:
                results.append(conn.write(b"\xfd" + b"\0" * 279))

        t = threading.Thread(target=spam, daemon=True)
        t.start()
        t.join(bridgemod.SERIAL_WRITE_TIMEOUT_S * 3 + 5)
        assert not t.is_alive(), "write blocked with no timeout"
        assert results[-1] == -1
        conn.close()
    finally:
        os.close(master)
        os.close(slave)


def test_writes_that_keep_failing_reopen_the_link():
    b = Bridge(mavlink_endpoint="udpin:127.0.0.1:0")
    b.flight_log = None

    class StuckConn(FakeConn):
        def recv_match(self, blocking=True, timeout=0.5):
            self.write(b"x")            # gs transmits every turn of the loop
            return super().recv_match(blocking, timeout)

        def write(self, buf):
            return -1           # what pymavlink's serial write returns on timeout

    stuck, fresh = StuckConn(), FakeConn()
    opened = [stuck, fresh]

    def open_next():
        conn = opened.pop(0)
        b._write_failures = 0   # as the real _open_with_retry does
        b._record_sends(conn)
        return conn

    b._open_with_retry = open_next
    threading.Thread(target=b._mav_loop, daemon=True).start()
    deadline = time.monotonic() + 3
    while not stuck.closed and time.monotonic() < deadline:
        time.sleep(0.02)
    time.sleep(0.1)
    assert stuck.closed and b.link_reopens == 1 and opened == []
    assert b.status()["writeFailures"] == bridgemod.LINK_WRITE_FAILURES_BEFORE_REOPEN


# --- the device's own name --------------------------------------------------

def _fake_dev_tree():
    root = Path(tempfile.mkdtemp(prefix="gsdev"))
    (root / "by-id").mkdir()
    acm = root / "ttyACM1"
    acm.touch()
    link = root / "by-id" / "usb-Holybro_Pixhawk6X_1C0032-if00"
    link.symlink_to(acm)
    return root, acm, link


def test_a_device_is_named_by_its_usb_serial_number():
    """After a USB reset the Pixhawk came back as ttyACM1 while gs remembered
    ttyACM0, so the reopen's 'retry the working link' found nothing."""
    root, acm, link = _fake_dev_tree()
    try:
        assert stable_device_path(str(acm), str(root / "by-id")) == str(link)
        other = root / "ttyUSB0"
        other.touch()
        assert stable_device_path(str(other), str(root / "by-id")) == str(other)
        assert stable_device_path(str(acm), str(root / "missing")) == str(acm)
    finally:
        shutil.rmtree(root)


def test_a_pixhawk_named_by_id_keeps_its_usb_budget():
    """`usb-Holybro_Pixhawk6X_...` hints at no device class, so a Pixhawk
    pinned by its stable name got a 57600 radio's budget."""
    root, acm, link = _fake_dev_tree()
    try:
        assert link_budget_bps(f"serial:{link}:115200") == bridgemod.NET_BUDGET_BPS
    finally:
        shutil.rmtree(root)


def test_autodetect_lists_the_stable_name(monkeypatch):
    root, acm, link = _fake_dev_tree()
    try:
        monkeypatch.setattr(bridgemod, "SERIAL_CANDIDATES", ((str(root / "ttyACM*"), 115200),))
        monkeypatch.setattr(bridgemod, "SERIAL_BY_ID_DIR", str(root / "by-id"))
        monkeypatch.setattr(bridgemod, "device_in_use", lambda dev: False)
        assert bridgemod.candidate_endpoints()[0] == f"serial:{link}:115200"
    finally:
        shutil.rmtree(root)


# --- the watchdog -----------------------------------------------------------

class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def test_watchdog_pings_only_while_every_loop_turns(capsys):
    clock, sent = Clock(), []
    w = Watchdog(stall_s=10, clock=clock, send=lambda s: sent.append(s) or True)
    assert w.check() is False                  # nothing registered: never ping blind
    w.beat("mav")
    w.beat("ws")
    assert w.check() is True and sent == ["WATCHDOG=1"]
    clock.t += 11
    w.beat("ws")                               # the asyncio loop is fine...
    assert w.check() is False                  # ...but the mav thread is stuck
    assert w.check() is False
    out = capsys.readouterr().out
    assert out.count("mav loop silent") == 1   # said once, not every check
    assert w.stalls == 1 and len(sent) == 1
    w.beat("mav")
    assert w.check() is True and len(sent) == 2


def test_a_hung_mav_thread_stops_the_pings():
    """The failure Restart=always cannot see: the process lives, the loop does not."""
    b = Bridge(mavlink_endpoint="udpin:127.0.0.1:0")
    b.flight_log = None
    sent: list[str] = []
    b.watchdog = Watchdog(stall_s=0.3, send=lambda s: sent.append(s) or True)
    release = threading.Event()

    class HangingConn(FakeConn):
        def recv_match(self, blocking=True, timeout=0.5):
            release.wait()              # a read that never returns
            return None

    b._open_with_retry = lambda: HangingConn()
    threading.Thread(target=b._mav_loop, daemon=True).start()
    time.sleep(0.05)
    assert b.watchdog.check() is True
    time.sleep(0.5)
    assert b.watchdog.check() is False and b.watchdog.stalled() == ["mav"]
    release.set()


def test_notify_reaches_a_unix_socket_and_abstract_names():
    d = tempfile.mkdtemp(prefix="wd", dir="/tmp")     # AF_UNIX paths are short on macOS
    path = os.path.join(d, "n")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        s.bind(path)
        assert notify("WATCHDOG=1", {"NOTIFY_SOCKET": path}) is True
        assert s.recv(64) == b"WATCHDOG=1"
        assert notify("WATCHDOG=1", {}) is False
        assert notify("WATCHDOG=1", {"NOTIFY_SOCKET": os.path.join(d, "absent")}) is False
    finally:
        s.close()
        shutil.rmtree(d)


def test_watchdog_interval_is_for_this_process_only():
    me = str(os.getpid())
    assert watchdog_interval_s({"WATCHDOG_USEC": "20000000", "WATCHDOG_PID": me}) == 20.0
    assert watchdog_interval_s({"WATCHDOG_USEC": "20000000"}) == 20.0
    assert watchdog_interval_s({"WATCHDOG_USEC": "20000000", "WATCHDOG_PID": "1"}) is None
    assert watchdog_interval_s({"WATCHDOG_USEC": "junk"}) is None
    assert watchdog_interval_s({}) is None


def test_stall_window_outlasts_every_legitimate_block():
    from gs import watchdog
    assert watchdog.STALL_S > bridgemod.LINK_REOPEN_MAX_S
    assert watchdog.STALL_S > max(bridgemod.PROBE_NET_S, bridgemod.PROBE_SERIAL_S) * 2
    assert watchdog.STALL_S > bridgemod.SERIAL_WRITE_TIMEOUT_S * bridgemod.LINK_WRITE_FAILURES_BEFORE_REOPEN


# --- the hub's own health ---------------------------------------------------

def test_throttle_word_parses_both_spellings():
    assert hostmod.parse_throttled("50005") == 0x50005
    assert hostmod.parse_throttled("throttled=0x50005") == 0x50005
    assert hostmod.parse_throttled("") is None and hostmod.parse_throttled("zz") is None
    assert hostmod.throttle_conditions(0x50005) == ["under-voltage", "throttled"]
    assert hostmod.throttle_conditions(0x50005, since_boot=True) == ["under-voltage", "throttled"]
    assert hostmod.throttle_conditions(0x80000, since_boot=True) == ["soft temperature limit"]


def test_sample_reads_what_the_machine_has(tmp_path):
    (tmp_path / "throttled").write_text("10000\n")       # under-voltage since boot, fine now
    (tmp_path / "temp").write_text("61234\n")
    s = hostmod.sample(str(tmp_path), throttled_path=str(tmp_path / "throttled"),
                       rpi_volt_glob=str(tmp_path / "nohwmon*"),
                       thermal_path=str(tmp_path / "temp"))
    assert s["throttledNow"] == [] and s["throttledSinceBoot"] == ["under-voltage"]
    assert s["cpuTempC"] == 61.2 and s["logDiskFreeBytes"] > 0
    hw = tmp_path / "hwmon3"
    hw.mkdir()
    (hw / "name").write_text("rpi_volt\n")
    (hw / "in0_lcrit_alarm").write_text("1\n")
    s = hostmod.sample(None, throttled_path=str(tmp_path / "absent"),
                       rpi_volt_glob=str(tmp_path / "hwmon*"), thermal_path=str(tmp_path / "absent"))
    assert s == {"throttledNow": ["under-voltage"], "throttledSinceBoot": None,
                 "cpuTempC": None, "logDiskFreeBytes": None}


def test_host_alerts_say_each_onset_once():
    w = hostmod.HostWatch()
    ok = {"throttledNow": [], "logDiskFreeBytes": 10 * 2**30}
    assert w.alerts(ok) == []
    bad = {"throttledNow": ["under-voltage"], "logDiskFreeBytes": 10 * 2**20}
    first = w.alerts(bad)
    assert len(first) == 2 and "power supply" in first[0] and "disk nearly full" in first[1]
    assert w.alerts(bad) == []
    assert w.alerts(ok) == []
    assert len(w.alerts(bad)) == 2              # a new onset is said again


def test_host_onset_reaches_the_consoles(monkeypatch):
    b = Bridge(mavlink_endpoint="udpin:127.0.0.1:0")
    sent: list[dict] = []
    monkeypatch.setattr(b, "_broadcast", sent.append)
    monkeypatch.setattr(hostmod, "sample", lambda log_dir: {
        "throttledNow": ["under-voltage"], "throttledSinceBoot": ["under-voltage"],
        "cpuTempC": 50.0, "logDiskFreeBytes": 2**40})
    b._service_host()
    b._service_host()                           # inside HOST_SAMPLE_MS: no resample
    assert [m["type"] for m in sent] == ["statustext"]
    assert "under-voltage" in sent[0]["text"]
    assert b.status()["host"]["throttledNow"] == ["under-voltage"]


# --- logs that last a multi-day run -----------------------------------------

def _fake_clock_log(tmp_path, monkeypatch, **kw):
    from types import SimpleNamespace
    from gs import flightlog
    log = flightlog.FlightLog(tmp_path, **kw)
    clock = {"t": 1000.0}
    monkeypatch.setattr(flightlog, "time",
                        SimpleNamespace(monotonic=lambda: clock["t"], time=time.time))
    return log, clock


def test_hitl_actuator_frames_are_thinned_to_10_hz(tmp_path, monkeypatch):
    """MEASURED on thror: HIL_ACTUATOR_CONTROLS at 190 Hz, over half of HITL's
    log bytes, which is what made 512 MiB last 4.6 h."""
    log, clock = _fake_clock_log(tmp_path, monkeypatch)
    for _ in range(190):                # one second of HITL
        log.write(b"x" * 90, 93)
        log.write(b"y" * 40, 0)         # a heartbeat-sized frame: never thinned
        clock["t"] += 1 / 190
    kept = log._q.qsize()
    assert 190 + 9 <= kept <= 190 + 11
    assert log.decimated == 190 - (kept - 190)


def test_full_rate_keeps_every_frame(tmp_path, monkeypatch):
    log, clock = _fake_clock_log(tmp_path, monkeypatch, rate_caps_hz={})
    for _ in range(190):
        log.write(b"x" * 90, 93)
        clock["t"] += 1 / 190
    assert log._q.qsize() == 190 and log.decimated == 0


def test_log_budget_follows_the_disk(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from gs import flightlog
    GB = 1024 ** 3
    log = flightlog.FlightLog(tmp_path)
    disk = {"total": 32 * GB, "free": 20 * GB}
    monkeypatch.setattr(flightlog.shutil, "disk_usage",
                        lambda p: SimpleNamespace(total=disk["total"], free=disk["free"], used=0))
    # A roomy card: half the disk, far past the old 512 MiB.
    assert log.budget(1 * GB) == 16 * GB
    # A nearly full card: never past leaving the reserve free.
    disk["free"] = GB // 2
    assert log.budget(1 * GB) == GB + GB // 2 - flightlog.DISK_RESERVE_BYTES
    disk["free"] = 0
    assert log.budget(0) == 0
    # A pinned cap is a pinned cap.
    assert flightlog.FlightLog(tmp_path, max_total_bytes=123).budget(10 * GB) == 123


def test_prune_uses_the_disk_budget(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from gs import flightlog
    for i in range(4):
        p = tmp_path / f"commandant-2026010{i}-000000.tlog"
        p.write_bytes(b"\0" * 1000)
        os.utime(p, (i, i))
    log = flightlog.FlightLog(tmp_path)
    # Logs hold 4000 B; the reserve leaves room for 2500 of them.
    monkeypatch.setattr(flightlog, "DISK_RESERVE_BYTES", 500)
    monkeypatch.setattr(flightlog.shutil, "disk_usage",
                        lambda p: SimpleNamespace(total=10**9, free=-1000, used=0))
    log._prune()
    left = sorted(p.name for p in tmp_path.glob("*.tlog"))
    assert left == ["commandant-20260102-000000.tlog", "commandant-20260103-000000.tlog"]
    assert log.status()["budgetBytes"] == 2500
