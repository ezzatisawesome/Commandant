"""Hub lifecycle commands — provision/update/run/inspect the hub.

The hub is any systemd Linux machine with a WiFi interface that can act as an
access point; a Raspberry Pi is the usual one, not a requirement. What the
installer depends on is checked directly instead of inferred from the board:
systemd, a WiFi interface, and something that manages networking --
NetworkManager (current Pi OS, Ubuntu, Debian, Fedora) or dhcpcd (older Pi OS),
which decides how the access point is built.

Idempotent. Config (hostapd/dnsmasq/avahi/systemd) ships as templates next to
this module and is rendered into place by `install`. Mirrors Guppi's installer
ergonomics (acquire sudo once; the installer is the single, re-runnable source
of truth — no delta updates).
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import secrets
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
    # gs probes USB, the Pi's UART and UDP/TCP itself, so the default works on
    # whatever the radio turns out to be plugged into.
    "radio": "auto",
    "hostname": "commandant",
    "user": "commandant",
    # Empty means detect: the machine's WiFi interface, whatever it is named.
    "iface": "",
}
SERVICES = ("gs.service", "console.service")

# What `install` was told, so `update` -- which re-runs it, usually with no
# flags -- does not quietly put every default back. It used to: an update
# reset the WiFi passphrase to the published placeholder, on the network that
# holds command authority over the aircraft. The passphrase goes in its own
# root-only file so the rest stays readable: a plain `commandant status` needs
# the real AP address and hostname, not the defaults. The radio is in neither;
# gs.env is that setting's home (see cmd_install).
SAVED = "/etc/commandant/hub.json"
SAVED_SECRET = "/etc/commandant/hub.psk"
GS_ENV = "/etc/commandant/gs.env"
SAVED_KEYS = ("repo", "ssid", "passphrase", "country", "ap_ip", "hostname", "user", "iface")

NETWORKMANAGER = "networkmanager"
DHCPCD = "dhcpcd"
NM_CONNECTION = "commandant-ap"

# Debian names. Off apt, these are what to install by hand (--skip-packages).
COMMON_PACKAGES = ("avahi-daemon", "python3", "python3-venv", "python3-pip",
                   "nodejs", "npm", "rfkill")
# Next 15's floor. Older distros' apt nodejs is far below it (Debian Bullseye
# and Ubuntu 22.04 ship 12), and the build is the last step, after the network
# has already been reconfigured.
NODE_MIN = (18, 18)
# gs's requires-python. Same trap: Ubuntu 22.04 ships 3.10, Bullseye 3.9, and
# `pip install -e packages/gs` is a build step.
PYTHON_MIN = (3, 11)

# NetworkManager's shared mode runs its own dnsmasq, so it needs only the
# binary. The full `dnsmasq` package would start a system instance that holds
# port 53 and stops NetworkManager's from serving DHCP.
AP_PACKAGES = {NETWORKMANAGER: ("dnsmasq-base", "iw"),
               DHCPCD: ("hostapd", "dnsmasq")}


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


def _wifi_ifaces() -> list[str]:
    """Every interface with an nl80211 radio behind it -- the only kind hostapd
    or NetworkManager can turn into an access point. Named wlan0 on a Pi, but
    wlp2s0 and the like on most other machines."""
    return sorted(p.parent.name for p in Path("/sys/class/net").glob("*/phy80211"))


def _active(unit: str) -> bool:
    try:
        return subprocess.run(["systemctl", "is-active", "--quiet", unit],
                              stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL).returncode == 0
    except (FileNotFoundError, OSError):
        return False


def _network_backend() -> str:
    """Who manages networking here, and so how the access point gets built.

    Decided by which daemon is RUNNING, not which is installed. Pi OS Bookworm
    keeps dhcpcd's config around while NetworkManager owns the network, and
    Ubuntu 24.04 ships the dhcpcd binary (dhcpcd-base) as a mere DHCP client
    under networkd -- on either, a static IP written to /etc/dhcpcd.conf is read
    by nobody, the AP comes up with no address, and dnsmasq has nothing to
    bind to."""
    if shutil.which("nmcli") and _active("NetworkManager"):
        return NETWORKMANAGER
    if _active("dhcpcd"):
        return DHCPCD
    return ""


def _iface_addresses(iface: str) -> list[str]:
    """IPv4 addresses on `iface`, without the prefix length."""
    if not iface:
        return []
    try:
        out = subprocess.run(["ip", "-4", "-o", "addr", "show", "dev", iface],
                             capture_output=True, text=True).stdout
    except (FileNotFoundError, OSError):
        return []
    addrs = []
    for line in out.splitlines():
        fields = line.split()
        if "inet" in fields:
            addrs.append(fields[fields.index("inet") + 1].split("/")[0])
    return addrs


def _preflight(o: dict[str, str], force: bool) -> str:
    """Check for what the installer actually needs and return the network
    backend. Refuses with every problem at once rather than the first, so a
    machine that is not ready is fixed in one pass, not several.

    The guard that matters is not "is this a Pi" but "is this interface in use":
    turning a connected interface into the access point drops that connection,
    which on a laptop is its WiFi and on a Pi set up over WiFi is the ssh
    session running this command. An address that is already the AP's own means
    a re-run, which is fine."""
    problems = []
    if os.geteuid() != 0 and not shutil.which("sudo"):
        problems.append("not root, and there is no sudo: run this as root.")
    if not Path("/run/systemd/system").exists():
        problems.append("systemd is not running; the hub's services are systemd units.")
    if not o["iface"]:
        problems.append("no WiFi interface found (nothing under /sys/class/net/*/phy80211); "
                        "pass --iface if there is one.")
    elif o["iface"] not in _wifi_ifaces():
        # A typo, a wired interface, or a dongle not plugged in: each would get
        # an access point configured onto it that can never come up.
        problems.append(f"{o['iface']} is not a WiFi interface here (WiFi: "
                        f"{', '.join(_wifi_ifaces()) or 'none'}).")
    try:
        ap = ipaddress.IPv4Address(o["ap_ip"])
        if not ap.is_private or int(ap) & 0xFF in (0, 255):
            raise ValueError
    except ValueError:
        problems.append(f"--ap-ip {o['ap_ip']} must be a private IPv4 host address "
                        "(the hub's own, on a /24), e.g. 192.168.50.1.")
    backend = _network_backend()
    if not backend:
        problems.append("neither NetworkManager nor dhcpcd manages networking here. "
                        "Install NetworkManager (apt install network-manager) and re-run.")
    # WPA2's limits. Caught here, not by nmcli halfway through (with the old AP
    # already reconfigured) or by hostapd at boot (with nothing on screen).
    if not 8 <= len(o["passphrase"]) <= 63:
        problems.append(f"the WiFi passphrase must be 8-63 characters (got "
                        f"{len(o['passphrase'])}).")
    if not 1 <= len(o["ssid"].encode()) <= 32:
        problems.append(f"the SSID must be 1-32 bytes (got {len(o['ssid'].encode())}).")
    # What hostnamectl accepts and mDNS can announce as <name>.local.
    if not re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?", o["hostname"]):
        problems.append(f"--hostname {o['hostname']!r} must be letters, digits and "
                        "inner hyphens, at most 63 characters.")
    if backend == NETWORKMANAGER:
        # Either one makes NetworkManager's AP fail with nothing said: hostapd
        # takes the interface, a system dnsmasq holds the DNS/DHCP ports its
        # own needs. Left by an older dhcpcd-era install, or by something else.
        for unit in ("hostapd", "dnsmasq"):
            if _active(unit):
                problems.append(f"{unit}.service is running and will keep "
                                f"NetworkManager's access point from working. If "
                                f"nothing else needs it: systemctl disable --now {unit}")
    if problems:
        print("Not ready to become a hub:\n" + "\n".join(f"  - {p}" for p in problems),
              file=sys.stderr)
        raise SystemExit(2)

    in_use = [a for a in _iface_addresses(o["iface"]) if a != o["ap_ip"]]
    if in_use and not force:
        print(f"{o['iface']} is connected right now ({', '.join(in_use)}). Making it "
              "the access point will drop that connection -- and this session, if "
              "you are on it.\nRe-run with --force if that is intended, or --iface "
              "to use another interface.", file=sys.stderr)
        raise SystemExit(2)
    return backend


def _flags(args: Any) -> dict[str, str]:
    """The settings given on this command line."""
    return {k: v for k in DEFAULTS if (v := getattr(args, k, None))}


def _read(path: str, elevate: bool) -> str:
    try:
        return Path(path).read_text()
    except FileNotFoundError:
        return ""
    except PermissionError:
        if not elevate:
            return ""
        return subprocess.run(["sudo", "cat", path], capture_output=True, text=True).stdout


def _saved(elevate: bool = False) -> dict[str, str]:
    """What earlier installs were told. The passphrase is root-only, read only
    by install/update, which elevate for everything else anyway."""
    try:
        d = json.loads(_read(SAVED, elevate) or "{}")
    except ValueError:
        d = {}
    if not isinstance(d, dict):
        d = {}
    psk = _read(SAVED_SECRET, elevate).strip()
    if psk:
        d["passphrase"] = psk
    return {k: v for k, v in d.items() if k in SAVED_KEYS and isinstance(v, str) and v}


def _opts(args: Any, saved: dict[str, str] | None = None) -> dict[str, str]:
    """DEFAULTS, then what earlier installs were told, then this command's
    flags."""
    out = dict(DEFAULTS)
    out.update(saved if saved is not None else _saved())
    out.update(_flags(args))
    if not out["iface"]:
        out["iface"] = _pick_iface(_wifi_ifaces(), out["ap_ip"])
    return out


def _pick_iface(found: list[str], ap_ip: str) -> str:
    """The AP's interface among several. A hub that must stay online has two
    WiFi interfaces -- one the AP, one the uplink -- and taking the first by
    name would pick the connected uplink and refuse (or, forced, cut it). So:
    the one already holding the AP's address (a re-run, or `status`), else one
    with no connection, else the first."""
    if not found:
        return ""
    addrs = {i: _iface_addresses(i) for i in found}
    for i in found:
        if ap_ip in addrs[i]:
            return i
    for i in found:
        if not addrs[i]:
            return i
    return found[0]


def _render(rel: str, subs: dict[str, str]) -> str:
    text = (TEMPLATES / rel).read_text()
    # Targeted replacement of template default literals with chosen values.
    text = text.replace("ssid=commandant", f"ssid={subs['ssid']}")
    text = text.replace("wpa_passphrase=changeme-commandant", f"wpa_passphrase={subs['passphrase']}")
    text = text.replace("country_code=US", f"country_code={subs['country']}")
    # The DHCP pool is computed from the AP's /24, and held out of the address
    # replace below: that replace, run over the pool, only came out right when
    # the address ended in .1 (10.0.0.254 made "10.0.0.2540", and dnsmasq
    # refused the whole file) -- and run over a computed pool still in
    # 192.168.50.x, it would corrupt that too.
    text = text.replace("dhcp-range=192.168.50.10,192.168.50.100,", "dhcp-range=@POOL@,")
    text = text.replace("192.168.50.1", subs["ap_ip"])
    text = text.replace("@POOL@", _dhcp_pool(subs["ap_ip"]))
    text = text.replace("GS_MAVLINK=auto", f"GS_MAVLINK={subs['radio']}")
    # --repo, --user and --hostname were accepted and then ignored here: the
    # build went to --repo while the units still ran /opt/commandant as
    # `commandant`, and the DNS fallback answered only for `commandant`.
    text = text.replace("/opt/commandant/", f"{subs['repo'].rstrip('/')}/")
    text = text.replace("User=commandant", f"User={subs['user']}")
    text = text.replace("Group=commandant", f"Group={subs['user']}")
    text = text.replace("address=/commandant/", f"address=/{subs['hostname']}/")
    text = text.replace("address=/commandant.local/", f"address=/{subs['hostname']}.local/")
    if subs.get("iface"):
        text = text.replace("interface=wlan0", f"interface={subs['iface']}")
    return text


def _dhcp_pool(ap_ip: str) -> str:
    """Ninety-one client addresses in the AP's /24, clear of the AP itself."""
    net = ap_ip.rsplit(".", 1)[0]
    lo = 110 if 10 <= int(ap_ip.rsplit(".", 1)[1]) <= 100 else 10
    return f"{net}.{lo},{net}.{lo + 90}"


