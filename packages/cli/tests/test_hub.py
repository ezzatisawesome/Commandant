"""The hub installer's logic, as far as it can be checked off the hub.

This file provisions the field deployment and has never been run on hardware,
so the parts that are pure logic are worth pinning even though the parts that
touch apt and systemd are not. Both faults below are the kind that only show up
on the real thing, and both are decided before any command is issued.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from commandant_cli import hub


def _captured(monkeypatch) -> list[list[str]]:
    """Record the argv of everything the installer would run."""
    calls: list[list[str]] = []
    monkeypatch.setattr(hub.subprocess, "run",
                        lambda cmd, **kw: calls.append(list(cmd)) or _Done())
    return calls


class _Done:
    returncode = 0
    stdout = ""
    stderr = ""


def test_as_user_runs_as_the_service_user_not_the_invoker(monkeypatch):
    """The documented flow is `commandant install` as `pi`, with sudo. The
    condition used to be `cmd if os.geteuid() != 0`, the opposite of `_sudo`'s,
    so the build steps ran as the INVOKER -- immediately after
    `chown -R commandant:commandant` had handed the repo to the service user.
    `python -m venv` then wrote into a tree it no longer owned and the install
    died at the build step, every time, on a real Pi."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub, "_current_user", lambda: "pi")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 1000)
    hub._as_user("commandant", ["python3", "-m", "venv", "/opt/commandant/x"])
    assert calls[0][:4] == ["sudo", "-u", "commandant", "-H"]
    assert calls[0][4:] == ["python3", "-m", "venv", "/opt/commandant/x"]


def test_as_user_drops_to_the_service_user_when_invoked_as_root(monkeypatch):
    """Root must still drop to the service user: a venv and an npm tree owned by
    root are not usable by the units that run as `commandant`. And it must not
    need sudo to do it -- a Debian server installed with a root password has
    none, and this is the install's last step."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub, "_current_user", lambda: "root")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    import pwd
    monkeypatch.setattr(pwd, "getpwnam",
                        lambda u: type("P", (), {"pw_dir": f"/home/{u}"})())
    hub._as_user("commandant", ["npm", "install"])
    assert calls[0] == ["runuser", "-u", "commandant", "--", "env",
                        "HOME=/home/commandant", "npm", "install"]


def test_as_user_does_not_elevate_when_it_is_already_that_user(monkeypatch):
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub, "_current_user", lambda: "commandant")
    hub._as_user("commandant", ["npm", "install"])
    assert calls[0] == ["npm", "install"], "re-entered sudo to become itself"


def test_as_user_sets_home_for_npm(monkeypatch):
    """`sudo -u` alone keeps the INVOKER's HOME, so an npm build would populate
    pi's or root's cache -- or fail outright for a service account whose shell
    is nologin. `-H` is what makes the build land in the service user's home."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub, "_current_user", lambda: "pi")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 1000)
    hub._as_user("commandant", ["npm", "run", "build"])
    assert "-H" in calls[0]


