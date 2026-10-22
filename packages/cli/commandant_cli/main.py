"""commandant — own the hub lifecycle.

The hub is both the ground station and the base station: it runs the `gs` daemon
(the plane's radio link) and serves the `console` web app, as its own standalone
WiFi AP reachable at `commandant.local`. This CLI is the single interface to it.

    commandant install   # provision this Linux machine into the hub
    commandant update    # pull + re-run the installer + restart services

The hub autostarts on boot (systemd), so those two are all you need. For health
or debugging, `commandant status` and `commandant logs`.

Field story: plane on, hub on, join WiFi 'commandant', open http://commandant.local/
— you just see the plane, live.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional

from . import __version__
from .hub import (
    DEFAULTS, cmd_down, cmd_install, cmd_logs, cmd_status, cmd_up, cmd_uninstall,
    cmd_update,
)


def _add_provision_opts(p: argparse.ArgumentParser) -> None:
    """Flags shared by install/update (and some by dev) — all default to DEFAULTS."""
    p.add_argument("--repo", help=f"Monorepo path on the hub (default: {DEFAULTS['repo']})")
    p.add_argument("--ssid", help=f"AP WiFi name (default: {DEFAULTS['ssid']})")
    p.add_argument("--passphrase", help="AP WiFi password (default: a placeholder — change it)")
    p.add_argument("--country", help=f"WiFi regulatory domain (default: {DEFAULTS['country']})")
    p.add_argument("--ap-ip", dest="ap_ip", help=f"Hub's address on its AP (default: {DEFAULTS['ap_ip']})")
    p.add_argument("--radio", help=f"gs MAVLink/radio endpoint (default: {DEFAULTS['radio']})")
    p.add_argument("--hostname", help=f"Hub hostname (default: {DEFAULTS['hostname']})")
    p.add_argument("--user", help=f"Service user (default: {DEFAULTS['user']})")
    p.add_argument("--iface", help="WiFi interface to run the AP on (default: detected)")
    p.add_argument("--skip-packages", dest="skip_packages", action="store_true",
                   help="Don't apt-get install (off apt, install the listed equivalents yourself)")
    p.add_argument("--force", action="store_true",
                   help="Take over the WiFi interface even though it is connected")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="commandant", description=__doc__.split("\n")[0])
    parser.add_argument("--version", action="version", version=f"commandant {__version__}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("install", help="Provision this Linux machine into the hub")
    _add_provision_opts(p)
    p.set_defaults(fn=cmd_install)

    p = sub.add_parser("update", help="Pull + re-run the installer + restart services")
    _add_provision_opts(p)
    p.add_argument("--no-pull", action="store_true", help="Don't git-pull before re-running")
    p.set_defaults(fn=cmd_update)

    # The rest of the lifecycle. These were in the package description and the
    # roadmap but not in the code, so `commandant status` -- the thing you type
    # in a field when the page does not load -- was an argparse error.
    p = sub.add_parser("status", help="What is running, and where to look next")
    _add_provision_opts(p)
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("up", help="Start the hub's services")
    _add_provision_opts(p)
    p.set_defaults(fn=cmd_up)

    p = sub.add_parser("down", help="Stop them (the WiFi AP stays up)")
    _add_provision_opts(p)
    p.set_defaults(fn=cmd_down)

    p = sub.add_parser("logs", help="Follow both services' journals together")
    p.add_argument("-n", "--lines", type=int, default=200, help="History to show")
    p.add_argument("-f", "--follow", action="store_true", help="Keep following")
    p.set_defaults(fn=cmd_logs)

    p = sub.add_parser("uninstall", help="Remove the services and AP config")
    _add_provision_opts(p)
    p.add_argument("--yes", action="store_true", help="Required; this is destructive")
    p.set_defaults(fn=cmd_uninstall)

    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
