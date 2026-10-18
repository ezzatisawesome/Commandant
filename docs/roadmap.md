# Commandant — Implementation Roadmap

Status: **draft** · Last updated: 2026-10-02

Turning Commandant from an ingest-only telemetry viewer into a real
QGroundControl-replacement GCS for the solar aircraft.

**Progress (2026-10-06):** checklists below were reconciled against the code —
22 items were implemented but still showed unticked. What genuinely remains is
Phase 3 (SIL rehearsal), param snapshots, real-Pi hub validation, one DNS record,
and Guppi egress. Two Phase 5 items were dropped on purpose, not forgotten.

**Progress (2026-10-03):** Monorepo (`packages/console` + `packages/gs` +
`packages/cli`), all on `main`. **Phases 0, 1, 2, 4, 5 done** — commands, params,
health/STATUSTEXT, configurable display, and mission planning, all validated
end-to-end against **live PX4 SITL** (telemetry, arm round-trip, 956-param sync,
and a takeoff→waypoints→RTL mission upload+readback; a live-only frame bug on RTL
was caught and fixed). Hub = `commandant` CLI scaffolded. Geofence + rally, PX4 param metadata
(units/range/validation), and `claim`-confirm authority are done and
live-validated (fence+rally upload/readback against SITL). **Not yet done:**
Phase 3 SIL-rehearsal (real-aircraft gate) and real-Pi hub validation.

**Flight-readiness pass (2026-10-17):** six faults that only appear when the
link is a real radio, or when PX4 is driven by HITL rather than the sim's JSON
feed. Each was hypothesised, proved with a test that fails on the old code, then
fixed (`packages/gs/tests/test_flight_ready.py`, 14 tests).

1. **gs never identified itself as a ground station.** No GCS HEARTBEAT was
   transmitted, ever. PX4 decides a datalink exists by *receiving* heartbeats
   from a GCS (`telemetry_status.heartbeat_type_gcs` → commander's
   `data_link_check`), so to PX4 our GCS was never there: it reports "Data link
   lost" while the operator watches telemetry flow. **Checked against the PX4
   metadata this repo already bundles** rather than assumed: `COM_DL_LOSS_T`
   defaults to 10 s (the threshold exists for exactly this) and `NAV_DLL_ACT`
   defaults to **0, "Disabled"** — so on a stock airframe the consequence is a
   wrong and visible commander state, not an automatic failsafe. Set
   `NAV_DLL_ACT` to Hold/Return/Land/Terminate, which a BVLOS operator may well
   do, and the failsafe does run, on a healthy link. (An earlier draft of this
   entry called that configuration "the norm". It is not the default, and
   finding that out is the argument for reading the bundled metadata instead of
   asserting.) Either way a GCS that never heartbeats is lying to the autopilot
   about its own presence, and every real one emits 1 Hz. gs now emits 1 Hz as
   `MAV_TYPE_GCS`/`MAV_AUTOPILOT_INVALID`, serviced before anything else on the
   mav thread.
2. **Stream requests ignored the link's bandwidth.** The three messages PX4
   omits from the GCS stream were requested at a hardcoded 25 Hz. MEASURED:
   6675 B/s, **133 % of a 57600 SiK link's usable goodput**, before PX4's own
   ~1.2 kB/s — and what a saturated radio drops is `COMMAND_LONG` and
   `STATUSTEXT`. Rates now come from a per-transport budget
   (`link_budget_bps`/`budgeted_hz`): unchanged 25 Hz on UDP/TCP/USB, 1.9–5.5 Hz
   on a 57600 radio, holding gs to 25 % of the link. An operator's explicit
   `stream` request is clamped the same way, and says so on `statustext`.
3. **Transport writes happened under the telemetry lock.** `_on_mav` ran its
   whole dispatch inside `with self._lock`, and several branches transmit from
   there. On UDP a send is a memcpy; on the hub it is a serial write. MEASURED:
   one 150 ms blocking write stalled the 25 Hz broadcast tick **458 ms**, and
   the broadcast loop is the asyncio loop, so every console's WS ping stalls
   with it. `_on_mav` is now split: `_on_mav_state` folds into `latest` under
   the lock, `_on_mav_protocol` runs the state machines and all I/O after it.