def test_sudo_prefixes_only_when_not_root(monkeypatch):
    """The helper _as_user was supposed to mirror: pinned so the two cannot
    drift apart again."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 1000)
    hub._sudo(["systemctl", "daemon-reload"])
    assert calls[-1] == ["sudo", "systemctl", "daemon-reload"]
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    hub._sudo(["systemctl", "daemon-reload"])
    assert calls[-1] == ["systemctl", "daemon-reload"]


def test_render_substitutes_every_default_it_claims_to(monkeypatch):
    """`_render` replaces template literals. A default that stops appearing in a
    template, or is renamed, silently stops being configurable -- the flag is
    accepted and ignored."""
    subs = dict(hub.DEFAULTS)
    subs.update({"ssid": "fieldnet", "passphrase": "s3cret-pass", "country": "GB",
                 "ap_ip": "10.9.8.1", "radio": "serial:/dev/ttyUSB0:115200",
                 "iface": "wlp2s0"})
    out = hub._render("hostapd.conf", subs)
    assert "ssid=fieldnet" in out
    assert "wpa_passphrase=s3cret-pass" in out
    assert "country_code=GB" in out
    assert "changeme-commandant" not in out, "the default passphrase survived"
    assert "interface=wlp2s0" in out and "wlan0" not in out

    dns = hub._render("dnsmasq.conf", subs)
    assert "10.9.8.1" in dns and "192.168.50.1" not in dns
    assert "interface=wlp2s0" in dns and "wlan0" not in dns

    nm = hub._render("nm-dnsmasq-shared.conf", subs)
    assert "10.9.8.1" in nm and "192.168.50.1" not in nm

    env = hub._render("gs.env", subs)
    assert "serial:/dev/ttyUSB0:115200" in env


# --- preflight: what the installer needs, checked directly -----------------

def _ready(monkeypatch, tmp_path, *, systemd=True, backend=hub.NETWORKMANAGER,
           addrs=(), active=()):
    """A machine that passes preflight, with one thing changed per test."""
    real_path = hub.Path
    run = tmp_path / "run-systemd"
    if systemd:
        run.mkdir(exist_ok=True)
    monkeypatch.setattr(hub, "Path",
                        lambda p, *a: run if p == "/run/systemd/system" else real_path(p, *a))
    monkeypatch.setattr(hub, "_network_backend", lambda: backend)
    monkeypatch.setattr(hub, "_iface_addresses", lambda iface: list(addrs))
    monkeypatch.setattr(hub, "_active", lambda unit: unit in active)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_wifi_ifaces", lambda: ["wlp2s0"])


def _o(**kw):
    o = dict(hub.DEFAULTS, iface="wlp2s0")
    o.update(kw)
    return o


def test_preflight_accepts_any_linux_box_not_only_a_pi(monkeypatch, tmp_path):
    """The old guard refused anything that was not Raspberry Pi OS, so an
    Ubuntu NUC with a WiFi card -- or a Pi on Ubuntu -- could not be a hub
    without --force, which also disabled every check that mattered."""
    _ready(monkeypatch, tmp_path)
    assert hub._preflight(_o(), force=False) == hub.NETWORKMANAGER
    _ready(monkeypatch, tmp_path, backend=hub.DHCPCD)
    assert hub._preflight(_o(), force=False) == hub.DHCPCD


def test_preflight_refuses_to_take_over_a_connected_interface(monkeypatch, tmp_path, capsys):
    """The guard that protects a workstation: turning its connected WiFi into
    an AP drops the connection -- and the ssh session, on a Pi set up over
    WiFi. Explicit --force is allowed."""
    _ready(monkeypatch, tmp_path, addrs=["10.0.0.23"])
    with pytest.raises(SystemExit) as e:
        hub._preflight(_o(), force=False)
    assert e.value.code == 2
    assert "10.0.0.23" in capsys.readouterr().err
    assert hub._preflight(_o(), force=True) == hub.NETWORKMANAGER


def test_preflight_lets_a_rerun_through(monkeypatch, tmp_path):
    """The interface already holding the AP's own address is the hub being
    re-installed (`commandant update`), not a connection in use."""
    _ready(monkeypatch, tmp_path, addrs=[hub.DEFAULTS["ap_ip"]])
    assert hub._preflight(_o(), force=False) == hub.NETWORKMANAGER


def test_preflight_reports_every_problem_at_once(monkeypatch, tmp_path, capsys):
    _ready(monkeypatch, tmp_path, systemd=False, backend="")
    with pytest.raises(SystemExit) as e:
        hub._preflight(_o(iface=""), force=True)    # --force does not skip these
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "systemd" in err and "WiFi interface" in err and "NetworkManager" in err


@pytest.mark.parametrize("passphrase", ["short", "x" * 64])
def test_preflight_rejects_a_passphrase_wpa2_will_not_take(monkeypatch, tmp_path, capsys,
                                                             passphrase):
    """nmcli would fail halfway through the install; hostapd would fail at boot
    with nothing on screen."""
    _ready(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        hub._preflight(_o(passphrase=passphrase), force=False)
    assert "8-63 characters" in capsys.readouterr().err


@pytest.mark.parametrize("unit", ["hostapd", "dnsmasq"])
def test_preflight_names_a_daemon_that_would_break_the_nm_access_point(
        monkeypatch, tmp_path, capsys, unit):
    _ready(monkeypatch, tmp_path, active=(unit,))
    with pytest.raises(SystemExit):
        hub._preflight(_o(), force=True)
    assert f"systemctl disable --now {unit}" in capsys.readouterr().err
    # The dhcpcd path is the one that RUNS them.
    _ready(monkeypatch, tmp_path, backend=hub.DHCPCD, active=(unit,))
    assert hub._preflight(_o(), force=False) == hub.DHCPCD


@pytest.mark.parametrize("iface", ["eth0", "wlp2s9"])
def test_preflight_refuses_an_iface_that_is_not_wifi(monkeypatch, tmp_path, capsys, iface):
    """A typo, a wired interface or an unplugged dongle passed the old check
    (it only asked whether a name was given) and got an AP that could never
    come up."""
    _ready(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        hub._preflight(_o(iface=iface), force=True)
    assert f"{iface} is not a WiFi interface" in capsys.readouterr().err


@pytest.mark.parametrize("ap_ip", ["8.8.8.8", "192.168.50", "10.0.0.255", "nonsense"])
def test_preflight_refuses_an_unusable_ap_address(monkeypatch, tmp_path, capsys, ap_ip):
    _ready(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        hub._preflight(_o(ap_ip=ap_ip), force=True)
    assert "--ap-ip" in capsys.readouterr().err


@pytest.mark.parametrize("ap_ip, pool", [
    ("192.168.50.1", "192.168.50.10,192.168.50.100"),
    ("10.0.0.254", "10.0.0.10,10.0.0.100"),
    ("192.168.50.50", "192.168.50.110,192.168.50.200"),
])
def test_the_dhcp_pool_follows_any_ap_address(ap_ip, pool):
    """The pool used to be the AP address text-replaced inside
    "192.168.50.10": right only for addresses ending in .1. 10.0.0.254 made
    "10.0.0.2540" and dnsmasq refused the whole file, so phones got no
    address. Verified against dnsmasq --test."""
    out = hub._render("dnsmasq.conf", dict(hub.DEFAULTS, ap_ip=ap_ip, iface="wlan0"))
    line = next(l for l in out.splitlines() if l.startswith("dhcp-range="))
    assert line == f"dhcp-range={pool},255.255.255.0,12h"
    assert f"dhcp-option=3,{ap_ip}" in out


def test_a_python_too_old_for_gs_stops_before_the_network_changes(monkeypatch, capsys):
    """gs requires 3.11; Ubuntu 22.04 ships 3.10 and Bullseye 3.9. The venv
    build is a late step, after the AP is configured."""
    _captured(monkeypatch)
    monkeypatch.setattr(hub, "_node_version", lambda: (20, 11))
    monkeypatch.setattr(hub, "_python_version", lambda: (3, 10))
    assert hub._install_packages(hub.DHCPCD, skip=True) is False
    assert "Python >= 3.11" in capsys.readouterr().err


def test_versions_parse_what_node_and_python_actually_print(monkeypatch):
    out = {}
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    monkeypatch.setattr(hub.subprocess, "run", lambda cmd, **k: type(
        "R", (), {"stdout": out["v"], "stderr": ""})())
    out["v"] = "v20.11.1\n"
    assert hub._version("node") == (20, 11)
    out["v"] = "Python 3.10.12\n"
    assert hub._version("python3") == (3, 10)
    out["v"] = ""
    assert hub._version("node") is None


@pytest.mark.parametrize("setting, value, says", [
    ("ssid", "x" * 33, "SSID"),
    ("ssid", "", "SSID"),
    ("hostname", "my hub", "--hostname"),
    ("hostname", "hub_1", "--hostname"),
    ("hostname", "-hub", "--hostname"),
])
def test_preflight_rejects_names_the_tools_would_refuse(monkeypatch, tmp_path, capsys,
                                                         setting, value, says):
    """nmcli refuses a 33-byte SSID halfway through the install, hostapd at
    boot; hostnamectl refuses a name with a space, after the packages are in."""
    _ready(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        hub._preflight(_o(**{setting: value}), force=True)
    assert says in capsys.readouterr().err


def test_preflight_accepts_ordinary_names(monkeypatch, tmp_path):
    _ready(monkeypatch, tmp_path)
    assert hub._preflight(_o(ssid="Field Net 2", hostname="hub-2"), force=False)


def test_wifi_interface_is_detected_whatever_it_is_named(monkeypatch, tmp_path):
    """wlan0 on a Pi; wlp2s0 and the like on most other machines. Detection
    keys on the nl80211 radio, not the name."""
    net = tmp_path / "net"
    for name, wifi in (("eth0", False), ("wlp2s0", True), ("lo", False)):
        (net / name).mkdir(parents=True)
        if wifi:
            (net / name / "phy80211").mkdir()
    real_path = hub.Path
    monkeypatch.setattr(hub, "Path",
                        lambda p, *a: net if p == "/sys/class/net" else real_path(p, *a))
    assert hub._wifi_ifaces() == ["wlp2s0"]


def test_an_explicit_iface_wins_over_detection(monkeypatch):
    monkeypatch.setattr(hub, "_wifi_ifaces", lambda: ["wlan0"])
    assert hub._opts(type("A", (), {"iface": "wlx00c0ca"})())["iface"] == "wlx00c0ca"
    assert hub._opts(type("A", (), {})())["iface"] == "wlan0"


def test_network_backend_prefers_a_running_networkmanager(monkeypatch):
    """Pi OS Bookworm still ships dhcpcd's config but NetworkManager owns the
    network; writing a dhcpcd static IP there does nothing."""
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    monkeypatch.setattr(hub, "_active", lambda unit: True)
    assert hub._network_backend() == hub.NETWORKMANAGER


def test_an_installed_but_idle_dhcpcd_is_not_a_backend(monkeypatch):
    """Ubuntu 24.04 ships the dhcpcd binary (dhcpcd-base) as a DHCP client under
    networkd, with no dhcpcd service. Taking it for the backend would write a
    static IP nobody reads, and the AP would come up with no address."""
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    monkeypatch.setattr(hub, "_active", lambda unit: False)
    assert hub._network_backend() == ""
    monkeypatch.setattr(hub, "_active", lambda unit: unit == "dhcpcd")
    assert hub._network_backend() == hub.DHCPCD


def test_with_two_wifi_interfaces_the_uplink_is_not_taken(monkeypatch):
    """The documented way to keep a hub online is a second WiFi interface. By
    name alone the connected uplink (wlan0) would be picked, and preflight
    would refuse -- or, forced, cut the uplink."""
    addrs = {"wlan0": ["10.0.0.23"], "wlan1": []}
    monkeypatch.setattr(hub, "_iface_addresses", lambda i: addrs[i])
    assert hub._pick_iface(["wlan0", "wlan1"], "192.168.50.1") == "wlan1"
    # Once installed, `status` must find the AP, not the other free one.
    addrs = {"wlan0": ["10.0.0.23"], "wlan1": [], "wlan2": ["192.168.50.1"]}
    assert hub._pick_iface(["wlan0", "wlan1", "wlan2"], "192.168.50.1") == "wlan2"
    assert hub._pick_iface([], "192.168.50.1") == ""


# --- building the access point ----------------------------------------------

def test_networkmanager_ap_is_a_shared_wpa2_access_point(monkeypatch, capsys):
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_install_text", lambda *a: None)
    monkeypatch.setattr(hub.shutil, "which", lambda b: None)
    monkeypatch.setattr(hub, "_nm_has_connection", lambda: False)
    hub._ap_networkmanager(_o(passphrase="s3cret-pass", country="GB"))
    add = next(c for c in calls if c[:3] == ["nmcli", "connection", "add"])
    assert add[3:7] == ["type", "wifi", "con-name", hub.NM_CONNECTION]
    kv = dict(zip(add[7::2], add[8::2]))
    assert kv["connection.interface-name"] == "wlp2s0"
    assert kv["802-11-wireless.mode"] == "ap"
    assert int(kv["connection.autoconnect-priority"]) > 0, \
        "a saved client network on the same interface could win at boot"
    assert kv["ipv4.method"] == "shared", "nobody would hand clients an address"
    assert kv["ipv4.addresses"] == f"{hub.DEFAULTS['ap_ip']}/24"
    assert kv["wifi-sec.key-mgmt"] == "wpa-psk" and kv["wifi-sec.psk"] == "s3cret-pass"
    assert "s3cret-pass" not in capsys.readouterr().out, "echoed the WiFi passphrase"


def test_a_rerun_never_takes_the_live_access_point_down(monkeypatch):
    """`commandant update` is run in the field over the hub's own WiFi. Deleting
    the connection to re-add it drops that network on the spot -- and with it
    the session running the update, mid-install. A modify saves the settings
    for the next boot and leaves the live AP alone."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_install_text", lambda *a: None)
    monkeypatch.setattr(hub, "_install_file", lambda *a: None)
    monkeypatch.setattr(hub.shutil, "which", lambda b: None)
    monkeypatch.setattr(hub, "_nm_has_connection", lambda: True)
    hub._ap_networkmanager(_o(passphrase="s3cret-pass"))
    nm = [c for c in calls if c[0] == "nmcli" and c[1] == "connection"]
    assert not any(c[2] in ("delete", "down", "up") for c in nm), nm
    mod = next(c for c in nm if c[2] == "modify")
    kv = dict(zip(mod[4::2], mod[5::2]))
    assert mod[3] == hub.NM_CONNECTION
    assert kv["802-11-wireless.mode"] == "ap" and kv["wifi-sec.psk"] == "s3cret-pass"


