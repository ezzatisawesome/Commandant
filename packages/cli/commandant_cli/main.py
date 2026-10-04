"""commandant — own the Raspberry Pi hub lifecycle.

The hub is both the ground station and the base station: it runs the `gs` daemon
(the plane's radio link) and serves the `console` web app, as its own standalone
WiFi AP reachable at `commandant.local`. This CLI is the single interface to it.

    commandant install   # provision a fresh Raspberry Pi into the hub
    commandant update    # pull + re-run the installer + restart services

The hub autostarts on boot (systemd), so those two are all you need. For health
or debugging, use systemctl / journalctl on the Pi directly.

Field story: plane on, hub on, join WiFi 'commandant', open http://commandant.local/
— you just see the plane, live.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional

from . import __version__
from .hub import DEFAULTS, cmd_install, cmd_update


def _add_provision_opts(p: argparse.ArgumentParser) -> None:
    """Flags shared by install/update (and some by dev) — all default to DEFAULTS."""
    p.add_argument("--repo", help=f"Monorepo path on the Pi (default: {DEFAULTS['repo']})")
    p.add_argument("--ssid", help=f"AP WiFi name (default: {DEFAULTS['ssid']})")
    p.add_argument("--passphrase", help="AP WiFi password (default: a placeholder — change it)")
    p.add_argument("--country", help=f"WiFi regulatory domain (default: {DEFAULTS['country']})")
    p.add_argument("--ap-ip", dest="ap_ip", help=f"Pi AP address (default: {DEFAULTS['ap_ip']})")
    p.add_argument("--radio", help=f"gs MAVLink/radio endpoint (default: {DEFAULTS['radio']})")
    p.add_argument("--hostname", help=f"Pi hostname (default: {DEFAULTS['hostname']})")
    p.add_argument("--user", help=f"Service user (default: {DEFAULTS['user']})")
    p.add_argument("--force", action="store_true", help="Skip the Raspberry-Pi-OS guard")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="commandant", description=__doc__.split("\n")[0])
    parser.add_argument("--version", action="version", version=f"commandant {__version__}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("install", help="Provision a fresh Raspberry Pi into the hub")
    _add_provision_opts(p)
    p.set_defaults(fn=cmd_install)

    p = sub.add_parser("update", help="Pull + re-run the installer + restart services")
    _add_provision_opts(p)
    p.add_argument("--no-pull", action="store_true", help="Don't git-pull before re-running")
    p.set_defaults(fn=cmd_update)

    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
