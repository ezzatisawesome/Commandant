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
| Right edge, under the ball | Cesium's scene-mode toggle | One button |
| Right edge | The dock, 36 px, one panel at a time | A gutter |
| Top right | The 92 px attitude ball | One small disc |
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
- **Attitude ball** top right, 92 px: horizon, a countable pitch scale, bank
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

With one exception, in `stores/authoring.store.ts`: while mission or geofence
map-edit mode is on, a click on the globe is the panel being *used*, not
dismissed. Placing a waypoint means clicking the globe, so dismissing on it
closed the panel holding Upload on every single point placed. Escape and the
dock icon still close it, so nothing is trapped open.

Panels draw their contents directly rather than carrying their own show/hide
button. Several still had one — a leftover from the rail the dock replaced —
which meant reaching the mission table took two clicks and the first one looked
like it had done nothing.


## Editing a plan on the globe

`components/flight/MissionLayer.tsx`, `components/flight/GeoLayer.tsx`, with the
drag arithmetic in `lib/grabbers.ts` and the hit-testing in `lib/pickTag.ts`.

A waypoint is drawn at **its own altitude**, on a vertical stem down to the
terrain. Markers used to sit at the aircraft's current altitude, which made every
plan look flat and left the number that matters most — how high the aircraft will
be at that point — reachable only as a figure in a table.

In edit mode each item grows grabbers:

| Handle | Gesture | Edits |
|---|---|---|
| ▲ above the marker | drag up/down | altitude |
| ring handle | drag in/out | loiter radius, or a waypoint's accept radius |
| fence corner | drag | that vertex |
| faint edge midpoint | drag | splits the edge, bending the boundary |
| circle rim handle | drag in/out | circle-fence radius |
| rally ▲ | drag up/down | rally altitude |

Two things make these work that are easy to get wrong:

**Up is not screen-up.** A vertical drag is resolved along the local vertical *as
it projects on screen*, sampled by projecting the item at its altitude and again
100 m higher. Tilt the camera and height travels mostly sideways; look straight
down and it collapses, where the code refuses to guess rather than turning a
pixel of jitter into a kilometre of altitude.

**Handles hide inside their own geometry.** Hit-testing uses `scene.drillPick`,
not `scene.pick`. Fences are drawn as walls and cylinders over their own vertex
markers, so the topmost primitive under the cursor is the volume, whose entity
carries no tagged id — `pick` returned the wall, the drag never armed, and a
boundary simply could not be adjusted. A circle's centre marker sits inside its
cylinder and was unreachable at any camera angle. The handles also set
`disableDepthTestDistance`, so one behind terrain stays clickable.

Adding a fence vertex inserts it *into* the ring (`insertFencePointAfter`) rather
than appending. Appending lands the new vertex at the end of the run, which on a
closed ring draws a spur across the polygon instead of a bend in the edge the
operator grabbed.


## Command authority

gs accepts a mission/fence/rally upload or a parameter write only from the single
active commander, and grants that to the **first** claimer until its socket
drops. A second console tab, or a reload that raced the old socket's close,
therefore holds no authority — and every upload comes back `not commander`.

The console claimed once, silently, on connect, with no way to ask again: the
only cure was to find and close the other window, with nothing on screen saying
so. Now `$commander` is mirrored from the claim reply *and* from every rejected
upload (the ack is the only place a later loss shows up), the panels name the
reason a greyed-out Upload cannot be pressed, and `takeCommand()` re-bids on
demand behind a "Take command" button.

A disabled control that explains nothing is indistinguishable from a broken one,
which is exactly how this read.


## Performance

Every number here was measured on an Apple M1 through ANGLE's Metal backend
(confirmed by reading the renderer string, so a software rasteriser cannot pass
itself off as a GPU result), against a live link, with the aircraft's position
asserted to have actually changed during the window. Frame rate is measured with
the frame-rate cap removed, because a vsync-capped 60 fps measures nothing about
headroom.

Two earlier claims in this file were wrong and are recorded here as such, since a
retracted measurement is more useful than a quietly deleted one.

### Render settings: real, 2x headroom

Cesium's defaults are tuned for a demo on an idle machine, and for a scene that
might be viewed from orbit. `lib/renderQuality.ts` chooses instead.