def _install_file(rel: str, dest: str, mode: str, subs: dict[str, str]) -> None:
    _install_text(_render(rel, subs), dest, mode)


def _install_text(text: str, dest: str, mode: str) -> None:
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".tmp", delete=False) as f:
        f.write(text)
        tmp = f.name
    _sudo(["install", "-D", "-m", mode, tmp, dest], quiet=True)
    Path(tmp).unlink(missing_ok=True)
    print(f"   installed {dest}")


# --- commands ----------------------------------------------------------------

def cmd_install(args: Any) -> int:
    """Provision this machine into the hub. Idempotent; safe to re-run (that's
    exactly what `commandant update` does)."""
    saved = _saved(elevate=True)
    flags = _flags(args)
    o = _opts(args, saved)
    backend = _preflight(o, args.force)
    repo = Path(o["repo"])
    print(f"== commandant install ==\n   repo={repo}  AP={o['ap_ip']} ({o['iface']}, "
          f"{backend})  host={o['hostname']} -> http://{o['hostname']}.local/  "
          f"radio={o['radio']}")

    if not repo.exists():
        print(f"!! {repo} not found — put the Commandant monorepo there first "
              f"(git clone), then re-run.", file=sys.stderr)
        return 3

    if not _install_packages(backend, getattr(args, "skip_packages", False)):
        return 4

    # Only what was ever given explicitly: a default saved here would read as a
    # choice next time (a saved "US" would override a country raspi-config set).
    remember = {k: v for k, v in {**saved, **flags}.items() if k in SAVED_KEYS}
    psk = remember.pop("passphrase", "")
    _install_text(json.dumps(remember, indent=2) + "\n", SAVED, "0644")
    if psk:
        _install_text(psk + "\n", SAVED_SECRET, "0600")

    print("== service user ==")
    if subprocess.run(["id", "-u", o["user"]], capture_output=True).returncode != 0:
        _sudo(["useradd", "--system", "--create-home", "--shell", "/usr/sbin/nologin", o["user"]])
    _sudo(["usermod", "-aG", "dialout", o["user"]])
    _ensure_home(o["user"])

    print("== hostname + mDNS ==")
    _sudo(["hostnamectl", "set-hostname", o["hostname"]])
    _install_file("avahi/commandant.service", "/etc/avahi/services/commandant.service", "0644", o)
    _sudo(["systemctl", "enable", "--now", "avahi-daemon"])

    print(f"== access point on {o['iface']} ({backend}) ==")
    if shutil.which("rfkill"):
        _sudo(["rfkill", "unblock", "wlan"], check=False)
    if backend == NETWORKMANAGER:
        _ap_networkmanager(o, set_country="country" in flags or "country" in saved)
    else:
        _ap_hostapd(o)

    print("== build gs (venv) + console (production) ==")
    _sudo(["chown", "-R", f"{o['user']}:{o['user']}", str(repo)])
    venv = repo / "packages/gs/.venv"
    # `python3 -m venv` over an existing venv leaves a broken interpreter
    # broken -- after a distro upgrade, or a run cut short -- and gs.service
    # then fails at boot with Exec format error / No such file. Found by
    # running install for real. A venv whose python does not run is rebuilt.
    # "Runs" means answers with a code only Python would give: exit 0 proves
    # nothing, because env's execvp runs a file the kernel will not exec as a
    # shell script -- and an empty one "succeeds". systemd's execve does not.
    clear = (venv / "bin/python").exists() and _as_user(
        o["user"], [str(venv / "bin/python"), "-c", "raise SystemExit(42)"],
        check=False) != 42
    if clear:
        print("   the gs venv's python does not run; rebuilding it")
    _as_user(o["user"], ["python3", "-m", "venv", *(["--clear"] if clear else []), str(venv)])
    _as_user(o["user"], [str(repo / "packages/gs/.venv/bin/pip"), "install", "-e",
                         str(repo / "packages/gs")])
    _as_user(o["user"], ["npm", "install"], cwd=repo)
    _as_user(o["user"], ["npm", "run", "build", "--workspace", "console"], cwd=repo)

    print("== systemd units ==")
    new_token = _install_gs_env(o, radio_given="radio" in flags)
    _install_file("systemd/gs.service", "/etc/systemd/system/gs.service", "0644", o)
    _install_file("systemd/console.service", "/etc/systemd/system/console.service", "0644", o)
    _sudo(["systemctl", "daemon-reload"])
    _sudo(["systemctl", "enable", *SERVICES])

    if o["passphrase"] == DEFAULTS["passphrase"]:
        print("\n!! The WiFi passphrase is still the placeholder. Re-run with "
              "--passphrase before taking this to a field.")
    if new_token:
        print(f"\n   COMMAND TOKEN: {new_token}\n   The console asks for it before "
              "anyone can arm. Shown once; it is kept in /etc/commandant/gs.env.")
    elif not _env_value(_read(GS_ENV, elevate=True), "GS_COMMAND_TOKEN"):
        print("\n!! No GS_COMMAND_TOKEN in /etc/commandant/gs.env: anyone on the hub's "
              "WiFi can arm the aircraft. Set one there and restart gs.")
    print("\n== done ==\nReview /etc/commandant/gs.env (radio), then: sudo reboot")
    print(f"After reboot: join WiFi '{o['ssid']}' and open http://{o['hostname']}.local/")
    return 0


