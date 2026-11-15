"""Installer faults found 2026-11-11, each failing on the code before the fix."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

from commandant_cli import hub
from commandant_cli import main as cli_main

GS = Path(__file__).resolve().parents[2] / "gs"


# --- what a fresh hub installs ---------------------------------------------

def _locked() -> dict[str, str]:
    lock = tomllib.loads((GS / "uv.lock").read_text())
    return {p["name"]: p["version"] for p in lock["package"] if p["name"] != "gs"
            and "source" in p and "editable" not in p["source"]}


def _constraints() -> dict[str, str]:
    out = {}
    for line in (GS / "constraints.txt").read_text().splitlines():
        m = re.fullmatch(r"([A-Za-z0-9_.-]+)==(\S+)", line.strip())
        if m:
            out[m[1].lower()] = m[2]
    return out


def test_gs_constraints_are_the_lockfile():
    """MEASURED: an unpinned `pip install -e packages/gs` took websockets 17.4
    while the suites ran 17.2. The constraints are what pins a hub to the
    tested set, so they must say what uv.lock says."""
    runtime = {"pymavlink", "pyserial", "websockets"}
    c = _constraints()
    assert runtime <= set(c), f"constraints miss {runtime - set(c)}"
    locked = _locked()
    for name, version in c.items():
        assert locked.get(name) == version, (
            f"{name}: constraints {version}, uv.lock {locked.get(name)} -- regenerate "
            "with `uv export --frozen --no-hashes --no-dev --no-emit-project`")


def test_install_pins_gs_to_the_constraints(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / "packages/gs").mkdir(parents=True)
    (repo / "packages/gs/constraints.txt").write_text("websockets==17.2\n")
    runs: list[list[str]] = []
    monkeypatch.setattr(hub.subprocess, "run", lambda *a, **k: type("R", (), {
        "returncode": 0, "stdout": "", "stderr": ""})())
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_saved", lambda elevate=False: {})
    monkeypatch.setattr(hub, "_preflight", lambda o, force: hub.NETWORKMANAGER)
    monkeypatch.setattr(hub, "_install_packages", lambda b, skip: True)
    monkeypatch.setattr(hub, "_ensure_home", lambda user: None)
    monkeypatch.setattr(hub, "_install_text", lambda *a: None)
    monkeypatch.setattr(hub, "_install_gs_env", lambda *a, **k: None)
    monkeypatch.setattr(hub, "_ap_networkmanager", lambda *a, **k: None)
    monkeypatch.setattr(hub, "_as_user", lambda u, cmd, **k: runs.append(cmd) or 0)
    assert cli_main.main(["install", "--repo", str(repo)]) == 0
    pip = next(c for c in runs if "pip" in c[0] and "install" in c)
    assert pip[pip.index("-c") + 1] == str(repo / "packages/gs/constraints.txt")


# --- /etc/hosts -------------------------------------------------------------

PI_HOSTS = ("127.0.0.1\tlocalhost\n::1\t\tlocalhost ip6-localhost ip6-loopback\n"
            "ff02::1\t\tip6-allnodes\n\n127.0.1.1\t\traspberrypi\n")


def test_hosts_names_the_new_hostname():
    """hostnamectl leaves Pi OS's `127.0.1.1 raspberrypi`; the new name then
    goes to DNS, which in a field with no uplink cannot answer."""
    out = hub.hosts_with_hostname(PI_HOSTS, "commandant")
    assert "raspberrypi" not in out
    assert "127.0.1.1\tcommandant" in out.splitlines()
    assert out.count("127.0.1.1") == 1 and "localhost ip6-localhost" in out


def test_hosts_already_right_is_untouched_and_missing_line_is_added():
    right = hub.hosts_with_hostname(PI_HOSTS, "commandant")
    assert hub.hosts_with_hostname(right, "commandant") == right
    assert hub.hosts_with_hostname("127.0.0.1 localhost\n", "hub") == \
        "127.0.0.1 localhost\n127.0.1.1\thub\n"
    assert hub.hosts_with_hostname("", "hub") == "127.0.1.1\thub\n"
    # A commented-out line is not the machine's name.
    assert hub.hosts_with_hostname("#127.0.1.1 old\n", "hub").endswith("127.0.1.1\thub\n")


# --- not while it flies -----------------------------------------------------

def test_flight_state_reads_armed_and_landed_state():
    assert hub.flight_state(None) == ""
    assert hub.flight_state({"armed": False, "landedState": "on_ground"}) == ""
    assert hub.flight_state({"armed": True}) == "armed"
    # Disarmed in the air is still flying (a failsafe, a glide).
    assert hub.flight_state({"armed": False, "landedState": "in_air"}) == "in_air"
    assert hub.flight_state({"armed": None, "landedState": None}) == ""


def _no_side_effects(monkeypatch) -> list[list[str]]:
    calls: list[list[str]] = []
    monkeypatch.setattr(hub, "_sudo", lambda cmd, **k: calls.append(cmd) or 0)
    monkeypatch.setattr(hub, "_as_user", lambda u, cmd, **k: calls.append(cmd) or 0)
    monkeypatch.setattr(hub, "cmd_install", lambda a: calls.append(["install"]) or 0)
    monkeypatch.setattr(hub, "cmd_status", lambda a: 0)
    monkeypatch.setattr(hub, "_saved", lambda elevate=False: {})
    return calls


def test_update_down_uninstall_refuse_while_flying(monkeypatch, capsys):
    """Each stops or restarts gs: the operator's link and command, mid-flight."""
    calls = _no_side_effects(monkeypatch)
    monkeypatch.setattr(hub, "_gs_status", lambda o: {"type": "status", "armed": True})
    assert cli_main.main(["update", "--no-pull"]) == 2
    assert cli_main.main(["down"]) == 2
    assert cli_main.main(["uninstall", "--yes"]) == 2
    assert calls == []
    assert "aircraft is armed" in capsys.readouterr().err