| | Cesium defaults | shipped |
|---|---|---|
| Frames per second | 68.8 | 132.0 |
| Frame time, median | 14.30 ms | 7.40 ms |
| Frame gap, 95th percentile | 32.9 ms | 12.1 ms |

Attributed by toggling one setting at a time, from a 14.10 ms baseline frame:

| Change | Saved per frame |
|---|---|
| MSAA 4 to 1 | 4.70 ms |
| FXAA off | 1.90 ms |
| Screen-space error 2 to 3 | 0.40 ms |

The terrain change was **reverted**: 0.40 ms is inside run-to-run noise, and it
buys coarser terrain for it.

Dropping the star-field cube map saves 715 KB and six requests on every cold
load, verified by watching for the requests and confirming none are made. The
atmosphere and the day/night lighting are untouched.

### Render rate: real, 31% less CPU

`lib/driveRendering.ts` caps data-driven renders. Lowering that cap from 30 to 15
per second, with the CPU throttled 4x to stand in for the simulator next door:

| | 30 fps cap | 15 fps cap |
|---|---|---|
| Script time per 10 s | 7.34 s | 5.06 s |
| All task time per 10 s | 8.56 s | 6.11 s |

Cesium's per-frame scene update is the dominant main-thread cost in this
application, and it scales with how often a frame is requested. Camera drags and
tile loads bypass this cap, so interaction is unaffected.

### Retracted: the bandwidth claim

An earlier version of this file said the render settings cut first-load traffic
by 37%. **They do not.** That figure came from `content-length`, which most
responses here omit, and from an A/B that toggled the terrain setting *after* page
load, so both arms had already fetched identical tiles. Measured properly, with
the setting baked into two separate builds and a cold browser context per trial:

| | defaults | chosen |
|---|---|---|
| First-load encoded | 7331 KB | 7369 KB |
| Terrain and imagery | 6203 KB over 223 requests | 6241 KB over 223 requests |

Indistinguishable. The tile set at this camera is governed by the terrain
provider's available levels, not by the screen-space error.

### Retracted: the HUD cost claim

One throttled run suggested the instruments cost 8.4 ms per frame. A repeat run
of the same harness reported that *removing* them made the page slower, which is
impossible, so the harness was noise-dominated at high throttle and the
attribution was worthless.

Measured properly, as main-thread CPU time over a fixed window rather than frame
rate, quantising the instrument inputs and memoising each instrument gives:

| | unquantised | quantised |
|---|---|---|
| Script time per 10 s | 7.10 s | 7.34 s |
| Style recalculation | 0.170 s | 0.056 s |

Script time is unchanged. Style recalculation is 3x lower, which is 1% of total
task time. The change was kept — it is cheap, it removes sub-pixel jitter from
the tick marks, and the style saving is real — but it is not a significant
performance win and should not be described as one.

### Not worth doing: the wire format

The telemetry frame is 1227 B of JSON at 24 Hz, which looks like an obvious
target for delta encoding. It is not. `permessage-deflate` is already negotiated
on both hops, and measured at the socket:

| Path | Wire per frame | Rate |
|---|---|---|
| Daemon to browser, compressed | 221 B | 5.1 KB/s |
| Daemon to browser, uncompressed | 1232 B | 28.7 KB/s |
| Public relay, compressed | 267 B | 1.3 KB/s |

Sending only changed fields would be 636 B before compression, and deltas
compress worse than whole frames because they break the repetitive structure
deflate exploits. Of 50 fields, 15 never change at all across 200 frames — and
deflate already handles exactly that.

### Where the remaining weight is

First cold load is 7.3 MB. The breakdown, so nobody optimises the wrong thing:

| | Size | Requests |
|---|---|---|
| Terrain tiles | 3278 KB | 100 |
| JavaScript | 1218 KB | 57 |
| Terrain availability index (`layer.json`) | 899 KB | 1 |
| Imagery and other tiles | 899 KB | 78 |
| Approximate terrain heights | 97 KB | 1 |

The largest single file is an 837 KB JavaScript chunk, which is Cesium. Cutting
it means importing engine modules directly instead of the umbrella package, and
Cesium tree-shakes poorly; it is a real but large piece of work with an uncertain
payoff, and all of it is cached after first load.
