# Hosting commandant.guppi.com

Two pieces, two hosts, because they have different runtime needs.

| Piece | Where | Why |
|---|---|---|
| Console in **view** mode | Vercel | A Next app with no backend; Vercel's native case |
| **Relay** | Fly.io | Needs one always-on process holding long websockets, which serverless cannot do |

```
  browser ──https──► Vercel (console, NEXT_PUBLIC_MODE=view)
     │
     └────wss──────► Fly (relay) ◄────wss /publish──── field hub (gs --relay)
```

The console is static as far as the data is concerned: it loads, then opens a
websocket straight to the relay. Vercel never proxies telemetry.

## 1. Relay on Fly

```sh
cd packages/relay
fly launch --no-deploy --name commandant-relay      # reads fly.toml
fly secrets set RELAY_TOKEN="$(openssl rand -hex 32)"
fly deploy
fly secrets list                                    # keep the token for the hub
```

Attach a hostname for the websocket. Keeping it on its own subdomain means the
site and the stream scale and fail independently:

```sh
fly certs add relay.commandant.guppi.com
# then add the CNAME / A records Fly prints, at whatever manages guppi.com DNS
```

Check it:

```sh
cd packages/relay
uv run python scripts/fake_hub.py \
  --url wss://relay.commandant.guppi.com/publish --token "<RELAY_TOKEN>"
```

## 2. Console on Vercel

Import `github.com/ezzatisawesome/Commandant` in the Vercel dashboard. The root
`vercel.json` already points at the `console` workspace, so no build settings
need changing. Set these environment variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_MODE` | `view` |
| `NEXT_PUBLIC_RELAY_ENDPOINT` | `wss://relay.commandant.guppi.com/` |
| `NEXT_PUBLIC_CESIUM_KEY` | your Cesium Ion token |

`NEXT_PUBLIC_MODE=view` is what makes the deployment read-only: no command bar,
no authoring, no parameter writes, and a telemetry client that refuses to
transmit. **Never set it to `cockpit` on a public deployment.**

Then add `commandant.guppi.com` as a domain on the Vercel project.

## 3. Point the hub at it

On the Raspberry Pi hub (or any machine running the daemon):

```sh
cd packages/gs
uv run python -m gs \
  --relay wss://relay.commandant.guppi.com/publish \
  --relay-token "<RELAY_TOKEN>" \
  --flight-id "$(date -u +flight-%Y%m%d-%H%M%S)"
```

Or set `COMMANDANT_RELAY` and `COMMANDANT_RELAY_TOKEN` in the hub's systemd unit
so every boot publishes automatically.

## Why the token only guards publishing

Watching is open: what a viewer sees is an aircraft flying, which is not a
secret. Publishing is gated because a forged publisher could show a fake
aircraft. If the flights themselves ever need to be private, put access control
on the Vercel project, not on the relay, and keep the relay's contract narrow.

## What is deliberately not hosted

Flight history. Guppi is the data plane and already has the viewer for trends,
multi-signal plots and cross-run comparison. The relay forwards and forgets, and
the hosted console has no replay or archive UI. See the scope boundary in
`roadmap.md`.
