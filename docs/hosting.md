# Hosting commandant.guppidev.com

Two pieces, two hosts, because they have different runtime needs.

| URL | Serves | Host | Status |
|---|---|---|---|
| `commandant.guppidev.com` | the UI, what people visit | Vercel | domain attached; needs one DNS record |
| `commandant-relay.fly.dev` | the live telemetry WebSocket | Fly.io | deployed |

```
  browser ──https──► Vercel (console, NEXT_PUBLIC_MODE=view)
     │
     └────wss──────► Fly (relay) ◄────wss /publish──── field hub (gs --relay)
```

The console is static as far as data is concerned: it loads, then opens a
WebSocket straight to the relay. Vercel never proxies telemetry.

**Why two hosts.** Vercel's functions cannot hold an open WebSocket for the
duration of a flight, so the stream needs an always-on process. Nobody types the
Fly hostname; the page opens it in the background.

> `guppi.com` is not ours — it was registered in 1999 and sits on GoDaddy
> nameservers. The domains in this account are `guppidev.com`, `guppi-dev.com`
> and `guppi-ai.com`. That is why the site is on `guppidev.com`.

## 1. Relay on Fly (done)

```sh
cd packages/relay
fly launch --no-deploy --name commandant-relay      # reads fly.toml
fly secrets set RELAY_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

It is served at `wss://commandant-relay.fly.dev/` with no custom domain, which
is deliberate: one less DNS record, and the hostname is never user-facing.

Smoke-test a deployment without PX4:

```sh
cd packages/relay
uv run python scripts/fake_hub.py \
  --url wss://commandant-relay.fly.dev/publish --token "<RELAY_TOKEN>"
```

The token is write-only once set as a Fly secret, so keep your own copy.

## 2. Console on Vercel (done, except DNS)

The project is linked and deployed; the root `vercel.json` targets the `console`
workspace. Environment variables, set on production and preview:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_MODE` | `view` |
| `NEXT_PUBLIC_RELAY_ENDPOINT` | `wss://commandant-relay.fly.dev/` |
| `NEXT_PUBLIC_CESIUM_KEY` | the Cesium Ion token |

`NEXT_PUBLIC_MODE=view` is what makes the deployment read-only: no command bar,
no authoring, no parameter writes, and a telemetry client that refuses to
transmit. **Never set it to `cockpit` on a public deployment.**

The Cesium token ships in the client bundle (that is what `NEXT_PUBLIC_` means),
so restrict it to your domains in Cesium Ion.

**Remaining step.** `guppidev.com` DNS is at Namecheap
(`dns1/dns2.registrar-servers.com`). Add:

```
Type: A    Host: commandant    Value: 76.76.21.21
```

Vercel verifies and issues the certificate automatically.

## 3. Point a hub at it

```sh
cd packages/gs
uv run python -m gs \
  --relay wss://commandant-relay.fly.dev/publish \
  --relay-token "<RELAY_TOKEN>" \
  --flight-id "$(date -u +flight-%Y%m%d-%H%M%S)"
```

Or set `COMMANDANT_RELAY` and `COMMANDANT_RELAY_TOKEN` in the hub's systemd unit
so every boot publishes automatically.

## Why the token only guards publishing

Watching is open: what a viewer sees is an aircraft flying, which is not a
secret. Publishing is gated because a forged publisher could show a fake
aircraft. If flights ever need to be private, put access control on the Vercel
project and keep the relay's contract narrow.

## Pinned dependencies (do not widen casually)

`packages/console/package.json` pins `cesium` to `1.128.0`, and the root
`package.json` holds `@zip.js/zip.js` on `2.7.73`. Cesium ≥ 1.132 ships
wasm-bindgen glue whose inlined binary the production minifier rewrites into a
template literal containing octal escapes — invalid JavaScript, so the bundle
fails to parse and the page never mounts. Dev builds are unminified and hide it,
so this only appears on a real deployment. 1.128 is the newest release that
still has `CallbackPositionProperty` (needed by `Aircraft.tsx`) and predates the
WASM module.

Every build asserts what the browser needs:

```sh
cd packages/console && npm run build
find .next/static/chunks -name '*.js' -exec node --check {} \;   # must be silent
```

## What is deliberately not hosted

Flight history. Guppi is the data plane and already has the viewer for trends,
multi-signal plots and cross-run comparison. The relay forwards and forgets, and
the hosted console has no replay or archive UI. See the scope boundary in
`roadmap.md`.