def test_networkmanager_ap_still_applies_the_country(monkeypatch):
    """--country is hostapd's country_code on the other path. NetworkManager
    has no such setting, and a flag that is accepted and ignored is the
    failure `test_render_substitutes_every_default_it_claims_to` guards
    against."""
    written = {}
    monkeypatch.setattr(hub, "_install_text", lambda text, dest, mode: written.update({dest: text}))
    monkeypatch.setattr(hub, "_install_file", lambda *a: None)
    _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: None)
    monkeypatch.setattr(hub, "_nm_has_connection", lambda: False)
    hub._ap_networkmanager(_o(country="GB"), set_country=True)
    assert "ieee80211_regdom=GB" in written["/etc/modprobe.d/commandant-regdom.conf"]


def test_the_placeholder_country_does_not_override_a_configured_one(monkeypatch):
    """`US` is a default, not a choice. A Pi that raspi-config set to GB keeps
    GB unless --country says otherwise; one with no country gets the default."""
    written = {}
    monkeypatch.setattr(hub, "_install_text", lambda text, dest, mode: written.update({dest: text}))
    monkeypatch.setattr(hub, "_install_file", lambda *a: None)
    _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: None)
    monkeypatch.setattr(hub, "_nm_has_connection", lambda: False)
    monkeypatch.setattr(hub, "_system_regdom", lambda: "GB")
    hub._ap_networkmanager(_o(), set_country=False)
    assert "/etc/modprobe.d/commandant-regdom.conf" not in written
    monkeypatch.setattr(hub, "_system_regdom", lambda: "")
    hub._ap_networkmanager(_o(), set_country=False)
    assert "ieee80211_regdom=US" in written["/etc/modprobe.d/commandant-regdom.conf"]


