"""Hub lifecycle commands — provision/update/run/inspect the Raspberry Pi.

Idempotent and Pi-guarded: the provisioning verbs refuse to reconfigure
networking on anything that isn't Raspberry Pi OS. Config (hostapd/dnsmasq/avahi/
systemd) ships as templates next to this module and is rendered into place by
`install`. Mirrors Guppi's installer ergonomics (acquire sudo once; the installer
is the single, re-runnable source of truth — no delta updates).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

TEMPLATES = Path(__file__).parent / "templates"

# Defaults (overridable via flags). These literals also appear in the templates,
# so rendering is a targeted replace of the default with the chosen value.
DEFAULTS = {
    "repo": "/opt/commandant",
    "ssid": "commandant",
    "passphrase": "changeme-commandant",
    "country": "US",
    "ap_ip": "192.168.50.1",
    "radio": "serial:/dev/serial0:57600",
    "hostname": "commandant",
    "user": "commandant",
}
SERVICES = ("gs.service", "console.service")


# --- small shell helpers -----------------------------------------------------

def _run(cmd: list[str], *, check: bool = True, quiet: bool = False) -> int:
    if not quiet:
        print(f"   $ {' '.join(cmd)}")
    return subprocess.run(cmd, check=check).returncode


def _sudo(cmd: list[str], **kw: Any) -> int:
    """Prefix with sudo unless already root."""
    if os.geteuid() != 0:
        cmd = ["sudo", *cmd]
    return _run(cmd, **kw)


def _is_raspberry_pi() -> bool:
    if Path("/etc/rpi-issue").exists():
        return True
    try:
        if "raspberry" in Path("/proc/device-tree/model").read_text(errors="ignore").lower():
            return True
    except OSError:
        pass
    try:
        return "raspbian" in Path("/etc/os-release").read_text().lower()
    except OSError:
        return False


def _require_pi(force: bool) -> None:
    if _is_raspberry_pi() or force:
        return
    print("This doesn't look like Raspberry Pi OS. Refusing to reconfigure "
          "networking (use --force to override).", file=sys.stderr)
    raise SystemExit(2)


def _opts(args: Any) -> dict[str, str]:
    """Merge DEFAULTS with any provided flags."""
    out = dict(DEFAULTS)
    for k in out:
        v = getattr(args, k, None)
        if v:
            out[k] = v
    return out


def _render(rel: str, subs: dict[str, str]) -> str:
    text = (TEMPLATES / rel).read_text()
    # Targeted replacement of template default literals with chosen values.
    text = text.replace("ssid=commandant", f"ssid={subs['ssid']}")
    text = text.replace("wpa_passphrase=changeme-commandant", f"wpa_passphrase={subs['passphrase']}")
    text = text.replace("country_code=US", f"country_code={subs['country']}")
    text = text.replace("192.168.50.1", subs["ap_ip"])
    text = text.replace("serial:/dev/serial0:57600", subs["radio"])
    return text


def _install_file(rel: str, dest: str, mode: str, subs: dict[str, str]) -> None:
    import tempfile
    rendered = _render(rel, subs)
    with tempfile.NamedTemporaryFile("w", suffix=".tmp", delete=False) as f:
        f.write(rendered)
        tmp = f.name
    _sudo(["install", "-D", "-m", mode, tmp, dest], quiet=True)
    Path(tmp).unlink(missing_ok=True)
    print(f"   installed {dest}")


# --- commands ----------------------------------------------------------------

def cmd_install(args: Any) -> int:
    """Provision a fresh Raspberry Pi into the hub. Idempotent; safe to re-run
    (that's exactly what `commandant update` does)."""
    o = _opts(args)
    _require_pi(args.force)
    repo = Path(o["repo"])
    print(f"== commandant install ==\n   repo={repo}  AP={o['ap_ip']} (wlan0)  "
          f"host={o['hostname']} -> http://{o['hostname']}.local/  radio={o['radio']}")

    if not repo.exists():
        print(f"!! {repo} not found — put the Commandant monorepo there first "
              f"(git clone), then re-run.", file=sys.stderr)
        return 3

    print("== apt packages ==")
    _sudo(["apt-get", "update"])
    _sudo(["apt-get", "install", "-y", "hostapd", "dnsmasq", "avahi-daemon",
           "dhcpcd5", "python3", "python3-venv", "python3-pip", "nodejs", "npm", "rfkill"])

    print("== service user ==")
    if subprocess.run(["id", "-u", o["user"]], capture_output=True).returncode != 0:
        _sudo(["useradd", "--system", "--create-home", "--shell", "/usr/sbin/nologin", o["user"]])
    _sudo(["usermod", "-aG", "dialout", o["user"]])

    print("== hostname + mDNS ==")
    _sudo(["hostnamectl", "set-hostname", o["hostname"]])
    _install_file("avahi/commandant.service", "/etc/avahi/services/commandant.service", "0644", o)
    _sudo(["systemctl", "enable", "--now", "avahi-daemon"])

    print("== wlan0 static IP (dhcpcd) ==")
    _ensure_dhcpcd_static(o)
    _sudo(["rfkill", "unblock", "wlan"], check=False)

    print("== hostapd + dnsmasq ==")
    _install_file("hostapd.conf", "/etc/hostapd/hostapd.conf", "0644", o)
    _sudo(["sed", "-i", 's|^#\\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|',
           "/etc/default/hostapd"], check=False)
    _install_file("dnsmasq.conf", "/etc/dnsmasq.d/commandant.conf", "0644", o)
    _sudo(["systemctl", "unmask", "hostapd"])
    _sudo(["systemctl", "enable", "hostapd", "dnsmasq"])

    print("== build gs (venv) + console (production) ==")
    _sudo(["chown", "-R", f"{o['user']}:{o['user']}", str(repo)])
    _as_user(o["user"], ["python3", "-m", "venv", str(repo / "packages/gs/.venv")])
    _as_user(o["user"], [str(repo / "packages/gs/.venv/bin/pip"), "install", "-e",
                         str(repo / "packages/gs")])
    _as_user(o["user"], ["npm", "install"], cwd=repo)
    _as_user(o["user"], ["npm", "run", "build", "--workspace", "console"], cwd=repo)

    print("== systemd units ==")
    _install_file("gs.env", "/etc/commandant/gs.env", "0644", o)
    _install_file("systemd/gs.service", "/etc/systemd/system/gs.service", "0644", o)
    _install_file("systemd/console.service", "/etc/systemd/system/console.service", "0644", o)
    _sudo(["systemctl", "daemon-reload"])
    _sudo(["systemctl", "enable", *SERVICES])

    print("\n== done ==\nReview /etc/commandant/gs.env (radio) and the WiFi passphrase "
          "in /etc/hostapd/hostapd.conf, then: sudo reboot")
    print(f"After reboot: join WiFi '{o['ssid']}' and open http://{o['hostname']}.local/")
    return 0


def _ensure_dhcpcd_static(o: dict[str, str]) -> None:
    """Append a one-time static-IP block for wlan0 to dhcpcd.conf (idempotent)."""
    conf = Path("/etc/dhcpcd.conf")
    try:
        if conf.exists() and "# commandant-hub" in conf.read_text():
            print("   dhcpcd static IP already present")
            return
    except OSError:
        pass
    block = (f"\n# commandant-hub\ninterface wlan0\n"
             f"static ip_address={o['ap_ip']}/24\nnohook wpa_supplicant\n")
    # Append as root via tee -a.
    p = subprocess.Popen(["sudo", "tee", "-a", str(conf)] if os.geteuid() != 0
                         else ["tee", "-a", str(conf)], stdin=subprocess.PIPE)
    p.communicate(block.encode())


def _as_user(user: str, cmd: list[str], *, cwd: Path | None = None) -> None:
    full = cmd if os.geteuid() != 0 else ["sudo", "-u", user, *cmd]
    print(f"   $ {' '.join(full)}")
    subprocess.run(full, check=True, cwd=str(cwd) if cwd else None)


def cmd_update(args: Any) -> int:
    """Re-run the installer (idempotent), rebuild, restart services. Pulls latest
    first if the repo is a git checkout. Like `guppi update`: no delta updates."""
    o = _opts(args)
    repo = Path(o["repo"])
    if (repo / ".git").exists() and not args.no_pull:
        print("== git pull ==")
        _as_user(o["user"], ["git", "pull", "--ff-only"], cwd=repo)
    rc = cmd_install(args)
    if rc == 0:
        print("== restart services ==")
        _sudo(["systemctl", "restart", *SERVICES])
    return rc


def cmd_uninstall(args: Any) -> int:
    """Remove hub services and config. Leaves the repo and the OS WiFi stack in a
    sane state; does NOT delete the monorepo or user data."""
    if not args.yes:
        reply = input("Remove the hub services and config? (repo/data kept) [y/N] ")
        if reply.strip().lower() not in ("y", "yes"):
            print("aborted"); return 1
    _sudo(["systemctl", "disable", "--now", *SERVICES], check=False)
    for path in ("/etc/systemd/system/gs.service", "/etc/systemd/system/console.service",
                 "/etc/dnsmasq.d/commandant.conf", "/etc/avahi/services/commandant.service"):
        _sudo(["rm", "-f", path], check=False, quiet=True)
    _sudo(["systemctl", "disable", "--now", "hostapd", "dnsmasq"], check=False)
    _sudo(["systemctl", "daemon-reload"], check=False)
    print("Removed hub services/config. (hostapd.conf, dhcpcd block, repo left in "
          "place — remove by hand if you want a full teardown.)")
    return 0


def cmd_status(args: Any) -> int:
    """Show hub + service health at a glance."""
    print(f"hostname: {os.uname().nodename}  (expect: {DEFAULTS['hostname']}.local)")
    for svc in (*SERVICES, "hostapd.service", "dnsmasq.service", "avahi-daemon.service"):
        state = subprocess.run(["systemctl", "is-active", svc],
                               capture_output=True, text=True).stdout.strip() or "unknown"
        print(f"  {svc:<22} {state}")
    return 0


def cmd_up(args: Any) -> int:
    """Start the hub services."""
    return _sudo(["systemctl", "start", *SERVICES], check=False)


def cmd_down(args: Any) -> int:
    """Stop the hub services."""
    return _sudo(["systemctl", "stop", *SERVICES], check=False)


def cmd_logs(args: Any) -> int:
    """Tail a hub service's logs (gs or console; default both)."""
    svc = {"gs": "gs.service", "console": "console.service"}.get(args.service)
    cmd = ["journalctl", "-f", "-n", "100"]
    cmd += ["-u", svc] if svc else ["-u", "gs.service", "-u", "console.service"]
    try:
        return _sudo(cmd, check=False)
    except KeyboardInterrupt:
        return 0


def cmd_dev(args: Any) -> int:
    """Laptop test: run gs + the console dev server locally (NOT the Pi). gs reads
    the radio/endpoint from --radio (default a bench UDP, since a laptop usually
    has no serial radio)."""
    o = _opts(args)
    repo = Path(o["repo"]) if args.repo else Path(__file__).resolve().parents[3]
    radio = args.radio or "udpin:0.0.0.0:14550"
    gs_py = repo / "packages/gs/.venv/bin/python"
    gs_cmd = [str(gs_py) if gs_py.exists() else sys.executable, "-m", "gs", "--mavlink", radio]
    print(f"== dev: gs ({radio}) + console (next dev) ==  Ctrl-C to stop")
    gs = subprocess.Popen(gs_cmd, cwd=str(repo / "packages/gs"))
    console = subprocess.Popen(["npm", "run", "dev", "--workspace", "console"], cwd=str(repo))
    try:
        console.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for p in (console, gs):
            p.terminate()
    return 0
