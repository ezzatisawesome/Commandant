"""Health of the machine gs runs on: the hub's own failures.

Why: the field hub is a Raspberry Pi on whatever supply the flight line has.
An undersized supply browns the Pi out -- the firmware caps the CPU clock, USB
devices (the radio, the autopilot) drop and re-enumerate -- and from the
console that looks exactly like a bad radio link. A full SD card stops the
flight log. Neither was visible anywhere but on the Pi itself.

Read from sysfs, never by running a program: a sample costs a few file reads,
so the status reply can carry it every time. Every source is optional; a
laptop simply reports what it has.
"""

from __future__ import annotations

import glob
import os
import shutil
from typing import Any

# The Pi firmware's throttle word (what `vcgencmd get_throttled` prints).
THROTTLED_PATH = "/sys/devices/platform/soc/soc:firmware/get_throttled"
# The Pi's undervoltage alarm as a hwmon device, on kernels without the above.
RPI_VOLT_GLOB = "/sys/class/hwmon/hwmon*"
THERMAL_PATH = "/sys/class/thermal/thermal_zone0/temp"

# Bits 0-3 are the condition NOW; bits 16-19 the same conditions since boot.
THROTTLE_BITS = {
    0: "under-voltage",
    1: "CPU frequency capped",
    2: "throttled",
    3: "soft temperature limit",
}
SINCE_BOOT_SHIFT = 16

# Below this the flight log is close to stopping; said once per crossing.
LOW_DISK_BYTES = 256 * 1024 * 1024


def _read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def parse_throttled(text: str | None) -> int | None:
    """The throttle word from sysfs ("50005") or vcgencmd ("throttled=0x50005")."""
    if not text:
        return None
    try:
        return int(text.removeprefix("throttled=").strip(), 16)
    except ValueError:
        return None


def throttle_conditions(word: int, *, since_boot: bool = False) -> list[str]:
    shift = SINCE_BOOT_SHIFT if since_boot else 0
    return [name for bit, name in THROTTLE_BITS.items() if word & (1 << (bit + shift))]


def _undervoltage_hwmon(pattern: str) -> bool | None:
    for d in sorted(glob.glob(pattern)):
        if _read(os.path.join(d, "name")) == "rpi_volt":
            alarm = _read(os.path.join(d, "in0_lcrit_alarm"))
            return None if alarm is None else alarm == "1"
    return None


def sample(log_dir: str | None = None, *, throttled_path: str = THROTTLED_PATH,
           rpi_volt_glob: str = RPI_VOLT_GLOB,
           thermal_path: str = THERMAL_PATH) -> dict[str, Any]:
    """What this machine can say about itself now. Absent sources are None."""
    word = parse_throttled(_read(throttled_path))
    if word is not None:
        now = throttle_conditions(word)
        since = throttle_conditions(word, since_boot=True)
    else:
        uv = _undervoltage_hwmon(rpi_volt_glob)
        now = None if uv is None else (["under-voltage"] if uv else [])
        since = None
    temp = _read(thermal_path)
    try:
        temp_c = round(int(temp) / 1000, 1) if temp else None
    except ValueError:
        temp_c = None
    free = None
    if log_dir:
        try:
            free = shutil.disk_usage(log_dir).free
        except OSError:
            free = None
    return {"throttledNow": now, "throttledSinceBoot": since,
            "cpuTempC": temp_c, "logDiskFreeBytes": free}


class HostWatch:
    """Turns successive samples into operator alerts, each said once on onset."""

    def __init__(self) -> None:
        self._now: set[str] = set()
        self._low_disk = False

    def alerts(self, s: dict[str, Any]) -> list[str]:
        out: list[str] = []
        now = set(s.get("throttledNow") or [])
        for cond in sorted(now - self._now):
            hint = (" -- the hub's power supply is too weak; USB radios and the "
                    "autopilot link may drop" if cond == "under-voltage" else "")
            out.append(f"hub {cond}{hint}")
        self._now = now
        free = s.get("logDiskFreeBytes")
        low = free is not None and free < LOW_DISK_BYTES
        if low and not self._low_disk:
            out.append(f"hub disk nearly full ({free / 2**20:.0f} MiB free); "
                       "the flight log will stop when it is")
        self._low_disk = low
        return out