def test_system_regdom_treats_the_world_domain_as_unset(monkeypatch):
    monkeypatch.setattr(hub.shutil, "which", lambda b: "/usr/sbin/iw")
    out = {"v": "global\ncountry 00: DFS-UNSET\n\t(2402 - 2472 @ 40), (6, 20)\n"}
    monkeypatch.setattr(hub.subprocess, "run",
                        lambda *a, **k: type("R", (), {"stdout": out["v"]})())
    assert hub._system_regdom() == ""
    out["v"] = "global\ncountry GB: DFS-ETSI\n"
    assert hub._system_regdom() == "GB"


def test_packages_off_apt_say_what_is_needed_instead_of_guessing(monkeypatch, capsys):
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: None)
    monkeypatch.setattr(hub, "_node_version", lambda: (20, 11))
    monkeypatch.setattr(hub, "_python_version", lambda: (3, 11))
    assert hub._install_packages(hub.NETWORKMANAGER, skip=False) is False
    err = capsys.readouterr().err
    assert "--skip-packages" in err and "avahi-daemon" in err
    assert calls == []
    assert hub._install_packages(hub.NETWORKMANAGER, skip=True) is True


def test_a_node_too_old_for_the_console_stops_before_the_network_changes(monkeypatch, capsys):
    """Debian Bullseye -- the dhcpcd-era Pi OS -- and Ubuntu 22.04 ship Node
    12 from apt. Next 15 needs 18.18, and the build is the install's last step,
    so without this the failure arrives after the WiFi is already an AP."""
    _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_node_version", lambda: (12, 22))
    assert hub._install_packages(hub.DHCPCD, skip=False) is False
    assert "Node >= 18.18" in capsys.readouterr().err
    monkeypatch.setattr(hub, "_node_version", lambda: None)
    assert hub._install_packages(hub.DHCPCD, skip=True) is False


def test_a_new_enough_node_is_not_reinstalled_from_apt(monkeypatch):
    """NodeSource's nodejs plus apt's `npm` is a dependency conflict that fails
    the whole apt-get install -- and NodeSource is how an old distro gets a
    Node the console can build with."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_node_version", lambda: (20, 11))
    monkeypatch.setattr(hub, "_python_version", lambda: (3, 11))
    assert hub._install_packages(hub.DHCPCD, skip=False) is True
    install = next(c for c in calls if "install" in c)
    assert "nodejs" not in install and "npm" not in install
    assert "avahi-daemon" in install


def test_apt_never_stops_to_ask(monkeypatch):
    """-y does not answer debconf or conffile prompts; an `update` that pulls a
    newer hostapd over the edited /etc/default/hostapd would wait forever."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 1000)
    monkeypatch.setattr(hub, "_node_version", lambda: (20, 11))
    monkeypatch.setattr(hub, "_python_version", lambda: (3, 11))
    hub._install_packages(hub.DHCPCD, skip=False)
    for c in (c for c in calls if "apt-get" in c):
        assert c[:3] == ["sudo", "env", "DEBIAN_FRONTEND=noninteractive"], \
            "sudo would drop it from the environment"
    install = next(c for c in calls if "install" in c)
    assert "Dpkg::Options::=--force-confold" in install
    assert "--no-install-recommends" in install, "a compiler and X11 onto the SD card"