def test_in_flight_flag_overrides_and_no_gs_means_proceed(monkeypatch):
    calls = _no_side_effects(monkeypatch)
    monkeypatch.setattr(hub, "_gs_status", lambda o: {"type": "status", "armed": True})
    assert cli_main.main(["down", "--in-flight"]) == 0
    assert calls and calls[-1][:2] == ["systemctl", "stop"]
    calls.clear()
    # gs not running (or too old to say): nothing to protect, so no refusal.
    monkeypatch.setattr(hub, "_gs_status", lambda o: None)
    assert cli_main.main(["update", "--no-pull"]) == 0
    assert ["install"] in calls


def test_gs_status_reads_the_json_line_past_other_output(monkeypatch, tmp_path):
    py = tmp_path / "packages/gs/.venv/bin/python"
    py.parent.mkdir(parents=True)
    py.write_text("")
    seen = {}

    def run(cmd, **kw):
        seen["cmd"] = cmd
        return type("R", (), {"returncode": 0, "stderr": "",
                              "stdout": '2026 gs 0.1.0\n{"type": "status", "armed": true}\n'})()
    monkeypatch.setattr(hub.subprocess, "run", run)
    monkeypatch.setattr(hub, "GS_ENV", str(tmp_path / "gs.env"))
    (tmp_path / "gs.env").write_text("GS_WS_PORT=8791\n")
    st = hub._gs_status({"repo": str(tmp_path)})
    assert st == {"type": "status", "armed": True}
    assert seen["cmd"][-4:] == ["--status", "--json", "--ws-port", "8791"]


def test_update_with_no_uplink_says_what_to_do(monkeypatch, tmp_path, capsys):
    """In a field with no internet the pull fails; that was a traceback."""
    (tmp_path / ".git").mkdir()
    calls = _no_side_effects(monkeypatch)
    monkeypatch.setattr(hub, "_gs_status", lambda o: None)
    monkeypatch.setattr(hub, "_as_user", lambda u, cmd, **k: calls.append(cmd) or 1)
    assert cli_main.main(["update", "--repo", str(tmp_path)]) == 3
    assert ["install"] not in calls
    assert "--no-pull" in capsys.readouterr().err


# --- joining an existing network (a HITL bench, a Starlink router) ----------