def _version(binary: str) -> tuple[int, ...] | None:
    """(major, minor) of `binary --version`, which prints `v20.11.1` for node
    and `Python 3.11.2` for python3."""
    if not shutil.which(binary):
        return None
    try:
        r = subprocess.run([binary, "--version"], capture_output=True, text=True)
        v = (r.stdout or r.stderr).split()[-1].lstrip("v")
        return tuple(int(x) for x in v.split(".")[:2])
    except (OSError, ValueError, IndexError):
        return None


def _node_version() -> tuple[int, ...] | None:
    return _version("node")


def _python_version() -> tuple[int, ...] | None:
    return _version("python3")


def _env_value(text: str, key: str) -> str:
    """The value of `key=` in an env file's text, "" if unset or commented."""
    for line in text.splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    return ""


def _install_gs_env(o: dict[str, str], radio_given: bool) -> str:
    """Write gs.env once; after that it is the operator's file. The relay
    token, GS_EVENTS_META and a pinned radio are all edited there by hand, as
    the file itself says to, and re-rendering it on every `update` wiped them.
    --radio, when given, still changes just its own line.

    The first write also generates the command token, returned so install can
    show it once. The roadmap called command authority token-gated while no
    install ever set a token, so on a real hub it was open to anyone on the
    WiFi. 0600: this file holds that token and the relay's."""
    dest = Path(GS_ENV)
    if not dest.exists():
        token = secrets.token_urlsafe(12)
        text = _render("gs.env", o).replace("GS_COMMAND_TOKEN=\n",
                                            f"GS_COMMAND_TOKEN={token}\n")
        _install_text(text, str(dest), "0600")
        return token
    current = _read(str(dest), elevate=True)
    if radio_given:
        lines = [f"GS_MAVLINK={o['radio']}" if l.startswith("GS_MAVLINK=") else l
                 for l in current.splitlines()]
        _install_text("\n".join(lines) + "\n", str(dest), "0600")
    else:
        # Still tightened: an older install wrote it world-readable.
        _sudo(["chmod", "0600", str(dest)], check=False, quiet=True)
        print(f"   kept {dest} (--radio to change the radio)")
    return ""


