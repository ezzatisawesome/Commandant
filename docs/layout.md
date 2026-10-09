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
│             ·    ·   ─┴─   ·    ·                          │
│  ╷ 16                                       218 ╷   ┌──┐   │
│  ╷ 15     20 ─────             ───── 20     216 ╷   │◫ │   │
│  ╷ 14                 ┌───┐                 214 ╷   │◉ │   │
│ ▐│ 13├── ─────────────┤ + ├───────────── ──┤ 212 │▌ │▤ │   │
│  ╷ 12                 └───┘                 210 ╷   │↗ │   │
│  ╷ 11    -20 ─────             ───── -20    208 ╷   │⬡ │   │
│  ╷ 10                                       206 ╷   └──┘   │
│   m/s IAS                              m MSL / AGL         │
│ ● LINK alive │ MODE AUTO.LOITER │ WIND 0.1 │ SOC 82%       │
└────────────────────────────────────────────────────────────┘
```

| Region | What lives there | Area cost |
|---|---|---|
| Everywhere | The HUD, drawn as strokes | None; it is transparent to the mouse |
| Top left | Wordmark, and the `watching` badge on the hosted viewer | One line |
| Top centre | Transient alerts, warning severity and worse | Only while alerting |
| Top right | Cesium's scene-mode toggle | One button |
| Right edge | The dock, 36 px, one panel at a time | A gutter |
| Bottom edge | The editable telemetry strip | One or more rows, operator's choice |

Nothing is pinned to the left edge. No instrument sits in a box.

## The HUD

`components/flight/Hud.tsx`, with all geometry in `lib/hud.ts` and tested in
`__tests__/hud.test.ts`. It is fixed to the screen centre: the symbology stays
still and the world moves behind it, which is how a real HUD works and what keeps
it readable at any camera angle or zoom.

It replaced a boxed attitude indicator and compass in the corner. Those were a
picture *of* the aircraft; this is the view *from* it, and it costs no area.

- **Horizon and pitch ladder** rotate by minus the bank angle and translate by
  the pitch, so a climb pushes the horizon down the screen. Dive rungs are
  dashed, climb rungs solid.
- **Bank scale** is a fixed arc with a moving pointer, denser near level.
- **Aircraft reference** never moves. Everything else is read against it.
- **Flight path marker** shows where the aircraft is actually going: drift
  horizontally, climb angle vertically. It hides below 2 m/s, where the angle is
  noise.
- **Heading tape** across the top, cardinals as letters, with the exact bearing
  under the pointer.
- **Speed tape** left, airspeed when the vehicle reports it and groundspeed
  otherwise, labelled so the two can never be confused.
- **Altitude tape** right, MSL, with AGL beneath it coloured by clearance band.
  MSL alone does not answer whether the aircraft clears the hill.

When attitude is missing or the link is down the HUD says so where the horizon
would be. It does not draw a level horizon, because a frozen HUD is read as
truth.

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