def test_networkmanager_path_never_installs_the_dnsmasq_service(monkeypatch):
    """The full `dnsmasq` package starts a system instance that holds port 53,
    and NetworkManager's own dnsmasq -- the one serving the AP's DHCP -- then
    cannot start."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.shutil, "which", lambda b: "/usr/bin/apt-get")
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_node_version", lambda: (12, 22))
    hub._install_packages(hub.NETWORKMANAGER, skip=False)
    install = next(c for c in calls if "install" in c)
    assert "dnsmasq" not in install and "hostapd" not in install
    assert "dnsmasq-base" in install


def test_templates_referenced_by_install_all_exist():
    """A missing template is a mid-install crash on a Pi, after apt and the
    networking changes have already happened."""
    for rel in ("hostapd.conf", "dnsmasq.conf", "nm-dnsmasq-shared.conf", "gs.env",
                "avahi/commandant.service",
                "systemd/gs.service", "systemd/console.service"):
        assert (Path(hub.TEMPLATES) / rel).exists(), f"missing template: {rel}"


# --- the units, as text: what a field hub does when something goes wrong ----

def _unit(rel: str) -> str:
    return (Path(hub.TEMPLATES) / "systemd" / rel).read_text()


@pytest.mark.parametrize("rel", ["gs.service", "console.service"])
def test_restart_always_actually_means_always(rel):
    """`Restart=always` does not, on its own. systemd's default start limit is
    5 starts per 10 s and both units use RestartSec=2, which hits exactly that:
    a service that crash-loops for ten seconds at boot enters `failed` and
    STAYS there until somebody ssh's in.

    On a hub whose premise is "turn the plane on, turn the hub on, open the
    page", the likeliest cause of such a loop is transient — the radio
    enumerating a moment late, a stale instance still holding the port — and
    permanently failing on it is the worst answer available."""
    u = _unit(rel)
    assert "Restart=always" in u
    assert "StartLimitIntervalSec=0" in u, "the default start limit still applies"
    # It has to be in [Unit]; systemd ignores it under [Service].
    unit_section = u.split("[Service]")[0]
    assert "StartLimitIntervalSec=0" in unit_section


def test_gs_unit_names_no_device_and_keeps_dialout():
    """The radio's device name depends on the machine -- /dev/serial0 exists
    only on a Pi -- and gs re-probes until it appears, so the unit orders on
    none. Reading it needs the dialout group."""
    u = _unit("gs.service")
    assert "serial0" not in u
    assert "Group=dialout" in u
    assert "User=commandant" in u, "the daemon must not run as root"


def test_console_unit_binds_80_without_running_as_root():
    u = _unit("console.service")
    assert "User=commandant" in u
    assert "AmbientCapabilities=CAP_NET_BIND_SERVICE" in u
    assert "-p 80" in u


def test_gs_env_ships_an_endpoint_so_the_unit_never_gets_an_empty_flag():
    """gs.service passes --mavlink ${GS_MAVLINK} unquoted, so an unset value
    would hand argparse an empty argument."""
    env = (Path(hub.TEMPLATES) / "gs.env").read_text()
    line = next(l for l in env.splitlines() if l.startswith("GS_MAVLINK="))
    assert line.split("=", 1)[1].strip(), "GS_MAVLINK ships empty"
    assert next(l for l in env.splitlines() if l.startswith("GS_WS_PORT=")).split("=")[1].strip()


def test_the_radio_defaults_to_autodetect():
    """A fixed default names a device that exists on one kind of machine."""
    env = hub._render("gs.env", dict(hub.DEFAULTS))
    assert "GS_MAVLINK=auto" in env
    env = hub._render("gs.env", dict(hub.DEFAULTS, radio="serial:/dev/ttyUSB0:57600"))
    assert "GS_MAVLINK=serial:/dev/ttyUSB0:57600" in env


def test_the_flight_log_has_somewhere_to_go_without_a_provisioning_step():
    """gs.service passes --log-dir ${GS_LOG_DIR} the same unquoted way, so the
    same hazard applies: an unset value hands argparse a bare flag and the
    daemon will not start. And the directory has to EXIST, owned by the service
    user -- StateDirectory makes systemd create it, which is one less step for
    somebody to forget at 6am on a flight line."""
    env = (Path(hub.TEMPLATES) / "gs.env").read_text()
    line = next(l for l in env.splitlines() if l.startswith("GS_LOG_DIR="))
    log_dir = line.split("=", 1)[1].strip()
    assert log_dir, "GS_LOG_DIR ships empty"

    unit = (Path(hub.TEMPLATES) / "systemd" / "gs.service").read_text()
    assert "--log-dir ${GS_LOG_DIR}" in unit, "the unit never passes it"
    assert "StateDirectory=commandant" in unit, "nothing creates the directory"
    assert log_dir.startswith("/var/lib/commandant"), \
        f"{log_dir} is not what StateDirectory creates"


# --- the rest of the lifecycle, which the package promised and did not have --

def test_every_verb_the_package_description_claims_actually_exists():
    """pyproject's description and the roadmap both listed
    install/update/status/up/down/logs/uninstall. Only the first two existed, so
    `commandant status` — the thing you type in a field when the page does not
    load — was an argparse error."""
    import tomllib
    from commandant_cli import main as cli_main

    described = tomllib.load(open(Path(__file__).parent.parent / "pyproject.toml", "rb"))
    claimed = [w.strip() for w in
               described["project"]["description"].split("(")[1].rstrip(")").split("/")]
    assert len(claimed) == 7, claimed
    for verb in claimed:
        with pytest.raises(SystemExit) as e:
            cli_main.main([verb, "--help"])
        assert e.value.code == 0, f"`commandant {verb}` is not a command"


def test_uninstall_refuses_without_an_explicit_yes(capsys):
    from commandant_cli import main as cli_main
    rc = cli_main.main(["uninstall"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "--yes" in err
    assert "NOT touched" in err, "say what it will not delete"


def test_uninstall_leaves_the_repo_alone(monkeypatch):
    """It takes the hub apart; it does not delete work."""
    calls = _captured(monkeypatch)
    from commandant_cli import main as cli_main
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub.shutil, "which", lambda b: f"/usr/bin/{b}")
    cli_main.main(["uninstall", "--yes"])
    flat = " ".join(" ".join(c) for c in calls)
    assert "/opt/commandant" not in flat, "touched the repo"
    assert "gs.service" in flat and "hostapd.conf" in flat
    assert f"connection delete {hub.NM_CONNECTION}" in flat, "left the AP broadcasting"


def test_status_reports_nonzero_when_something_is_not_running(monkeypatch):
    """So it can be used as a check, not only read."""
    monkeypatch.setattr(hub, "_unit_state", lambda u: ("inactive", "enabled"))
    monkeypatch.setattr(hub.subprocess, "run",
                        lambda *a, **k: type("R", (), {"stdout": "", "stderr": "",
                                                       "returncode": 0})())
    from commandant_cli import main as cli_main
    assert cli_main.main(["status"]) == 1
    monkeypatch.setattr(hub, "_unit_state", lambda u: ("active", "enabled"))
    assert cli_main.main(["status"]) == 0


def test_down_leaves_the_access_point_up(monkeypatch):
    """Stopping the services must not drop the WiFi out from under the laptop
    of whoever is standing next to the hub."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub, "_unit_state", lambda u: ("active", "enabled"))
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    from commandant_cli import main as cli_main
    cli_main.main(["down"])
    stops = [c for c in calls if "stop" in c]
    flat = " ".join(" ".join(c) for c in stops)
    assert "gs.service" in flat
    assert "hostapd" not in flat, "stopped the access point"