def _install_packages(backend: str, skip: bool) -> bool:
    """apt where there is apt. Elsewhere, say what is needed rather than guess
    another package manager's names for it.

    A Node already new enough is left alone: it is usually NodeSource's or
    nvm's, put there because apt's is too old, and asking apt for `nodejs npm`
    on top of NodeSource's package is a dependency conflict that fails the
    whole install."""
    have_node = (_node_version() or (0,)) >= NODE_MIN
    needed = tuple(pkg for pkg in (*COMMON_PACKAGES, *AP_PACKAGES[backend])
                   if not (have_node and pkg in ("nodejs", "npm")))
    if skip:
        print("== packages: skipped (--skip-packages) ==")
    elif not shutil.which("apt-get"):
        print("!! No apt-get here. Install the equivalents of these (Debian names) "
              f"with your package manager, then re-run with --skip-packages:\n   "
              f"{' '.join(needed)}", file=sys.stderr)
        return False
    else:
        print("== apt packages ==")
        # -y does not cover debconf questions or conffile prompts, and the
        # installer edits /etc/default/hostapd: a newer hostapd on a later
        # `update` would stop and wait for an answer. Keep what is on disk.
        # Through `env`, because sudo drops DEBIAN_FRONTEND from the environment.
        apt = ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get"]
        _sudo([*apt, "update"])
        # --no-install-recommends: on Debian the recommends of python3-pip and
        # npm are a compiler and X11 libraries -- about 640 packages on a bare
        # bookworm, onto an SD card. Nothing here builds native code (gs's
        # wheels are prebuilt); a full install was run this way to check.
        _sudo([*apt, "install", "-y", "--no-install-recommends",
               "-o", "Dpkg::Options::=--force-confdef",
               "-o", "Dpkg::Options::=--force-confold", *needed])

    # Checked here, before the network is touched, not discovered at the build.
    ok = True
    for what, have, need, fix in (
            ("The console", _node_version(), NODE_MIN, "e.g. NodeSource's nodejs 20"),
            ("gs", _python_version(), PYTHON_MIN, "e.g. from the deadsnakes PPA, as python3")):
        if have is None or have < need:
            found = ".".join(map(str, have)) if have else "none"
            name = "Node" if what == "The console" else "Python"
            print(f"!! {what} needs {name} >= {'.'.join(map(str, need))}; found {found}. "
                  f"Install a newer one ({fix}) and re-run.", file=sys.stderr)
            ok = False
    return ok