4. **The sim's JSON feed outranked a live autopilot.** The flightlink feed is
   documented as the *no-PX4* path but nothing enforced it; in HITL both are
   live and it wrote lat/lon/alt/attitude/**mode/armed** over MAVLink's values
   with no arbitration. The two interleave, the aircraft jitters between
   estimate and truth, and `armed` from the sim can contradict the autopilot the
   operator is commanding. Once a vehicle is locked MAVLink owns flight state;
   JSON keeps `JSON_ONLY_KEYS` (the power model, the sim's own wind, the two PX4
   SITL fakes already TTL-arbitrated). With no vehicle locked, nothing changes.
5. **The vehicle lock never released.** `_vehicle` locks onto the first
   autopilot heartbeat — right on a live link, a trap across a reopen: swap the
   USB autopilot for a radio to an aircraft with a different `MAV_SYS_ID` and
   every message from it is dropped, the console shows `connecting` forever with
   a healthy radio, and commands keep going to a sysid that is not there.
   `_on_reopen` now clears the lock, the boot-ms watermark and the stream-request
   throttle.
6. **The MAVLink 2 dialect depended on import order.** `MAVLINK20=1` only takes
   effect if nothing has imported `mavutil` first, because mavutil binds
   `mavutil.mavlink` to a dialect module at its own import time. Anything that
   gets there first — the Phase 3 rehearsal gateway importing AircraftSim, a
   test, a REPL — silently left the daemon on the v1 dialect, where
   `ACTUATOR_OUTPUT_STATUS` and `WIND_COV` do not exist: the actuator PWMs and
   the EKF wind estimate are simply never populated, with no error. The dialect
   is now rebound explicitly.

**The relay's slow-viewer protection was dead code (2026-10-18):** the relay
documents four constraints in priority order, and the third — "a slow viewer
cannot affect the hub or other viewers" — was implemented in a `_fan_out`
helper that **nothing ever called**. Every broadcast went through
`websockets.broadcast` instead, so `SLOW_VIEWER_BYTES` was unreachable and
`frames_dropped` was permanently 0, which made the `/healthz` figure a
reassuring lie as well.

That matters because `broadcast` is explicitly not flow-controlled. Its own
documentation: *"pushes the message synchronously to all connections even if
their write buffers are overflowing. There's no backpressure... messages will
pile up in its write buffer until the connection times out. Keep
`ping_interval` and `ping_timeout` low to prevent excessive memory usage from
slow connections."* This is the only Commandant component on the public
internet, viewers are unauthenticated, and it runs on one always-on Fly machine
— so a phone on bad cell data watching a 5 Hz stream grows a buffer inside the
relay process, and anyone can open one.

`broadcast` is still the right primitive (one serialisation, no awaiting, so no
viewer can delay another). What was missing was getting rid of a viewer that
cannot keep up, which is also the better outcome for that viewer: it reconnects
and gets the retained state — a correct current screen — rather than a backlog
of frames superseded while they sat in a queue. The ping cycle went 20 s → 10 s
too, since that is the other half of the defence the library recommends: a
stalled socket is only reclaimed when its ping times out, and 20 s each meant up
to 40 s of stream buffered per dead-but-unclosed viewer. The test now pins the
*call site*, not just the helper — the bug was never a wrong check.

**A flight command gs could prove was malformed (2026-10-18):** `reposition`
built its MAVLink params from `args.get("lat", NaN)`, so an omitted or
non-finite coordinate went out as a NaN position — "fly to here" with no here,
sent to an aircraft, for PX4 to interpret however it does. A `takeoff` with
`alt: -50` went out as a takeoff to 50 m below the launch point. Both now raise,
and the refusal reaches the operator as a `not ok` ack under the command's own
id rather than a dropped message, because they clicked something.

A missing *altitude* on a reposition is deliberately still fine: NaN there means
"keep the current one", which is a real request. Same principle as the geofence
check — gs is the last thing between a malformed request and the vehicle, so it
refuses what it can prove wrong instead of forwarding it and hoping the
autopilot objects.

**A quick reboot froze the aircraft permanently (2026-10-18):** found by the
day-in-the-life rehearsal the moment a reboot was injected into it — and
pre-existing, not introduced by this pass.

A backward `time_boot_ms` jump is either a reordered frame or a reboot, and the
rule was "a gap of at least `REBOOT_GAP_MS` is a reboot, anything smaller is a
reorder". So a vehicle that had been up 1.6 s and restarts at 0.2 s gives a
1.4 s gap, and **every post-reboot frame is dropped as reordered**:
`_last_pos_boot_ms` never advances, the position freezes permanently, and
heartbeats keep `linkState` green the whole time. The
stale-aircraft-shown-as-live failure yet again, and it takes a bench
power-cycle or a HITL restart to hit — which is to say it happens constantly.

| vehicle up | restarts at | gap | before |
|---|---|---|---|
| 600 s | 0.2 s | 599.8 s | reboot seen |
| 6 s | 0.2 s | 5.8 s | reboot seen |
| 3.5 s | 0.2 s | 3.3 s | **dropped, frozen forever** |
| 1.6 s | 0.2 s | 1.4 s | **dropped, frozen forever** |
| 1.6 s | 1.4 s | 0.2 s | dropped — correct, a real reorder |

Below `REBOOT_GAP_MS` the two are now told apart by two further signals, because
one frame genuinely is not enough: a reorder moves the clock back by a fraction
of the uptime while a reboot takes it to near zero (so a candidate must have
lost more than half of it), and a reorder is a blip in an ascending stream while
after a reboot the stream **ascends from the new low value** (so a candidate is
held for one frame and confirmed only when the next continues from it). A lone
low outlier, and runs of reorders, both stay dropped.

The unit tests missed this because they all used ten minutes of uptime. The
rehearsal caught it because its fat-pipe run finishes in 3.5 s, so the injected
reboot landed inside the window — the argument for having a test that walks the
real sequence at real speeds rather than only poking state machines.

**A plan that leaves its own geofence (2026-10-18):** `missionCheck.ts` already
predicts the one refusal PX4 announces only through STATUSTEXT — a plan missing
the takeoff/landing items `MIS_TKO_LAND_REQ` demands. It did not predict the
other one. PX4 enforces the geofence **in flight, not at upload**: a mission
whose waypoints lie outside the inclusion fence, or inside an exclusion one,
transfers cleanly and acks `accepted`, and then breaches mid-mission. `GF_ACTION`
defaults to **2, Hold mode** (read from the bundled metadata, not assumed), so
the aircraft flies the plan until it breaches and then stops and loiters out
there. Both halves of that plan were "accepted".

`missionFenceProblem` names the first offending waypoint before the upload, and
`planProblem` composes the two checks — the takeoff/landing requirement first,
since that is the one the operator hits earliest and the cheaper of the two to
fix.

It needed new geometry rather than the existing `fenceProximity`, which answers
"what shape is nearest". A waypoint can sit comfortably inside the inclusion
polygon *and* inside an exclusion circle; if the inclusion edge is closer, the
nearest shape is the compliant one and the violation is invisible. The
run-slicing both need is now shared, so the readout and the check cannot
disagree about what the shapes are.

**A day in the life, rehearsed (2026-10-18):** `scripts/day_in_the_life.py`
walks the sequence an operator actually walks — link up, take command, read
params, write one, upload a geofence and read it back, upload a mission and read
it back, arm, AUTO.MISSION, watch progress, fly-to-here, RTL, disarm — once, in
order, against a simulated autopilot behind a simulated radio. `radio_soak.py`
hammers one operation to find where a state machine breaks; this asks whether
the whole day works, and the two find different things, because most of these
steps only interact when done in order on one link.

| link | result |
|---|---|
| fat pipe (SITL / HITL / USB) | **17/17 ok, 3.5 s** |
| 3.4 kB/s SiK, 120 ms, 3 % loss | **17/17 ok, 32.3 s** |
| same at 8 % loss | **17/17 ok, 44.4 s** |
| same at 15 % loss | 16/17 — only the param refresh outran its 25 s budget (it takes 20–22 s at 3–8 %); every *flight* operation still completed |

Every fix from these passes shows up in that run, in sequence: autodetect brings
the link up with no configuration, PX4 receives GCS heartbeats (33 of them),
the paced refresh takes 20 s and the param write immediately after it still acks
in **0.20 s** — which is the contention fix working rather than asserted — the
fence reads back with the vertex count gs derived, and arm / mode / reposition /
RTL / disarm all ack under 350 ms on the radio.

**It also caught itself being wrong twice**, which is the argument for having
it. Its first run reported `ok` for a param write whose ack said `timeout`,
because arriving was all it checked — a rehearsal that passes a failed flight is
worse than none, so a step is now judged on the reply's `ok`/`error`. And the
failure it then surfaced was the harness: the stand-in autopilot had no
`PARAM_SET` handler, and dropped `param1..4` through a mission round trip, which
is why the fence came back with no vertex count at all.

**Stream control was not authority-gated (2026-10-18):** `stream` is labelled a
display preference, and is not one: it sends `SET_MESSAGE_INTERVAL`, which
changes what the *vehicle* transmits, for every client, out of a shared and
finite link budget — and it was open to any phone on the hub's WiFi. That is the
param-refresh contention above with a different trigger. The rate clamp bounds
the damage; the authority question is separate, and a write to the aircraft
belongs to the console holding command. It is commander-only now, and the
console's request carries an `id` so a refusal or a clamp is visible — sent
fire-and-forget, both were invisible and the operator just saw nothing happen.
The Apply button is also disabled, with the reason, when authority is elsewhere.

**The relay uplink on a flaky hotspot (2026-10-18):** the documented claims —
never block the 25 Hz loop, never grow unbounded — hold. MEASURED with no uplink
and 5000 frames plus 5000 events offered: one telemetry slot (latest-wins) and
the event queue at its 256 cap, dropping oldest; 9743 dropped and nothing
retained that was superseded. `offer()` is also a no-op before the uplink task
exists and swallows a closed loop, so it cannot raise into the mav thread.
Pinned by tests rather than left as a comment.

One real fault: `startedAt` on the `flight` message was stamped at **connect**
time, and `flight` is re-announced on every reconnect *and* retained by the
relay for late joiners. A hotspot that drops every few minutes kept moving the
flight's start forward, so a viewer opening the hosted page three hours in was
told the flight began seconds ago. Captured once at construction now.

**"Take command" could not take command (2026-10-18):** gs granted authority to
the first claimer and held it until that socket dropped. The hub's premise is
"join the WiFi, open the page", so several people do — and whoever loaded first
held command. A phone in a pocket with the page open keeps answering gs's 5 s
pings, so its socket never drops and the pilot at the laptop could not get
authority: every command, mission upload and param write refused. The console
had grown a "Take command" button for exactly this, and it re-sent a plain
`claim`, which gs refused for the same reason it refused the first one — a
button that could not do the thing it was named after, with the only real cure
being to find the other person.

`claim {force: true}` is now an explicit takeover, and the console sends it only
from that button; the bid on page load stays a plain claim, so a browser opening
can still never pull authority from someone who is flying. The displaced console
is told with a new `commander` message and greys out, instead of discovering it
from every action being rejected.

**Long-flight and per-stream staleness (2026-10-18):** three findings aimed at
the stated target of a flight that lasts days.

- **A stopped stream was redrawn as a live reading.** `dataAgeMs` answers "is
  the aircraft still talking"; it cannot answer "is this number still true".
  A frame's fields arrive on different messages at different rates, and three of
  them are messages gs had to *ask* for. When one stops, its last value stays in
  the frame forever, indistinguishable from a live one — so losing the airspeed
  sensor takes EKF2's wind estimate with it and the operator keeps being shown
  the last wind the aircraft ever saw as the current wind. On an airframe that
  stays up on wind and sun that is the worst number on the panel to be quietly
  wrong. Frames now carry a per-message-group `ages` map, a never-seen group is
  absent rather than 0, and the strip shows a cold wind as `cold` in amber with
  the age in its tooltip.
- **The uptime counter wraps at 49.7 days.** `time_boot_ms` is uint32 ms, and
  this airframe is meant to stay up for days to weeks, so the wrap is a flight
  event. At the wrap the counter jumps from ~2³² to near zero — exactly what a
  reboot looks like — which would have abandoned every in-flight handshake and
  told the console to throw away its param cache, with a warning saying the
  aircraft restarted, 49.7 days into a healthy flight. A wrap is now told apart
  from a restart by where the counter was.
- **Checked and not a fault: accumulation.** 400 rounds of churn over the
  command / param / mission / client registries leaves them all empty, and an
  ack route belonging to a tab that closed mid-command is released even though
  the send fails. The console's status log is a bounded ring (200) and both
  trails are chunk-capped, so nothing there grows either.

**A param refresh starved the commands (2026-10-18):** `PARAM_REQUEST_LIST`
hands the pacing to the autopilot, which sends all ~1000 values as fast as the
link will carry. MEASURED on a 3.4 kB/s / 120 ms SiK link with a 400-param set:

| | idle link | 1 s into a refresh |
|---|---|---|
| **before** | arm acked 0.71 s | **arm 3.02 s, `ok=false`** — retries exhausted, reported `timeout` on a healthy link |
| **after** | arm acked 0.70 s | arm acked **0.33 s, `ok=true`** |
| localhost UDP | 0.08 s | 0.09 s — the contention is invisible at 1 MB/s, which is why this never showed |

On a narrow link gs now walks the indices with `PARAM_REQUEST_READ` at a rate it
chooses (30 % of the budget), so the refresh cannot monopolise the downlink. For
1000 params on that radio the trade is 10.7 s using 100 % of the link, commands
failing, against 35.7 s using 30 %, commands working — not a close call for a
ground station. A fat pipe (SITL, HITL, PX4 over USB) keeps the flood unchanged.

`--link-budget BYTES_PER_SEC` pins the budget, because a UDP socket says "fat
pipe" and that is a lie exactly when mavlink-router sits between gs and a radio
— the deferred-router case in this document. Without the pin gs would ask a
57600 link for 25 Hz streams and a param flood. The pin survives a reopen.

**Found in the tool, not the daemon:** `radio_soak.py` opens a UDP socket to
reach its simulated radio, so gs inferred a fat pipe and made every fat-pipe
choice. The tool was measuring the wrong configuration, and only got caught
because it reported no improvement from a fix that could not possibly have
engaged. It now pins the budget.

**A regression this pass introduced, and the test that caught it:** moving
durations onto a monotonic clock broke the `0` = "never happened" sentinel.
Under the wall clock `now - 0` was ~1.7e12 ms, so "never" read as "long ago"
and every `now - last >= TIMEOUT` test fired. Measured from daemon start,
`now - 0` is just the uptime — so for the daemon's **first second** everything
was suppressed: no first GCS heartbeat, a command queued at startup not
transmitted, the stream requests skipped. `_mono_ms` now counts from an origin
an hour above zero, which restores the old meaning without the wall clock.

**Mission upload over a real radio (2026-10-17):** a seventh fault, found by
building the thing that could find it — `packages/gs/scripts/radio_soak.py`,
which runs the real command/param/mission state machines across a simulated
telemetry radio (bandwidth, one-way latency, packet loss). Every timeout and
retry constant in `bridge.py` was tuned against localhost UDP, where latency is
~0 and loss is 0.

A stalled upload re-sent `MISSION_COUNT`. Per the MAVLink mission protocol that
makes the autopilot **discard the transfer and restart at seq 0**, so one lost
frame cost the whole mission again. Worse, that restart counted as progress and
reset `tries` to 0 — so the retry budget never ran out and the operation
**livelocked**: MEASURED at 5 % loss on a 3.4 kB/s / 120 ms link, 21–39
`MISSION_COUNT` kickoffs, no completion, and *no timeout ever reported*. The
console sits on "uploading" forever with nothing to act on, which is worse than
a clean failure.

A stall mid-transfer means exactly one packet was lost — the autopilot's
`MISSION_REQUEST_INT`, or our `MISSION_ITEM_INT` answering it — so gs now
retransmits that one item and keeps `MISSION_COUNT` for the single case it is
right for: the autopilot never answered the kickoff at all. A hard cap on
kickoffs bounds the class, so a restart loop can never be unbounded again
whatever induces it.

| 40-item upload, 3.4 kB/s / 120 ms | before | after |
|---|---|---|
| 5 % loss (3 seeds) | 10–39 kickoffs; 2 of 3 never completed | **1 kickoff, 11–20 s, 3/3 ok** |
| 10 % loss (3 seeds) | — | **1 kickoff, 18–27 s, 3/3 ok** |

**Known limits, measured** (3.4 kB/s / 120 ms, 40-item mission, 400 params).
Past 10 % loss things fail, and the point of the table is that they now fail
*loudly* — a reported `timeout` the operator can act on, not a livelock:

| loss | arm | mission upload | param refresh |
|---|---|---|---|
| ≤ 5 % | ok, <1.5 s | ok, 11–20 s | ok, ~10 s |
| 10 % | ok, 0.3 s | ok, 21 s | ok, 12.7 s |
| 20 % | ok, 0.3 s | **timeout at 31 s** | ok, 27.8 s |
| 30 % | **timeout at 3.2 s** | **timeout at 6.7 s** | ok, 31.7 s |

Arm gets `CMD_MAX_TRIES × CMD_RETRY_MS` = 3 s, which is why it is the first
thing to go. That was left alone deliberately: 20–30 % loss is not a usable
flight link, and retuning retry constants to survive it would be fitting them to
an extreme at the cost of how fast a real failure is reported.

**Not a problem, checked:** the 25 Hz telemetry broadcast. 861 B/frame, 11.5 µs
to serialise, 21 kB/s and 0.03 % CPU per client; six clients on the hub come to
126 kB/s, ~6 % of what a Pi's WiFi sustains. 38 % of each frame is fields that
actually move at 25 Hz, so there is ~13 kB/s/client of redundancy — real, and
far too small to be worth a dirty-field protocol. Measured because it looked
like the obvious next optimisation; it is not one.

`radio_soak.py` is a soak tool, not a unit test — stochastic and minutes per
run, so deliberately outside the pytest suite. Run it when changing a protocol
state machine or any timing constant. It exits non-zero on a failure *or* on an
upload that was restarted rather than resumed, since a run that succeeds after
ten kickoffs still has the defect in it.

**Plug and play (2026-10-17):** `--mavlink auto` is the default. There is
deliberately **no distinction between a HITL rig and the aircraft** — gs only
ever sees MAVLink, and the one place the distinction leaked out was
configuration: the operator had to know the endpoint string and the baud before
anything worked. `auto` probes, most specific first, the serial devices an
autopilot actually appears on (`/dev/tty.usbmodem*`, `/dev/ttyACM*` at 115200 —
PX4 over USB; `/dev/tty.usbserial*`, `/dev/ttyUSB*` at 57600 — a telemetry
radio), then `udpin:0.0.0.0:14550` (SITL, HITL, mavlink-router) and
`tcp:127.0.0.1:5760` (SITL direct), and takes the first that heartbeats from
something claiming to be an autopilot — a ground station on the wire, including
gs's own heartbeat echoed by a router, is rejected. Nothing yet means PX4 is not
powered up: gs falls back to `:14550` and re-probes on every reopen, so bringing
the aircraft up, or swapping USB for the radio, is a hardware action rather than
a restart. The link budget is recomputed from whatever was found, so a radio
discovered by autodetect cannot get the fat-pipe rates. An end-to-end test
(`test_plug_and_play_end_to_end`) asserts the whole claim against a fake PX4
that is deliberately indistinguishable from HITL or the airframe: transport
discovered, PX4 hearing our heartbeat, telemetry on the socket, and an arm that
round-trips and changes the vehicle.

**Hardening pass (2026-10-05):** transport-chain audit + fixes, both ends.
gs: handler exceptions can no longer kill the mav thread; serial/TCP links reopen
with backoff; vehicle sysid/compid lock-on (foreign heartbeats ignored); PX4
byte-wise INT param encoding (INT32 values were displayed/written as garbage);
NaN-safe JSON; `params` batching; bounded param refresh with a `done`/`error`
marker; prompt failure on rejected PARAM_SET and mission-download NAK;
IN_PROGRESS acks relayed; malformed WS messages acked, not fatal. Console: null
fields can't crash the HUD (error boundaries per panel); HUD renders at 10 Hz off
a throttled store; trails decimated + `ArcType.NONE`; marker drags no longer
rebuild entities; fences clamp to terrain; unknown WS types dropped; reconnect
with backoff that keeps the trail; empty param field can't write 0. Tests: 46
daemon (pytest, fake-PX4 + unit), 10 relay, 39 console (vitest).

## Scope boundary (the two-plane rule)

Commandant owns the aircraft as a **flying vehicle** — flight/ops plane, MAVLink,
flight-rate. It does **not** write to power-system firmware (BMS, PowerBoard,
MPPT); that lives on the **T&M plane** and is Guppi's authority. See
`../AircraftSim/docs/ecosystem.md`.

- **Missions** → 100% Commandant.
- **Params** → split by owner: **PX4/autopilot params → Commandant** (MAVLink
  `PARAM_SET`); **power-system firmware params → Guppi** (agent-gated NATS relay).
- **Display** → both tools may *read* any telemetry. Ownership is about *who writes*.

Decision rule for any new feature: *does it change how it flies, or how a
component behaves under test?* Flies → Commandant/MAVLink. Component → Guppi/NATS.

## Target

SITL now, real aircraft later. Build against AircraftSim's PX4 SITL but keep the
link layer transport-general (UDP now; TCP/serial/radio-ready) so the same GCS
flies the real vehicle unchanged.

Reliability is the whole point: the connection / heartbeat / param-sync /
mission-handshake state machines are where a GCS's flakiness lives. We own these
state machines (pymavlink, not MAVSDK — see Architecture), so **every one gets
deterministic, tested handling against SITL** — this is non-negotiable, not a
nicety.

## Architecture

The link + command logic moves **out of the Next.js server** (`instrumentation.ts`)
into a **standalone, long-lived Python daemon** on **pymavlink**. A web framework
that hot-reloads must never own arm/disarm or a mission upload. The Cesium UI
becomes a thin client of the daemon over WebSocket/HTTP.

Commandant is now a **monorepo**:

```
Commandant/
  package.json            (npm workspace root)
  packages/
    console/              (Next + Cesium UI — thin client; was the repo root)
    gs/                   (Python pymavlink ground-station daemon)
  docs/roadmap.md
```

Decisions locked:
- **Language/core: Python + pymavlink. No MAVSDK.** We own the protocol state
  machines deliberately, so they can be made deterministic and tested against the
  sim. Reuse the arm / set_mode / takeoff / battery-injection patterns already in
  AircraftSim `src/px4/mavlink_io.py`.
- **Routing: no mavlink-router needed for SITL** (revised after inspection).
  AircraftSim's PX4 container already *dual-unicasts*: offboard → host `:14540`
  (the sim's `mavlink_io`) and a dedicated GCS stream → host `:14550` (the gs
  daemon), via `PX4_OFFBOARD_TARGET` / `PX4_GCS_TARGET` in `docker/entrypoint.sh`.
  The fan-out already happens at the PX4 level, so gs just binds `:14550`.
  mavlink-router is **deferred** to when a real radio delivers a single stream, or
  a second consumer (e.g. QGC alongside gs) must share one stream.
- **SIL-rehearsal is its own phase** (Phase 3): a command is not real-aircraft-
  eligible until it has been replayed against AircraftSim. Python colocation makes
  the daemon able to drive the sim directly for rehearsal.

```
PX4 SITL ─udp─> mavlink-router ─┬─> AircraftSim mavlink_io  (sim's own link)
                                ├─> Commandant daemon (pymavlink) ─WS/HTTP─> Cesium UI
                                └─> (QGC, optional, side-by-side)

command path:  UI → daemon → [authority gate] → [SIL-rehearsal vs AircraftSim] → pymavlink TX (+ACK) → router → PX4
```

The daemon's responsibilities: link/transport management, telemetry fan-out to
the UI, command ingress + authority gate, the protocol state machines (arm/mode,
param sync, mission), and the SIL-rehearsal gateway.

## Deployment — the hub

The field deployment is a **Raspberry Pi "hub"** that is both the ground station
and the base station. Turn the plane on; turn the hub on; join the hub's WiFi on
any phone/laptop; open the page; **you just see the plane, live.** No login, no
setup, multiple viewers at once.

```
   plane  ──radio/serial──►  HUB (Raspberry Pi)  ──WiFi──►  phones / laptops
                             • gs daemon (owns the radio link)        browser →
                             • serves the console web app             commandant.local
                             • standalone WiFi AP (hostapd)           → /flight, live
                             • mDNS: commandant.local (avahi)
```

Decisions:
- **Plane ↔ hub = radio/serial** → this is the `gs` transport abstraction
  (UDP/TCP/**serial**); on the Pi, `gs` attaches to the radio, not localhost UDP.
- **Hub ↔ clients = WiFi + browser.** `gs` binds `0.0.0.0`; the console's WS
  endpoint must be **host-relative** (`window.location.hostname`), so any client on
  the hub WiFi reaches the hub's `gs`. (Dev still falls back to localhost.)
- **Standalone AP** (hostapd/dnsmasq) — works in a remote field, no infrastructure.
- **mDNS hostname** `commandant.local` (avahi) — how clients get in. (Captive
  portal considered and deferred.)
- **Zero-config UX:** connect → `commandant.local` → root redirects to `/flight`
  → telemetry autoconnects → the plane is on the globe. No auth.
- **Hub = a `commandant` CLI** (`packages/cli`, modeled on Guppi's `packages/cli`):
  `commandant install` provisions a fresh Pi (hostapd + dnsmasq AP, avahi
  `commandant.local`, systemd units autostarting `gs` + the served console),
  `commandant update` re-runs the installer, plus `status` / `up` / `down` /
  `logs` / `uninstall`. AP/mDNS/systemd configs ship as templates inside the CLI
  package; it's the single interface to the hub. Untestable without the Pi —
  correct, idempotent, validated on real hardware.

---

## Phase 0 — Standalone Python link daemon + link manager (foundation)

Everything downstream needs the daemon, a TX path, and a robust link. The current
bridge (`src/lib/bridge/bridge.ts`) is RX-only and lives inside Next.

- [x] **Stand up the Python daemon** as a separate process; port the current
      RX + `SET_MESSAGE_INTERVAL` behavior off `bridge.ts`. Reuse
      `AircraftSim/src/px4/mavlink_io.py` patterns. *(gs/bridge.py; MAVLink→WS and
      JSON→WS paths tested.)*
- [x] ~~mavlink-router in front~~ — **not needed for SITL**; PX4 dual-unicasts
      (:14540 sim, :14550 gs). Deferred to real-radio / second-consumer.
- [x] **WS contract** daemon ↔ Cesium UI (`docs/ws-contract.md`): tagged
      telemetry out + `command`/`claim` in, `ack`/`link` back. In-Next bridge
      disabled (`instrumentation.ts` is a no-op).
- [x] **Link manager.** connecting/alive(<2s)/stale(<5s)/lost; `linkState` on
      every frame + `link` on transitions; console indicator + auto-reconnect.
- [x] **Transport abstraction.** UDP/TCP/serial behind `open_connection`, and
      `--mavlink auto` means real-radio is not even a config change: gs probes
      USB/radio/UDP/TCP and re-probes on reopen. Per-transport bandwidth budget
      sets the stream rates. *(done — see the 2026-10-17 pass.)*
- [x] **Command ACK tracking.** `COMMAND_LONG` for arm/disarm/set_mode; 3 tries
      @1s then `ack{timeout}`; matched `COMMAND_ACK` routed to the originating
      client. Thread-safe TX funnelled onto the mav thread.
- [x] **Authority discipline.** Single-commander via `claim`. No cross-plane reach.
- [x] **Test harness.** Synthetic-MAVLink decode + command/ack + link-state tests
      green (packages/gs/tests). **Live PX4 end-to-end CONFIRMED** (2026-10-03):
      mojave PX4 (`mojave/sim-v1.16.2`) built once (arm64, cached at
      `solar-airplane-fsw/mojave-px4/build`), then 194 live frames flowed
      PX4→gs→WS, all `linkState:alive`, real changing attitude/position. Future
      runs hit the cached fast path.

## Phase 1 — Command authority

Control verbs. Small, high-value, and the prerequisite for missions.

- [x] Arm / disarm — `MAV_CMD_COMPONENT_ARM_DISARM` via `COMMAND_LONG`. (Reuse
      `mavlink_io.py`.)
- [x] Set flight mode (Manual / Stabilized / Auto / Loiter / RTL / Offboard) —
      `SET_MODE` / `COMMAND_LONG`. Reuse mode decode already in `bridge.ts`.
- [x] Takeoff / Land / RTL / Hold buttons — `MAV_CMD_NAV_TAKEOFF` / `_LAND` /
      `_RETURN_TO_LAUNCH` / `_LOITER_UNLIM`.
- [x] "Fly to here" — click globe → guided reposition (`MAV_CMD_DO_REPOSITION`).
      Note: on PX4 **fixed-wing** this is loiter-at-point, not a quad-style goto —
      build the UI/expectation accordingly.
- [x] Command UI: action bar + confirm-on-dangerous, ACK/failure feedback,
      disabled states driven by link + armed + mode.
- [x] `STATUSTEXT` log panel — surface PX4 warnings/errors/failsafe to the operator.
- [x] Health/status: EKF, GPS fix + sats, battery warning, failsafe state —
      ingest `SYS_STATUS`, `GPS_RAW_INT`, `EKF_STATUS_REPORT`.

## Phase 2 — PX4 parameters (view + edit live)

"View PX4 variables and edit them on the fly." Turns the read-only
`/api/airframe` panel into a live, writable editor.

- [x] Fetch full param set — `PARAM_REQUEST_LIST` → stream of `PARAM_VALUE`;
      hand-roll the missing-param / re-request sync robustly (index/count
      tracking, timeout, retransmit). Tested against SITL.
- [x] Searchable, filterable param table: name, value, type, units/min/max/desc.
      Metadata (units/min/max/description) is **not** on the MAVLink wire — source
      it from PX4's bundled `parameters.json`. Decide: bundle it, or ship
      value-only first.
- [x] Edit + write live — `PARAM_SET`, confirm via echoed `PARAM_VALUE`; dirty
      indicators; reject/rollback on mismatch.
- [x] Diff vs airframe defaults (reuse the airframe init script already read via
      `/api/airframe`); highlight changed-from-default.
- [ ] Param snapshots: save / load / compare sets to file (local persistence).
      The only Phase 2 item not built.

## Phase 3 — SIL-rehearsal gateway

Per ecosystem §3.1, a hard contract: no uplinked command touches real hardware
until it has been replayed against AircraftSim SITL and passed. Built as its own
phase; the Phase 1/2 verbs (and Phase 4 missions) register with it.

- [ ] Rehearsal harness: daemon can drive an AircraftSim SITL run and apply a
      pending command/param/mission to it (Python colocation makes this direct).
- [ ] Verdict contract: a command is `rehearsed-ok` / `rehearsed-fail` with the
      sim's evidence, surfaced in the UI before any real-aircraft send.
- [ ] Authority tie-in: real-aircraft targets require a fresh passing rehearsal;
      SITL targets bypass (the target *is* the sim).
- [ ] Register each command verb (arm/mode/param-set/mission-upload) as it lands.

## Phase 4 — Mission planning on the fly

Create, edit, upload, and watch missions execute. All Commandant.

- [x] Waypoint authoring on the Cesium globe: click-to-add, drag-to-move.
- [x] Waypoint table: lat/lon/alt/speed/loiter; reorder; delete; per-item type
      (takeoff, waypoint, loiter time/turns/unlim, RTL, land) via
      `MISSION_ITEM_INT` frame/command fields.
- [x] **Upload** — hand-rolled `MISSION_COUNT` → `MISSION_REQUEST_INT` →
      `MISSION_ITEM_INT` → `MISSION_ACK` handshake (out-of-order requests,
      re-request, timeout, NAK decode). The most error-prone protocol; heaviest
      test coverage, and it routes through SIL-rehearsal.
- [x] **Download / read back** current mission — `MISSION_REQUEST_LIST`.
- [x] Live progress: highlight current item, distance-to-next —
      `MISSION_CURRENT`, `MISSION_ITEM_REACHED`. (Setpoint trail already exists.)
- [x] Edit mid-flight & re-upload without full restart; set-current item.
- [x] Later: geofence + rally points (`MAV_MISSION_TYPE_FENCE` / `_RALLY`).

## Phase 5 — Configurable display

"Seeing data and adjusting what's shown." Pure viewer-side, no control stakes.
The solar/power/MPPT dashboard already exists; this generalizes the rest.

- [x] Add/remove/reorder HUD panels & fields (extends `FlightHUD.tsx` + store).
- [x] Chart any telemetry field, not a fixed set — generalize the `series()`
      sparkline helper over the whole frame.
- [x] On-demand stream control: turn MAVLink messages on/off and set rate from
      the UI — generalize the existing `SET_MESSAGE_INTERVAL` TX.
- [~] ~~Multi-plot, time-window select, pause-and-scrub~~ — **dropped.** This is
      Guppi's viewer rebuilt worse; see the scope boundary below. The cockpit
      keeps a fixed set of flight instruments so it stays fully useful with
      Guppi unreachable, and stops there.
- [~] ~~Layout presets (flight-test / power-debug / mission view)~~ — **dropped**,
      same reason. Show/hide/reorder and the per-field chart toggle stay; they
      are persisted per viewer in localStorage.

---

## Phase 6 — hosted viewer (commandant.guppidev.com)

Public, read-only visibility into a live flight. Flight **history** is Guppi's,
not Commandant's: Guppi is the data plane and already has the viewer for it, so
this phase deliberately ships no replay, no flight index and no archive UI.

- [x] `packages/relay` — outbound-only websocket relay; token to publish, open to
      watch; retains current state for instant page loads; tells viewers when the
      hub vanishes. Read-only by construction (viewer sockets are never read).
- [x] `gs --relay` — outbound publisher, 5 Hz, latest-wins queue, jittered
      reconnect. Cannot block the 25 Hz loop or grow unbounded.
- [x] Console `NEXT_PUBLIC_MODE=view` — relay endpoint, no command bar, no
      authoring, no param writes, and a transmit chokepoint that refuses to send.
- [x] **Deployed.** Relay on Fly (`commandant-relay.fly.dev`, token as a secret,
      one always-on machine); console on Vercel from the root `vercel.json`.
      Verified end to end over the public internet, including that an anonymous
      publish is refused and a viewer's `arm` reaches nothing. See
      [`hosting.md`](hosting.md).
- [ ] **DNS.** `commandant.guppidev.com` is attached to the Vercel project and
      needs one A record (`commandant` → `76.76.21.21`) at Namecheap. Note
      `guppi.com` is not ours — registered 1999, GoDaddy — hence `guppidev.com`.
- [ ] Guppi egress from the hub, so flights land in Guppi's store and viewer.

**Found while deploying** (would have bitten the hub too, not just the host):
`cesium` had a caret range and had resolved to 1.146, whose wasm-bindgen glue the
production minifier rewrites into a template literal with octal escapes. The
bundle then fails to parse and the page never mounts. Dev builds are unminified,
so only a real deployment surfaced it. Cesium is pinned to 1.128.0 and
`@zip.js/zip.js` held on 2.7.73; every build now runs `node --check` over all
emitted chunks. Do not widen either pin without loading a production build in a
browser.

## Scope boundary amendment — authority follows vehicle STATE

The original rule ("does it change how it flies?") cannot answer where an MPPT
toggle belongs. The rule is now:

- **On the bench / HITL** the power system is a component under test. **Guppi has
  full authority** over MPPTs, switches, loads and power-firmware params.
- **In flight** every power action is a flight action (the power system feeds
  propulsion and avionics), and there is no NATS link to an airborne aircraft at
  all. **Commandant has sole authority**, and any in-flight power verb is a
  MAVLink-side Commandant verb under the claim and the SIL-rehearsal gate.
- Guppi is **the data plane**: all flight telemetry and history land there.
  Commandant publishes outbound and subscribes to nothing.

Consequence for Phase 5: generic charting (chart-any-field, multi-plot,
time-window scrub, layout presets) is Guppi's viewer rebuilt worse. Commandant
keeps a fixed set of flight instruments and stops there, so the cockpit stays
fully useful with Guppi unreachable.

Open: PX4 does not model the MPPTs, so an in-flight power verb needs either
custom MAVLink through the autopilot or a companion relaying DroneCAN. Undecided.

## Known issue — PX4 SITL stalls on long flights (open)

Observed three times in one afternoon, at roughly 1 h, 2.5 h and 41 min. PX4
logs `ERROR [simulator_mavlink] poll timeout` once and its simulated clock never
advances again. Nothing crashes; both PX4 and the JSBSim bridge spin at full CPU,
so process-level health checks report healthy while the aircraft is frozen.

Mitigations applied (AircraftSim): the container CPU cap was raised from 2 to 4,
and the bridge's `enable_lockstep` can now be turned off per rig so the bridge
never blocks on PX4. **Neither is a cure** — the 41-minute freeze happened with
lockstep already disabled, because `px4_sitl_default` is still compiled with
`ENABLE_LOCKSTEP_SCHEDULER=yes` and PX4's clock still comes from sensor
timestamps. A real fix means rebuilding PX4 without the lockstep scheduler.

What Commandant contributes, and why this is in *this* roadmap: gs now reports
the failure instead of hiding it. Link health is attributed per source, so the
sim's JSON feed can no longer vouch for a dead autopilot, and every frame carries
`dataAgeMs`. The console shows a red `stale Ns` badge past 3 s. Before that fix
the console reported `alive` for an hour while redrawing one frozen position.

## Deferred (post-MVP)

- Flight log download & playback / scrub — `LOG_REQUEST_*`.
- Telemetry recording to disk + replay into the same UI.
- Multi-vehicle (bridge currently assumes a single sysid).
- Video feed panel.

## Open decisions

- ~~Daemon repo location~~ — **resolved**: monorepo in Commandant,
  `packages/gs` (Python) + `packages/console` (UI). Rehearsal imports the sim.
- PX4 param metadata: bundle `parameters.json` now, or value-only first.

## Key files

UI paths are under `packages/console/`; the daemon lives in `packages/gs/`.

| Concern | File |
|---|---|
| Current bridge (to be replaced by the daemon) | `src/lib/bridge/bridge.ts` |
| Reuse: existing pymavlink link (arm/mode/takeoff/battery) | `../AircraftSim/src/px4/mavlink_io.py` |
| WS client → store (repoint at the daemon) | `src/services/telemetry.ts` |
| Telemetry state | `src/stores/aircraft.store.ts` |
| Frame type | `src/types/app.d.ts` |
| HUD / instruments | `src/components/flight/FlightHUD.tsx` |
| Globe scene (waypoints go here) | `src/components/flight/Aircraft.tsx`, `src/components/Globe.tsx` |
| Airframe config (→ live param editor) | `src/app/api/airframe/route.ts` |
| Ports / endpoints | `src/lib/envs.ts` |
