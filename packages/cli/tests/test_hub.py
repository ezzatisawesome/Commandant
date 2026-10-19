"""The hub installer's logic, as far as it can be checked off a Pi.

This file provisions the field deployment and has never been run on hardware,
so the parts that are pure logic are worth pinning even though the parts that
touch apt and systemd are not. Both faults below are the kind that only show up
on the real thing, and both are decided before any command is issued.
"""

from __future__ import annotations

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
    hub._as_user("commandant", ["python3", "-m", "venv", "/opt/commandant/x"])
    assert calls[0][:4] == ["sudo", "-u", "commandant", "-H"]
    assert calls[0][4:] == ["python3", "-m", "venv", "/opt/commandant/x"]


def test_as_user_also_elevates_when_invoked_as_root(monkeypatch):
    """Root must still drop to the service user: a venv and an npm tree owned by
    root are not usable by the units that run as `commandant`."""
    calls = _captured(monkeypatch)
    monkeypatch.setattr(hub, "_current_user", lambda: "root")
    hub._as_user("commandant", ["npm", "install"])
    assert calls[0][:4] == ["sudo", "-u", "commandant", "-H"]


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
                 "ap_ip": "10.9.8.1", "radio": "serial:/dev/ttyUSB0:115200"})
    out = hub._render("hostapd.conf", subs)
    assert "ssid=fieldnet" in out
    assert "wpa_passphrase=s3cret-pass" in out
    assert "country_code=GB" in out
    assert "changeme-commandant" not in out, "the default passphrase survived"

    dns = hub._render("dnsmasq.conf", subs)
    assert "10.9.8.1" in dns and "192.168.50.1" not in dns

    env = hub._render("gs.env", subs)
    assert "serial:/dev/ttyUSB0:115200" in env


def test_pi_guard_refuses_to_reconfigure_a_workstation(monkeypatch):
    """Running the installer on a laptop would rewrite its networking. It
    refuses unless forced."""
    monkeypatch.setattr(hub, "_is_raspberry_pi", lambda: False)
    with pytest.raises(SystemExit) as e:
        hub._require_pi(force=False)
    assert e.value.code == 2
    hub._require_pi(force=True)        # explicit override is allowed


def test_templates_referenced_by_install_all_exist():
    """A missing template is a mid-install crash on a Pi, after apt and the
    networking changes have already happened."""
    for rel in ("hostapd.conf", "dnsmasq.conf", "gs.env",
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


def test_gs_unit_waits_for_the_serial_device_and_keeps_dialout():
    """The radio is a serial device that may enumerate after the network, and
    reading it needs the dialout group."""
    u = _unit("gs.service")
    assert "dev-serial0.device" in u
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
    cli_main.main(["uninstall", "--yes"])
    flat = " ".join(" ".join(c) for c in calls)
    assert "/opt/commandant" not in flat, "touched the repo"
    assert "gs.service" in flat and "hostapd.conf" in flat


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