def _ap_networkmanager(o: dict[str, str], set_country: bool = True) -> None:
    """The access point as one NetworkManager connection. `ipv4.method shared`
    makes NetworkManager run its own DHCP and DNS (dnsmasq) for the clients,
    which is what hostapd + dnsmasq + a static IP add up to on the legacy path.
    It also NATs clients out through any uplink the hub has; with none, in a
    field, that is a no-op.

    An existing connection is MODIFIED, never deleted and re-added. `update` is
    run in the field, over this very AP: deleting it takes the network down on
    the spot, the session running the update with it, and leaves a half-done
    install behind. A modify saves the settings without touching the live
    connection; they apply at the reboot install ends by asking for -- the
    same moment the hostapd path's do. Every setting is given each time, so a
    re-run still converges on exactly these whatever was changed by hand."""
    iface = o["iface"]
    _sudo(["nmcli", "device", "set", iface, "managed", "yes"], check=False)
    settings = [
        "connection.interface-name", iface, "connection.autoconnect", "yes",
        # Above any client profile for the same interface -- Raspberry Pi
        # Imager saves one as "preconfigured" -- which also autoconnects. At
        # equal priority NetworkManager may join that network at boot instead
        # of starting the AP, whenever it is in range: on the bench, typically.
        "connection.autoconnect-priority", "100",
        "802-11-wireless.ssid", o["ssid"], "802-11-wireless.mode", "ap",
        # 2.4 GHz, channel 7: the hostapd template's choice, for the same
        # reason -- phones at range in a field.
        "802-11-wireless.band", "bg", "802-11-wireless.channel", "7",
        "ipv4.method", "shared", "ipv4.addresses", f"{o['ap_ip']}/24",
        "ipv6.method", "disabled",
        "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", o["passphrase"],
        "wifi-sec.proto", "rsn", "wifi-sec.pairwise", "ccmp", "wifi-sec.group", "ccmp",
    ]
    verb = (["modify", NM_CONNECTION] if _nm_has_connection()
            else ["add", "type", "wifi", "con-name", NM_CONNECTION])
    # quiet: the command line carries the passphrase.
    print(f"   $ nmcli connection {verb[0]} {NM_CONNECTION} (ssid={o['ssid']}, "
          f"{o['ap_ip']}/24 shared, WPA2)")
    _sudo(["nmcli", "connection", *verb, *settings], quiet=True)
    # The bare-hostname fallback the legacy dnsmasq.conf carries, for the
    # dnsmasq that NetworkManager runs.
    _install_file("nm-dnsmasq-shared.conf",
                  "/etc/NetworkManager/dnsmasq-shared.d/commandant.conf", "0644", o)
    # NetworkManager has no country setting; hostapd's country_code does this
    # on the legacy path. Persisted for boot, applied now for this one. Only
    # when asked, or when the machine has none: the default is a placeholder,
    # and a Pi that raspi-config set to GB must not be quietly moved to US.
    if set_country or not _system_regdom():
        _install_text(f"options cfg80211 ieee80211_regdom={o['country']}\n",
                      "/etc/modprobe.d/commandant-regdom.conf", "0644")
        if shutil.which("iw"):
            _sudo(["iw", "reg", "set", o["country"]], check=False)
    else:
        print(f"   regulatory domain left at {_system_regdom()} (--country to change)")