def _install_existing(monkeypatch, tmp_path, argv, saved=None, has_ap=False):
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    written: dict = {}
    calls: list[list[str]] = []
    built: dict = {}
    monkeypatch.setattr(hub.subprocess, "run", lambda *a, **k: type("R", (), {
        "returncode": 0, "stdout": "", "stderr": ""})())
    monkeypatch.setattr(hub.os, "geteuid", lambda: 0)
    monkeypatch.setattr(hub, "_saved", lambda elevate=False: dict(saved or {}))
    monkeypatch.setattr(hub, "_install_packages", lambda b, skip: True)
    monkeypatch.setattr(hub, "_as_user", lambda *a, **k: 0)
    monkeypatch.setattr(hub, "_ensure_home", lambda user: None)
    monkeypatch.setattr(hub, "_install_gs_env", lambda *a, **k: "")
    monkeypatch.setattr(hub, "_install_text",
                        lambda text, dest, mode: written.update({dest: text}))
    monkeypatch.setattr(hub, "_sudo", lambda cmd, **k: calls.append(cmd) or 0)
    monkeypatch.setattr(hub, "_nm_has_connection", lambda: has_ap)
    monkeypatch.setattr(hub.shutil, "which", lambda b: "/usr/bin/" + b)
    monkeypatch.setattr(hub, "_ap_networkmanager", lambda *a, **k: built.update(ap=True))
    monkeypatch.setattr(hub, "_ap_hostapd", lambda *a, **k: built.update(ap=True))
    # A machine with no WiFi at all, and a wired network up: the bench case.
    monkeypatch.setattr(hub, "_wifi_ifaces", lambda: [])
    monkeypatch.setattr(hub, "_network_backend", lambda: hub.NETWORKMANAGER)
    monkeypatch.setattr(hub.Path, "exists", lambda self: str(self) != "/etc/hostapd/hostapd.conf"
                        or has_ap)
    rc = cli_main.main(["install", "--repo", str(repo), *argv])
    return rc, written, calls, built


def test_existing_network_needs_no_wifi_and_builds_no_hotspot(monkeypatch, tmp_path, capsys):
    """A HITL bench (thror) is on the lab network, often wired, and must stay
    on it: the hotspot path refused a machine with no WiFi, and on one with
    WiFi would have taken it over."""
    rc, written, calls, built = _install_existing(monkeypatch, tmp_path, ["--network", "existing"])
    assert rc == 0 and "ap" not in built
    assert json.loads(written[hub.SAVED])["network"] == "existing"
    out = capsys.readouterr().out
    assert "join WiFi" not in out and "this machine's network" in out
    assert "placeholder" not in out


def test_hotspot_mode_still_refuses_a_machine_with_no_wifi(monkeypatch, tmp_path):
    import pytest
    with pytest.raises(SystemExit):
        _install_existing(monkeypatch, tmp_path, [])


def test_switching_to_existing_takes_the_old_hotspot_down(monkeypatch, tmp_path):
    """Left up, a one-radio Pi would keep broadcasting and never join."""
    rc, _, calls, _ = _install_existing(monkeypatch, tmp_path, ["--network", "existing"],
                                        has_ap=True)
    assert rc == 0
    assert ["nmcli", "connection", "delete", hub.NM_CONNECTION] in calls
    assert ["systemctl", "disable", "--now", "hostapd", "dnsmasq"] in calls


def test_existing_is_remembered_by_update(monkeypatch, tmp_path):
    rc, _, _, built = _install_existing(monkeypatch, tmp_path, [],
                                        saved={"network": "existing"})
    assert rc == 0 and "ap" not in built


def test_status_on_an_existing_network_checks_no_hotspot(monkeypatch, capsys):
    monkeypatch.setattr(hub, "_saved", lambda elevate=False: {"network": "existing"})
    monkeypatch.setattr(hub, "_unit_state", lambda u: ("active", "enabled"))
    assert cli_main.main(["status"]) == 0
    out = capsys.readouterr().out
    assert "hostapd" not in out and "NetworkManager" not in out
    assert "existing network" in out