def test_logs_follows_both_units_together(monkeypatch):
    """A console error and the daemon's reaction to it only appear in order in
    one view."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    from commandant_cli import main as cli_main
    cli_main.main(["logs", "-f", "-n", "50"])
    c = calls[-1]
    assert c[0] == "journalctl"
    assert c.count("-u") == 2
    assert "-f" in c and "50" in c


# --- update must not undo install -------------------------------------------

def _install_run(monkeypatch, tmp_path, *, saved=None, argv=(), gs_env=None):
    """Run cmd_install end to end with every side effect stubbed; return what
    it wrote and how it built the AP."""
    from commandant_cli import main as cli_main
    repo = tmp_path / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    written: dict[str, tuple[str, str]] = {}
    ap: dict = {}
    _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_saved", lambda elevate=False: dict(saved or {}))
    monkeypatch.setattr(hub, "_preflight", lambda o, force: hub.NETWORKMANAGER)
    monkeypatch.setattr(hub, "_install_packages", lambda b, skip: True)
    monkeypatch.setattr(hub, "_as_user", lambda *a, **k: None)
    monkeypatch.setattr(hub, "_ensure_home", lambda user: None)
    monkeypatch.setattr(hub, "_install_text",
                        lambda text, dest, mode: written.update({dest: (text, mode)}))
    monkeypatch.setattr(hub, "_ap_networkmanager",
                        lambda o, set_country=True: ap.update(o=o, set_country=set_country))
    env = tmp_path / "gs.env"
    if gs_env is not None:
        env.write_text(gs_env)
    monkeypatch.setattr(hub, "GS_ENV", str(env))
    rc = cli_main.main(["install", "--repo", str(repo), *argv])
    assert rc == 0
    return written, ap


def test_update_keeps_the_passphrase_install_was_given(monkeypatch, tmp_path):
    """`update` re-runs install with no flags. Without a record of what install
    was told, that reset the WiFi passphrase to the published placeholder --
    on the network that commands the aircraft."""
    written, _ = _install_run(monkeypatch, tmp_path,
                              argv=["--passphrase", "s3cret-pass", "--ssid", "fieldnet"])
    text, mode = written[hub.SAVED]
    assert mode == "0644", "status, run without sudo, must be able to read it"
    saved = json.loads(text)
    assert "passphrase" not in saved, "the WiFi passphrase in a world-readable file"
    assert saved["ssid"] == "fieldnet"
    psk, mode = written[hub.SAVED_SECRET]
    assert mode == "0600" and psk.strip() == "s3cret-pass"
    saved["passphrase"] = psk.strip()       # what _saved() layers back in

    _, ap = _install_run(monkeypatch, tmp_path, saved=saved)      # `update`
    assert ap["o"]["passphrase"] == "s3cret-pass"
    assert ap["o"]["ssid"] == "fieldnet"


def test_only_explicit_settings_are_remembered(monkeypatch, tmp_path):
    """A saved default would read as a choice next time: a remembered "US"
    would then override the country raspi-config set."""
    written, ap = _install_run(monkeypatch, tmp_path, argv=["--passphrase", "s3cret-pass"])
    saved = json.loads(written[hub.SAVED][0])
    assert "country" not in saved and "ap_ip" not in saved
    assert ap["set_country"] is False
    _, ap = _install_run(monkeypatch, tmp_path, saved={"country": "GB"})
    assert ap["set_country"] is True and ap["o"]["country"] == "GB"


def test_update_leaves_hand_edits_to_gs_env_alone(monkeypatch, tmp_path):
    """The relay token and GS_EVENTS_META are set by editing gs.env, as the file
    says to. Re-rendering it on every update wiped them."""
    edited = ("GS_MAVLINK=serial:/dev/ttyUSB0:57600\nGS_WS_PORT=8790\n"
              "COMMANDANT_RELAY_TOKEN=abc123\n")
    written, _ = _install_run(monkeypatch, tmp_path, gs_env=edited)
    assert str(tmp_path / "gs.env") not in written


def test_radio_flag_changes_only_its_own_line(monkeypatch, tmp_path):
    edited = "GS_MAVLINK=auto\nGS_WS_PORT=8790\nCOMMANDANT_RELAY_TOKEN=abc123\n"
    written, _ = _install_run(monkeypatch, tmp_path, gs_env=edited,
                              argv=["--radio", "serial:/dev/ttyUSB0:57600"])
    text, mode = written[str(tmp_path / "gs.env")]
    assert "GS_MAVLINK=serial:/dev/ttyUSB0:57600" in text
    assert "COMMANDANT_RELAY_TOKEN=abc123" in text
    assert mode == "0600"


def test_a_first_install_renders_gs_env(monkeypatch, tmp_path):
    written, _ = _install_run(monkeypatch, tmp_path)
    assert "GS_MAVLINK=auto" in written[str(tmp_path / "gs.env")][0]


def test_a_first_install_turns_on_the_command_token(monkeypatch, tmp_path, capsys):
    """The roadmap called command authority token-gated, but no install ever set
    a token: on a real hub anyone on the WiFi could arm the aircraft, and gs
    said so at every start. The first write generates one and shows it once."""
    written, _ = _install_run(monkeypatch, tmp_path)
    text, mode = written[str(tmp_path / "gs.env")]
    assert mode == "0600", "the command token in a world-readable file"
    token = hub._env_value(text, "GS_COMMAND_TOKEN")
    assert len(token) >= 16, "no token, or a guessable one"
    assert token in capsys.readouterr().out, "generated and never shown"
    written2, _ = _install_run(monkeypatch, tmp_path / "again")
    assert hub._env_value(written2[str(tmp_path / "again" / "gs.env")][0],
                          "GS_COMMAND_TOKEN") != token, "the same token on every hub"


def test_update_keeps_the_token(monkeypatch, tmp_path, capsys):
    """An update must not rotate the token out from under operators who know
    it."""
    edited = "GS_MAVLINK=auto\nGS_COMMAND_TOKEN=keepme-0123456789\n"
    written, _ = _install_run(monkeypatch, tmp_path, gs_env=edited)
    assert str(tmp_path / "gs.env") not in written
    out = capsys.readouterr().out
    assert "COMMAND TOKEN:" not in out and "No GS_COMMAND_TOKEN" not in out


def test_an_existing_gs_env_without_a_token_is_called_out(monkeypatch, tmp_path, capsys):
    """Hand-edited files are left alone, so an old one stays tokenless -- but
    not silently."""
    _install_run(monkeypatch, tmp_path, gs_env="GS_MAVLINK=auto\nGS_COMMAND_TOKEN=\n")
    assert "No GS_COMMAND_TOKEN" in capsys.readouterr().out


def test_env_value_ignores_comments_and_blanks():
    text = "#GS_COMMAND_TOKEN=commented\nGS_WS_PORT=8790\nGS_COMMAND_TOKEN= abc \n"
    assert hub._env_value(text, "GS_COMMAND_TOKEN") == "abc"
    assert hub._env_value("#GS_COMMAND_TOKEN=x\n", "GS_COMMAND_TOKEN") == ""


def test_saved_settings_layer_under_flags(monkeypatch):
    monkeypatch.setattr(hub, "_wifi_ifaces", lambda: [])
    args = type("A", (), {"ssid": "flagnet"})()
    o = hub._opts(args, {"ssid": "savednet", "passphrase": "s3cret-pass"})
    assert o["ssid"] == "flagnet" and o["passphrase"] == "s3cret-pass"
    assert o["country"] == hub.DEFAULTS["country"]


def test_saved_ignores_junk(monkeypatch, tmp_path):
    f = tmp_path / "hub.json"
    monkeypatch.setattr(hub, "SAVED", str(f))
    monkeypatch.setattr(hub, "SAVED_SECRET", str(tmp_path / "hub.psk"))
    assert hub._saved() == {}
    f.write_text("not json")
    assert hub._saved() == {}
    f.write_text("[1, 2]")
    assert hub._saved() == {}
    f.write_text(json.dumps({"ssid": "x", "radio": "auto", "evil": "1", "user": 5}))
    assert hub._saved() == {"ssid": "x"}


def test_status_sees_saved_settings_without_the_passphrase(monkeypatch, tmp_path):
    """`status` runs without sudo and must show the configured AP address; the
    passphrase file it cannot read is simply absent from what it gets."""
    (tmp_path / "hub.json").write_text(json.dumps({"ap_ip": "10.9.8.1"}))
    psk = tmp_path / "hub.psk"
    psk.write_text("s3cret-pass\n")
    psk.chmod(0)
    monkeypatch.setattr(hub, "SAVED", str(tmp_path / "hub.json"))
    monkeypatch.setattr(hub, "SAVED_SECRET", str(psk))
    import os as _os
    if _os.geteuid() == 0:
        pytest.skip("root reads a mode-0 file")
    assert hub._saved() == {"ap_ip": "10.9.8.1"}
    psk.chmod(0o600)
    assert hub._saved()["passphrase"] == "s3cret-pass"


def test_repo_user_and_hostname_reach_every_file_that_names_them():
    """All three were accepted and ignored: `--repo /srv/commandant` built
    there while the units ran /opt/commandant, and `--user` left them running
    as `commandant`, a user install never created."""
    subs = dict(hub.DEFAULTS, repo="/srv/cmdt/", user="hub", hostname="fieldhub", iface="wlan0")
    for unit in ("gs.service", "console.service"):
        out = hub._render(f"systemd/{unit}", subs)
        assert "/opt/commandant" not in out, unit
        assert "/srv/cmdt/packages/" in out, unit
        assert "User=hub" in out and "User=commandant" not in out, unit
    assert "Group=hub" in hub._render("systemd/console.service", subs)
    assert "Group=dialout" in hub._render("systemd/gs.service", subs), "serial access"
    for conf in ("dnsmasq.conf", "nm-dnsmasq-shared.conf"):
        out = hub._render(conf, subs)
        assert "address=/fieldhub/" in out and "address=/fieldhub.local/" in out
        assert "address=/commandant" not in out


def test_a_service_user_without_a_home_gets_one(monkeypatch, tmp_path):
    """Caught by a real install in a container: the user existed with no home,
    useradd was skipped, and npm died with EACCES at the build -- after the
    network had been reconfigured."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    import pwd
    home = tmp_path / "home" / "commandant"
    monkeypatch.setattr(pwd, "getpwnam", lambda u: type("P", (), {"pw_dir": str(home)})())
    hub._ensure_home("commandant")
    assert calls[-1] == ["install", "-d", "-m", "0750", "-o", "commandant",
                         "-g", "commandant", str(home)]
    home.mkdir(parents=True)
    n = len(calls)
    hub._ensure_home("commandant")
    assert len(calls) == n, "touched a home that was already there"


