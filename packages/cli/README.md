# commandant — the hub CLI

The single interface to the Commandant **hub**: a Raspberry Pi that is both the
ground station and the base station. Modeled on Guppi's CLI.

> **Plane on. Hub on.** Join the hub's WiFi (`commandant`) on any phone or laptop,
> open **http://commandant.local/**, and you just see the plane — live on the globe.
> No login, no setup, multiple viewers at once.

```
   plane ──radio/serial──►  HUB (Raspberry Pi)  ──WiFi AP──►  phones / laptops
                            • gs daemon  (owns the radio link, WS :8790)
                            • console    (Next.js served on :80)
                            • hostapd    (standalone WiFi AP "commandant")
                            • dnsmasq    (DHCP, 192.168.50.0/24)
                            • avahi      (mDNS: commandant.local)
```

## Commands

| Command | What it does |
|---------|--------------|
| `commandant install` | Provision a fresh Raspberry Pi: apt deps, AP (hostapd) + DHCP (dnsmasq) + mDNS (avahi), build `gs` venv + production `console`, install & enable systemd units, set hostname. Idempotent. |
| `commandant update` | `git pull` + re-run the installer + restart services. No delta updates — the installer is the source of truth. |
| `commandant status` | Hub + service health (gs, console, hostapd, dnsmasq, avahi). |
| `commandant up` / `down` | Start / stop the hub services. |
| `commandant logs [gs\|console]` | Tail service logs (journalctl). |
| `commandant uninstall [-y]` | Remove services/config. Repo and data are kept. |
| `commandant dev` | Laptop test: run `gs` + the console dev server locally (default endpoint `udpin:0.0.0.0:14550` for bench/SITL). |

Install flags (install/update): `--ssid --passphrase --country --ap-ip --radio
--hostname --user --repo --force`. All default to sensible values; the WiFi
passphrase defaults to a placeholder you should override.

## Setup

1. Flash **Raspberry Pi OS (Lite, 64-bit)**; boot with a wired/secondary network
   for first setup (provisioning takes over `wlan0`).
2. Put the monorepo at `/opt/commandant`, install this CLI, then:
   ```bash
   sudo commandant install --passphrase 'your-wifi-pass' --country US \
                           --radio serial:/dev/serial0:57600
   sudo reboot
   ```
3. Join WiFi `commandant` → open `http://commandant.local/`.

## Templates

The hub config ships as data inside the package and is rendered into place by
`install`:

```
commandant_cli/templates/
  hostapd.conf            → /etc/hostapd/hostapd.conf
  dnsmasq.conf            → /etc/dnsmasq.d/commandant.conf
  avahi/commandant.service→ /etc/avahi/services/commandant.service
  systemd/gs.service      → /etc/systemd/system/gs.service
  systemd/console.service → /etc/systemd/system/console.service
  gs.env                  → /etc/commandant/gs.env
```

## Plane ↔ hub link

`gs` attaches to the radio via its `--mavlink` endpoint (set in `/etc/commandant/
gs.env`): `serial:/dev/serial0:57600` (Pi UART), `serial:/dev/ttyUSB0:57600` (USB
radio), or `udpin:0.0.0.0:14550` (bench/SITL). On the Pi UART, disable the serial
login console and enable the hardware UART (`raspi-config` → Interface → Serial).

## Untested until real hardware

Config/scaffolding only — none of this was run here. On a real Pi, validate:
- hostapd starts (country/channel/driver regulatory issues are the usual failure)
  and clients associate; dnsmasq leases don't conflict with another DHCP.
- `commandant.local` resolves from iOS/Android/macOS/Windows (mDNS varies; some
  Android needs a fallback to `192.168.50.1`).
- `console.service` binds :80 via `CAP_NET_BIND_SERVICE` (no root).
- UART present, login console off, baud correct, `commandant` user in `dialout`.
- Bookworm uses NetworkManager — the `dhcpcd` static-IP approach may need an
  `nmcli`-based AP instead.
- `wlan0` as AP can't also be a WiFi client; a Pi that must stay online needs a
  second interface.