def _nm_has_connection() -> bool:
    try:
        out = subprocess.run(["nmcli", "-t", "-f", "NAME", "connection", "show"],
                             capture_output=True, text=True).stdout
    except OSError:
        return False
    return NM_CONNECTION in out.splitlines()


def _system_regdom() -> str:
    """The country the WiFi stack is set to, or "" for none (the world domain,
    00, which is what an unconfigured machine has)."""
    if not shutil.which("iw"):
        return ""
    try:
        out = subprocess.run(["iw", "reg", "get"], capture_output=True, text=True).stdout
    except OSError:
        return ""
    for line in out.splitlines():
        if line.startswith("country "):
            cc = line.split()[1].rstrip(":")
            return "" if cc == "00" else cc
    return ""


def _ap_hostapd(o: dict[str, str]) -> None:
    """The access point for a machine whose networking dhcpcd owns: a static IP
    on the interface, hostapd for the radio, dnsmasq for DHCP."""
    _ensure_dhcpcd_static(o)
    # 0600: it holds the WiFi passphrase. hostapd runs as root.
    _install_file("hostapd.conf", "/etc/hostapd/hostapd.conf", "0600", o)
    _sudo(["sed", "-i", 's|^#\\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|',
           "/etc/default/hostapd"], check=False)
    _install_file("dnsmasq.conf", "/etc/dnsmasq.d/commandant.conf", "0644", o)
    _sudo(["systemctl", "unmask", "hostapd"])
    _sudo(["systemctl", "enable", "hostapd", "dnsmasq"])
    print("   WiFi passphrase is in /etc/hostapd/hostapd.conf")


def _has_dhcpcd_block() -> bool:
    try:
        return "# commandant-hub" in Path("/etc/dhcpcd.conf").read_text()
    except OSError:
        return False


def _ensure_dhcpcd_static(o: dict[str, str]) -> None:
    """Append a one-time static-IP block for the AP interface to dhcpcd.conf
    (idempotent)."""
    conf = Path("/etc/dhcpcd.conf")
    if _has_dhcpcd_block():
        print("   dhcpcd static IP already present")
        return
    block = (f"\n# commandant-hub\ninterface {o['iface']}\n"
             f"static ip_address={o['ap_ip']}/24\nnohook wpa_supplicant\n")
    # Append as root via tee -a.
    p = subprocess.Popen(["sudo", "tee", "-a", str(conf)] if os.geteuid() != 0
                         else ["tee", "-a", str(conf)], stdin=subprocess.PIPE)
    p.communicate(block.encode())


