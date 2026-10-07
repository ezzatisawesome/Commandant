# relay — the public window onto a live flight

Backs the hosted viewer at `commandant.guppidev.com`, served from
`wss://commandant-relay.fly.dev/`. The field hub dials **out** and pushes telemetry;
browsers connect and watch. Nothing more.

```
 hub (gs --relay) ──wss /publish──► relay ──wss / ──► browsers (view mode)
        ▲                                                  │
        └──────────── no route back, by design ────────────┘
```

## Why it exists

A hub in a field cannot be reached inbound (hotspot, CGNAT, no static address),
and **must not be**: command authority lives on the hub's own WiFi and nowhere
else. An outbound push is the only topology that gives public visibility without
creating an internet-reachable path to an aircraft.

## The read-only guarantee

Read-only is structural, not configuration:

1. A **viewer socket is never read.** The handler sends the current state, then
   waits for close. A viewer's inbound bytes are discarded by the transport; no
   code parses them.
2. The **publisher socket is never written to.** There is no `send` on that path.
3. The hosted console is built with `NEXT_PUBLIC_MODE=view`, whose telemetry
   client refuses to transmit at its single send chokepoint.

Any one of the three would be sufficient. `tests/test_relay.py` pins (1) and (2)
by firing arm, disarm, param_set and mission_push at the relay as a viewer and
asserting the publisher receives nothing.

## Run it

```sh
cd packages/relay
uv venv && uv pip install -e ".[dev]"
RELAY_TOKEN=devtoken uv run python -m relay --port 8791
```

Then publish a synthetic flight (no PX4 needed) and watch it:

```sh
uv run python scripts/fake_hub.py                      # circles over Mountain View
cd ../console && NEXT_PUBLIC_MODE=view \
  NEXT_PUBLIC_RELAY_ENDPOINT=ws://127.0.0.1:8791/ npm run dev -- -p 4301
```

From a real hub, point the daemon at it:

```sh
cd packages/gs
uv run python -m gs --relay ws://127.0.0.1:8791/publish --relay-token devtoken
# deployed:  --relay wss://commandant-relay.fly.dev/publish --relay-token "<secret>"
```

## Deploy

See `fly.toml` and `../../docs/hosting.md`. In short: set `RELAY_TOKEN` as a
secret, `fly deploy`, then give the hub
`--relay wss://commandant-relay.fly.dev/publish` with that token. No custom
domain: the hostname is never user-facing, so it is one less DNS record.

One instance only. Viewers must reach the same process the hub publishes to, and
the current frame is held in memory. Scaling out would need a shared bus first,
which is not worth it until several flights run at once.

## What it deliberately does not do

- **No storage.** Flight history lives in Guppi, which is the data plane and has
  the viewer for it. The relay forwards and forgets.
- **No viewer auth.** What is on screen is an aircraft flying, not secrets.
  Publishing needs a token; watching does not.
- **No interpretation.** Payloads are forwarded verbatim; the relay reads only
  the `type` field to decide what to retain for late joiners.

## Tests

```sh
uv run pytest -q
```