def test_a_venv_whose_python_does_not_run_is_rebuilt(monkeypatch, tmp_path):
    """Caught by a real install: `python3 -m venv` over an existing venv left a
    broken bin/python broken, and gs.service failed at boot with Exec format
    error. A distro upgrade or a run cut short leaves the same thing.

    The first health check, exit 0 from `-c pass`, was fooled in the same real
    run: env's execvp runs an unexec-able file through sh, and an empty file
    exits 0. Only Python answers 42."""
    from commandant_cli import main as cli_main
    repo = tmp_path / "repo"
    (repo / "packages/gs/.venv/bin").mkdir(parents=True)
    (repo / "packages/gs/.venv/bin/python").write_text("")
    runs: list[list[str]] = []
    health = {"rc": 0}      # what an EMPTY bin/python returns, via sh

    def as_user(user, cmd, cwd=None, check=True):
        runs.append(cmd)
        return health["rc"] if cmd[-2:] == ["-c", "raise SystemExit(42)"] else 0
    _captured(monkeypatch)
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_saved", lambda elevate=False: {})
    monkeypatch.setattr(hub, "_preflight", lambda o, force: hub.NETWORKMANAGER)
    monkeypatch.setattr(hub, "_install_packages", lambda b, skip: True)
    monkeypatch.setattr(hub, "_ensure_home", lambda user: None)
    monkeypatch.setattr(hub, "_install_text", lambda *a: None)
    monkeypatch.setattr(hub, "_install_gs_env", lambda *a, **k: None)
    monkeypatch.setattr(hub, "_ap_networkmanager", lambda *a, **k: None)
    monkeypatch.setattr(hub, "_as_user", as_user)
    assert cli_main.main(["install", "--repo", str(repo)]) == 0
    venv = next(c for c in runs if c[:3] == ["python3", "-m", "venv"])
    assert "--clear" in venv, "kept the broken interpreter"

    runs.clear()
    health["rc"] = 42
    assert cli_main.main(["install", "--repo", str(repo)]) == 0
    venv = next(c for c in runs if c[:3] == ["python3", "-m", "venv"])
    assert "--clear" not in venv, "rebuilt a healthy venv on every update"


def test_as_user_can_report_failure_instead_of_raising(monkeypatch):
    monkeypatch.setattr(hub, "_current_user", lambda: "commandant")
    monkeypatch.setattr(hub.subprocess, "run",
                        lambda *a, **k: type("R", (), {"returncode": 3})())
    assert hub._as_user("commandant", ["false"], check=False) == 3

    def boom(*a, **k):
        raise OSError(8, "Exec format error")
    monkeypatch.setattr(hub.subprocess, "run", boom)
    assert hub._as_user("commandant", ["/broken/python"], check=False) == 126
    with pytest.raises(OSError):
        hub._as_user("commandant", ["/broken/python"])


def test_gs_logs_reach_the_journal_as_they_happen():
    """Block-buffered stdout under systemd kept gs's lines out of the journal
    -- and out of `commandant logs` -- until kilobytes had piled up."""
    assert "Environment=PYTHONUNBUFFERED=1" in _unit("gs.service")
