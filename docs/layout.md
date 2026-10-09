# Console layout

The viewport is the instrument. The 3D world is what the operator is actually
reading, and every panel is a hole in it. This file records the screen budget so
it stops being rediscovered each time someone adds a feature.

Enforced by `src/__tests__/viewportChrome.test.ts`. If you change the budget,
change that test deliberately rather than deleting the assertion.

## The budget

```
┌────────────────────────────────────────────────────────────┐
│ ⬡ COMMANDANT        ⚠ alerts (warning+)              [◫]  │
│       ╷    ╷    ╷    N    ╷    ╷    ╷                      │
│      340  350   ▼  000   010  020                          │
│  ╷ 16                                       218 ╷   ┌──┐   │
│  ╷ 15                                       216 ╷   │◫ │   │
│  ╷ 14                                       214 ╷   │◉ │   │
│ ▐│ 13├─              (globe)                ┤ 212 │▌ │▤ │   │
│  ╷ 12                                       210 ╷   │↗ │   │
│  ╷ 11                                       208 ╷   │⬡ │   │
│  ╷ 10                                       206 ╷   └──┘   │
│   m/s IAS                              m MSL / AGL         │
│   ╭───╮                                                    │
│   │─┼─│  4° R  -4°                                         │
│   ╰───╯                                                    │
│ ● LINK alive │ MODE AUTO.LOITER │ WIND 0.1 │ SOC 82%       │
└────────────────────────────────────────────────────────────┘
```

| Region | What lives there | Area cost |
|---|---|---|
| Everywhere | Instruments drawn as strokes: two tapes, the heading tape, the attitude ball | None; all of it is transparent to the mouse |
| Top left | Wordmark, and the `watching` badge on the hosted viewer | One line |
| Top centre | Transient alerts, warning severity and worse | Only while alerting |
| Top right | Cesium's scene-mode toggle | One button |
| Right edge | The dock, 36 px, one panel at a time | A gutter |
| Bottom left | The 92 px attitude ball, above the strip | One small disc |
| Bottom edge | The editable telemetry strip | One or more rows, operator's choice |

Nothing is pinned to the left edge. No instrument sits in a box.

## The instruments

`components/flight/Hud.tsx`, with all geometry in `lib/hud.ts` and tested in
`__tests__/hud.test.ts`.

A full cockpit HUD lived here briefly: a screen-height pitch ladder, horizon and
flight path marker through the centre of the globe. It was removed because the
metaphor is wrong for this application. A cockpit HUD exists because the pilot
cannot see their own aircraft. Here the operator is watching the aircraft from
outside, on a globe, and the 3D model already banks and pitches in front of them,
so the ladder spent the most valuable part of the screen restating what the scene
was already showing.

What is left is what the globe genuinely cannot say.

- **Speed tape** left: airspeed when the vehicle reports it, groundspeed
  otherwise, labelled so the two can never be confused. On a solar aircraft in
  wind they differ a lot.
- **Altitude tape** right: MSL, with AGL beneath it coloured by clearance band.
  MSL alone does not answer whether the aircraft clears the hill.
- **Heading tape** across the top: cardinals as letters, exact bearing under the
  pointer.
- **Attitude ball** bottom left, 92 px: horizon, a countable pitch scale, bank
  ticks on the rim and a fixed aircraft reference, with roll and pitch in degrees
  written underneath. Same conventions as a cockpit instrument, so the horizon
  rotates by minus the bank angle and moves down as the nose comes up.

When attitude is missing or the link is down the ball says so rather than
drawing a level horizon, because a frozen instrument is read as truth.

The ball's scale and its cull margin have to be chosen together. At the first
scale tried, the labelled marks fell outside the disc and the ball showed a
horizon and two anonymous ticks. There is a test for that.

## Alerts

`lib/alerts.ts` decides what interrupts; `components/flight/Alerts.tsx` draws it.

Moving the status log behind the dock opened a safety hole: PX4 announces
failsafes, geofence breaches and refused mode changes through `STATUSTEXT`, and a
message that only lands in a closed panel is one the operator learns about from
the aircraft's behaviour instead.

The line is at warning severity. PX4 is chatty at notice and info, and an alert
that fires on routine chatter is one the operator learns to ignore, which is
worse than not having it. Errors and worse do not auto-dismiss. The dock's status
log remains the full record.

## The dock

`components/flight/Dock.tsx`. Instruments and health, view and overlays, status
log, and on the cockpit build mission, geofence, parameters and airframe.

One panel at a time, because two open panels is a rail again. It closes on
Escape, on a second click of its icon, and on a click on the globe. That last one
listens in the capture phase: Cesium stops propagation on its canvas, so a
bubbling listener never sees the click and the panel would stay open exactly
where it is most in the way.


## Render quality

`lib/renderQuality.ts`. Cesium's defaults are tuned for a demo on an idle
machine: 4x MSAA, an FXAA pass on top of it, and terrain refined to a 2 px
screen-space error. None of those were chosen; they were never set.

This console runs beside a SITL simulator that takes three of eight cores, in a
browser also holding a 25 Hz websocket. Measured in a headless Chromium with the
frame rate cap removed, so frame time is actually scene-bound, three trials each:

| | Cesium defaults | chosen |
|---|---|---|
| Frames per second | 60.5 | 122.0 |
| Frame gap, 95th percentile | 34.6 ms | 13.9 ms |
| Frame gap, worst | 52.4 ms | 30.4 ms |
| First-load transfer | 4508 KB | 2857 KB |
| First-load requests | 364 | 212 |

Twice the frame headroom and 37 per cent less traffic. Fog stays on: it is how
the globe reads as having depth, and the day/night lighting depends on the same
haze.

With the cap in place both arms sit at 60 fps, which is why the first attempt at
this measurement showed no difference at all. A vsync-capped frame rate measures
nothing about headroom.