def _ensure_home(user: str) -> None:
    """The build needs a writable home (npm's cache, pip's). useradd only makes
    one for a user it creates: a service user that already existed without
    one -- made by hand, or by an earlier run cut short -- got skipped, and
    npm failed with EACCES at the install's last step. Found by running
    install for real, in a container."""
    import pwd
    home = pwd.getpwnam(user).pw_dir
    if Path(home).is_dir():
        return
    _sudo(["install", "-d", "-m", "0750", "-o", user, "-g", user, home])


def _current_user() -> str:
    try:
        import pwd
        return pwd.getpwuid(os.geteuid()).pw_name
    except (ImportError, KeyError):
        return ""


def _as_user(user: str, cmd: list[str], *, cwd: Path | None = None,
             check: bool = True) -> int:
    """Run a command AS `user`, unless we already are them.

    The condition was the other way round -- `cmd if os.geteuid() != 0` -- which
    is the opposite of what `_sudo` above does and breaks the documented install
    flow. Invoked the normal way (as `pi`, with sudo available) it ran the build
    steps as the INVOKING user, immediately after
    `chown -R commandant:commandant` had handed the repo to the service user. So
    `python -m venv` wrote into a tree it no longer owned and the install died
    at the build step, every time, on a real Pi. Never caught because this file
    has never been run.

    `-H` sets HOME to the target user's, which npm needs: `sudo -u` alone keeps
    the invoker's HOME, so the build would populate root's or pi's npm cache --
    or fail outright for a service account whose shell is nologin.

    As root it is `runuser`, not sudo: a Debian server installed with a root
    password has no sudo at all, and the build is the last step -- the crash
    would come after the network was already reconfigured. runuser is
    util-linux, so it is everywhere; HOME is set by hand for the same npm
    reason as -H."""
    if _current_user() == user:
        full = cmd
    elif os.geteuid() == 0:
        import pwd
        home = pwd.getpwnam(user).pw_dir
        full = ["runuser", "-u", user, "--", "env", f"HOME={home}", *cmd]
    else:
        full = ["sudo", "-u", user, "-H", *cmd]
    print(f"   $ {' '.join(full)}")
    try:
        return subprocess.run(full, check=check, cwd=str(cwd) if cwd else None).returncode
    except OSError:
        if check:
            raise
        return 126


def cmd_update(args: Any) -> int:
    """Re-run the installer (idempotent), rebuild, restart services. Pulls latest
    first if the repo is a git checkout. Like `guppi update`: no delta updates."""
    # Elevated: a repo or user given to install lives in the root-only file,
    # and pulling the default path instead would update the wrong checkout.
    o = _opts(args, _saved(elevate=True))
    repo = Path(o["repo"])
    if (repo / ".git").exists() and not args.no_pull:
        print("== git pull ==")
        _as_user(o["user"], ["git", "pull", "--ff-only"], cwd=repo)
    rc = cmd_install(args)
    if rc == 0:
        print("== restart services ==")
        _sudo(["systemctl", "restart", *SERVICES])
    return rc


# --- the rest of the lifecycle ----------------------------------------------
#
# install/update were the only verbs that existed, while the package
# description and the roadmap both promised status/up/down/logs/uninstall. On a
# field hub these are the ones actually reached for: `commandant status` and
# `commandant logs` are what you type when the page does not load, and they were
# an argparse error.
#
# Thin by design. Each is a few systemctl or journalctl calls, and the value is
# that the operator does not have to remember two unit names, a port and a
# journal filter while standing in a field.

def _unit_state(unit: str) -> tuple[str, str]:
    """(active-state, enabled-state) for a unit, without needing root."""
    def ask(verb: str) -> str:
        # `status` must work wherever it is typed -- somebody checking the tool
        # on a Mac should get an answer, not a traceback from a missing
        # systemctl. The same guard covers a hub where systemd is not where it
        # is expected.
        try:
            r = subprocess.run(["systemctl", verb, unit], capture_output=True, text=True)
        except (FileNotFoundError, OSError):
            return "no systemd"
        text = (r.stdout or r.stderr).strip()
        # systemctl present but systemd not running (a container, a chroot):
        # the same answer as no systemctl at all, not its two-line apology in
        # the middle of the table.
        if "not been booted with systemd" in text or "Failed to connect to bus" in text:
            return "no systemd"
        return (text.splitlines() or ["unknown"])[0]
    return ask("is-active"), ask("is-enabled")


