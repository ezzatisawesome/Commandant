# commandant — the hub CLI

The single interface to the Commandant **hub**: a Linux machine that is both the
ground station and the base station. A Raspberry Pi is the usual one, but any
systemd box with a WiFi interface that can run an access point will do. Modeled
on Guppi's CLI.

> **Plane on. Hub on.** Join the hub's WiFi (`commandant`) on any phone or laptop,
> open **http://commandant.local/**, and you just see the plane — live on the globe.
> No login, no setup, multiple viewers at once.

```
   plane ──radio/serial──►  HUB (Linux)  ──WiFi AP──►  phones / laptops
                            • gs daemon  (owns the radio link, WS :8790)
                            • console    (Next.js served on :80)
                            • WiFi AP "commandant", DHCP on 192.168.50.0/24
                              (NetworkManager, or hostapd + dnsmasq)
                            • avahi      (mDNS: commandant.local)
```

## Commands

| Command | What it does |
|---------|--------------|
| `commandant install` | Provision this machine into the hub: apt deps, WiFi AP + DHCP, mDNS (avahi), build `gs` venv + production `console`, install & enable systemd units, set hostname. Idempotent. |
| `commandant update` | `git pull` + re-run the installer + restart services. No delta updates — the installer is the source of truth. Flags given to an earlier `install` are remembered (`/etc/commandant/hub.json`, and the passphrase in root-only `hub.psk`), so a bare `update` keeps your SSID, passphrase and country. |
| `commandant status` | Services, the AP, and the address clients should reach. Nonzero if anything is down. |
| `commandant up` / `down` | Start / stop `gs` and `console` (`down` leaves the AP up). |
| `commandant logs [-f]` | Both services' journals, interleaved. |
| `commandant uninstall --yes` | Remove what `install` added; leaves the repo alone. |

The hub autostarts on boot (systemd), so day to day there's nothing to "start".

Install flags (install/update): `--ssid --passphrase --country --ap-ip --radio
--iface --hostname --user --repo --skip-packages --force`. All default to
sensible values; the WiFi passphrase defaults to a placeholder you should
override. `/etc/commandant/gs.env` (root-only) is written once and is yours
afterwards (relay token, events metadata); `update` leaves it alone, and
`--radio` changes only its `GS_MAVLINK` line.

The first install also generates a **command token** into `gs.env` and prints
it once. Watching needs nothing; the console asks for the token before anyone
can arm, switch modes or upload a mission. Read it again with
`sudo grep GS_COMMAND_TOKEN /etc/commandant/gs.env`. Emptying it reopens command
to anyone on the hub's WiFi, and `gs` warns about that at every start.

## What it needs

`install` checks these up front and reports every one that is missing at once:

- **systemd.**
- **A WiFi interface** that supports AP mode. Detected (`wlan0` on a Pi,
  `wlp2s0` and similar elsewhere); `--iface` to choose.
- **NetworkManager or dhcpcd** managing the network. NetworkManager (current Pi
  OS, Ubuntu, Debian, Fedora) gets the AP as one `nmcli` connection,
  `commandant-ap`, in shared mode — it runs DHCP itself. dhcpcd (older Pi OS)
  gets the static IP + hostapd + dnsmasq. Ubuntu Server ships neither on WiFi:
  `apt install network-manager` first.
- **apt**, for packages. Elsewhere `install` prints what to install (Debian
  names) and you re-run with `--skip-packages`.
- **Node ≥ 18.18** for the console build. apt's is too old on Debian Bullseye
  and Ubuntu 22.04; install NodeSource's first and `install` leaves it alone.

"Managing" means running: an installed-but-idle dhcpcd (Ubuntu 24.04 ships one
as a DHCP client) does not count. `--country` sets the WiFi regulatory domain;
without it, a machine that already has one keeps it.

It refuses to take over a WiFi interface that is **connected right now**,
because that drops the connection — your laptop's WiFi, or the ssh session
you're provisioning a Pi over. Set up over ethernet, or pass `--force` if
that's intended.

## Setup

1. Any systemd Linux with WiFi — e.g. **Raspberry Pi OS Lite (64-bit)**, Debian,
   or Ubuntu. Connect over ethernet (or a second interface) for first setup:
   provisioning takes over the WiFi interface.
2. Put the monorepo at `/opt/commandant`, install this CLI, then:
   ```bash
   sudo commandant install --passphrase 'your-wifi-pass' --country US
   sudo reboot
   ```
   The radio defaults to `auto`; pin it with `--radio` if more than one
   candidate is attached.
3. Join WiFi `commandant` → open `http://commandant.local/`.

## Templates

The hub config ships as data inside the package and is rendered into place by
`install`:

```
commandant_cli/templates/
  nm-dnsmasq-shared.conf  → /etc/NetworkManager/dnsmasq-shared.d/commandant.conf  (NetworkManager)
  hostapd.conf            → /etc/hostapd/hostapd.conf                             (dhcpcd)
  dnsmasq.conf            → /etc/dnsmasq.d/commandant.conf                        (dhcpcd)
  avahi/commandant.service→ /etc/avahi/services/commandant.service
  systemd/gs.service      → /etc/systemd/system/gs.service
  systemd/console.service → /etc/systemd/system/console.service
  gs.env                  → /etc/commandant/gs.env
```

## Plane ↔ hub link

`gs` attaches to the radio via its `--mavlink` endpoint (set in `/etc/commandant/
gs.env`). The default, `auto`, probes USB serial (`/dev/ttyACM*`, `/dev/ttyUSB*`),
a Pi's UART (`/dev/serial0`), then UDP :14550 and TCP :5760, and re-probes when
the link drops. Pin it to e.g. `serial:/dev/ttyUSB0:57600` when more than one is
present. On a Pi's UART, disable the serial login console and enable the
hardware UART (`raspi-config` → Interface → Serial).

## Untested until real hardware

Config/scaffolding only — none of this was run on hardware. On a real hub, validate:
- The AP comes up and clients associate: `nmcli connection up commandant-ap`
  (or hostapd on the dhcpcd path). Country/channel/driver regulatory issues are
  the usual failure, and some WiFi chips do not support AP mode at all
  (`iw list` → "Supported interface modes" must include AP).
- `commandant.local` resolves from iOS/Android/macOS/Windows (mDNS varies; some
  Android needs a fallback to `192.168.50.1`).
- `console.service` binds :80 via `CAP_NET_BIND_SERVICE` (no root).
- UART present, login console off, baud correct, `commandant` user in `dialout`.
- The AP's WiFi interface can't also be a WiFi client; a hub that must stay
  online needs a second interface.

## Publishing a flight to the public viewer

Optional and off by default. Uncomment `COMMANDANT_RELAY` and
`COMMANDANT_RELAY_TOKEN` in `/etc/commandant/gs.env` and restart `gs`:

```sh
sudo systemctl restart gs
```

The hub then pushes telemetry **outbound** to the relay, which fans it out to
read-only browsers at `commandant.guppidev.com`. The hub is never reachable
inbound and the relay has no route back to it, so command authority stays on the
hub's own WiFi. Nothing else about the hub changes, and with the variables unset
the hub stays fully offline. See [`../../docs/hosting.md`](../../docs/hosting.md).