def cmd_status(args: Any) -> int:
    """What is running, and where to look next. Read-only."""
    o = _opts(args)
    print("== commandant hub ==")
    worst = 0
    for unit in SERVICES:
        active, enabled = _unit_state(unit)
        flag = "" if active == "active" else "   <-- not running"
        print(f"   {unit:18s} {active:10s} ({enabled}){flag}")
        if active not in ("active", "no systemd"):
            worst = 1
    # NetworkManager runs the AP's DHCP itself; hostapd and dnsmasq are only
    # this hub's if dhcpcd owns its networking.
    ap_units = (("NetworkManager",) if _network_backend() == NETWORKMANAGER
                else ("hostapd", "dnsmasq"))
    for unit in (*ap_units, "avahi-daemon"):
        active, _ = _unit_state(unit)
        print(f"   {unit:18s} {active}")
        if active not in ("active", "no systemd"):
            worst = 1

    # The address the operator actually types, and whether the AP has it.
    iface = o["iface"]
    addrs = _iface_addresses(iface)
    if not iface:
        print("\n   no WiFi interface found")
    else:
        print(f"\n   {iface:7s} {', '.join(addrs) or 'no address — the AP is not up'}")
    print(f"   expect  {o['ap_ip']}/24, and http://{o['hostname']}.local/")

    # gs knows things systemd cannot: which transport it found, what budget it
    # derived, whether it has been quietly reopening the link. Pointed at rather
    # than duplicated -- one source for that answer, not two that can disagree.
    print(f"\n   the daemon's own view:  "
          f"{o['repo']}/packages/gs/.venv/bin/python -m gs --status")
    print("   recent logs:            commandant logs")
    return worst


def cmd_up(args: Any) -> int:
    """Start the hub's services (the AP and mDNS are left to systemd at boot)."""
    _sudo(["systemctl", "start", *SERVICES])
    return cmd_status(args)


def cmd_down(args: Any) -> int:
    """Stop the services. Deliberately leaves the AP up, so a hub you are
    standing next to does not drop its WiFi out from under your laptop."""
    _sudo(["systemctl", "stop", *SERVICES])
    return cmd_status(args)


def cmd_logs(args: Any) -> int:
    """Follow both services' journals together, which is the only view where a
    console error and the daemon's reaction to it appear in order."""
    cmd = ["journalctl", "-u", SERVICES[0], "-u", SERVICES[1], "-n", str(args.lines)]
    if args.follow:
        cmd.append("-f")
    return _sudo(cmd, check=False)


def cmd_uninstall(args: Any) -> int:
    """Remove what install added, and nothing else.

    The repo and the service user's home are left alone: this takes the hub
    apart, it does not delete work. The AP config goes, because leaving a
    machine broadcasting an open-ish access point nobody is maintaining is worse
    than leaving a file behind."""
    if not args.yes:
        print("This stops and removes the commandant services, the WiFi access "
              "point, the mDNS record and the saved install settings.\n"
              f"The repo at {_opts(args)['repo']} is NOT touched.\n"
              "Re-run with --yes to proceed.", file=sys.stderr)
        return 2
    print("== stopping services ==")
    _sudo(["systemctl", "disable", "--now", *SERVICES], check=False)
    print("== removing the access point ==")
    # By what install left behind, not by which daemon runs right now: a hub
    # whose NetworkManager is stopped still has the connection saved, and
    # will broadcast again the next time it starts.
    if shutil.which("nmcli"):
        _sudo(["nmcli", "connection", "delete", NM_CONNECTION], check=False)
    if Path("/etc/hostapd/hostapd.conf").exists():
        _sudo(["systemctl", "disable", "--now", "hostapd", "dnsmasq"], check=False)
    print("== removing files ==")
    # Both paths' files, whichever installed them: a hub whose networking moved
    # from dhcpcd to NetworkManager in between still comes apart cleanly.
    for path in ("/etc/systemd/system/gs.service",
                 "/etc/systemd/system/console.service",
                 "/etc/avahi/services/commandant.service",
                 "/etc/dnsmasq.d/commandant.conf",
                 "/etc/hostapd/hostapd.conf",
                 "/etc/NetworkManager/dnsmasq-shared.d/commandant.conf",
                 "/etc/modprobe.d/commandant-regdom.conf",
                 SAVED, SAVED_SECRET):
        _sudo(["rm", "-f", path], check=False)
    _sudo(["systemctl", "daemon-reload"], check=False)
    print("\n== done ==")
    if _has_dhcpcd_block():
        print("The static-IP block in /etc/dhcpcd.conf is marked `# commandant-hub` "
              "and was left in place; remove it by hand if you want the interface "
              "back on DHCP.")
    return 0
