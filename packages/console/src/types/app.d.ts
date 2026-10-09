export interface ClassicalOrbitalElements {
    semiMajorAxis: number,
    eccentricity: number,
    inclination: number,
    longitudeAscendingNode: number,
    argumentOfPeriapses: number,
    trueAnomaly: number,
}

export interface Satellite extends ClassicalOrbitalElements {
    _id: string,
    name: string,
    sensorRadius?: number,
}

// One decoded telemetry frame emitted by the MAVLink->WS bridge (server/bridge.ts).
// Fields are the latest-known value for each MAVLink source message; any may be
// undefined until its first message arrives.
export interface TelemetryFrame {
    t: number,              // bridge timestamp (ms epoch)
    lat?: number,           // deg   (GLOBAL_POSITION_INT)
    lon?: number,           // deg
    alt?: number,           // m MSL
    roll?: number,          // rad   (ATTITUDE)
    pitch?: number,         // rad
    yaw?: number,           // rad
    airspeed?: number,      // m/s   (VFR_HUD)
    groundspeed?: number,   // m/s
    heading?: number,       // deg
    throttle?: number,      // %
    elevator?: number,      // %     (ACTUATOR_OUTPUT_STATUS, -100..100)
    aileron?: number,       // %
    rudder?: number,        // %
    voltage?: number,       // V     (BATTERY_STATUS)
    current?: number,       // A     NET pack current after solar
    batteryRemaining?: number, // %
    // Power decomposition (sim `flightlink` JSON path): solar vs load vs the
    // gross propulsion draw, so a near-zero net current in daylight is legible.
    genW?: number,          // W     solar array output
    loadW?: number,         // W     total electrical load
    propW?: number,         // W     propulsion demand
    motorCurrent?: number,  // A     gross propulsion pack current
    irradiance?: number,    // W/m^2 usable flux (incl. bank tilt)
    sunEpochMs?: number,    // ms    simulated instant (UTC epoch) for the sun/day-night clock
    armed?: boolean,        // HEARTBEAT
    mode?: string,          // flight mode string
    // Autopilot's commanded position setpoint (POSITION_TARGET_GLOBAL_INT) — the
    // "what it wants to do" path, overlaid against the actual track.
    targetLat?: number,     // deg
    targetLon?: number,     // deg
    targetAlt?: number,     // m (frame-dependent; horizontal path is the useful part)
    connected: boolean,     // bridge <-> MAVLink link alive
    linkState?: LinkState,
    // Age of the newest VEHICLE data in ms (null before any arrives). A live
    // frame with a large dataAgeMs means gs is re-serving a stale fix, which is
    // what a frozen simulator or a dead autopilot looks like from here.
    dataAgeMs?: number | null,

    // --- straight from the autopilot's estimator, not reconstructed here -----
    // EKF velocity in NED (m/s), from GLOBAL_POSITION_INT vx/vy/vz. Doppler
    // derived, so far more accurate than differencing positions.
    vn?: number,
    ve?: number,
    vd?: number,
    /** Course over ground, deg true — atan2(ve, vn) computed in gs. */
    trackDeg?: number,
    /** Climb rate, m/s positive up. */
    climb?: number,
    // PX4 EKF2's own wind estimate (WIND_COV). Absent until the estimator has
    // one, which needs an airspeed sensor and some flight time.
    /** Wind speed, m/s. */
    windSpeed?: number,
    /** Direction the wind blows FROM, deg true. */
    windFromDeg?: number,
    /** Vertical wind component, m/s. */
    windDown?: number,
    /** 1-sigma horizontal uncertainty of the wind estimate, m/s. */
    windSigma?: number,  // richer link state (connected == linkState === "alive")
    // Health / status (see docs/ws-contract.md), merged into the frame by gs.
    ekfOk?: boolean,        // EKF_STATUS_REPORT flags nominal
    gpsFix?: number,        // GPS_RAW_INT.fix_type (0 none … 3 3D … 6 RTK-fixed)
    gpsSats?: number,       // satellites visible
    failsafe?: boolean,     // vehicle in a failsafe
    sysHealthy?: boolean,   // SYS_STATUS: all enabled sensors healthy
    batteryWarning?: string | null, // e.g. "LOW" / "CRITICAL", else null
}

// --- WS envelope (console <-> gs), see docs/ws-contract.md --------------------
// Link health as reported by the gs daemon's link manager.
export type LinkState = "connecting" | "alive" | "stale" | "lost";

// Commands the UI can issue. args shapes mirror AircraftSim/src/px4/mavlink_io.py.
export type CommandName =
    | "arm" | "disarm" | "set_mode"
    | "takeoff" | "land" | "rtl" | "hold" | "reposition"
    // Stream control. A rate change is a command, not a preference: it is
    // acked, retried and timed out like any other, so the console can say
    // whether PX4 took the rate. args: { msgId, hz } — hz 0 stops the stream.
    | "set_message_interval";

// console -> gs
export interface CommandMessage {
    type: "command",
    id: string,             // uuid; echoed back in the matching AckMessage
    name: CommandName,
    args: Record<string, unknown>,
}
// Bid to be the single commander. When `id` is set, gs replies with an AckMessage
// (text "commander" | "not commander") so the UI can confirm it holds authority.
export interface ClaimMessage { type: "claim", id?: string }
export interface ParamRefreshMessage { type: "param_refresh" } // request the full param list
export interface ParamSetMessage {
    type: "param_set",
    id: string,             // uuid; echoed back in the matching ParamAckMessage
    name: string,
    value: number,
    ptype?: number,         // MAV_PARAM_TYPE; gs infers if omitted
}
/**
 * Legacy unacked stream control (Phase 5). gs still honours it, but nothing in
 * the console sends it any more: a rate change goes out as a
 * `set_message_interval` command, which comes back with a result. Kept so a
 * client written against the old contract keeps working.
 */
export interface StreamMessage {
    type: "stream",
    msgId: number,          // MAVLink message id to (de)activate
    hz: number,             // rate; 0 disables the stream
}

// --- missions (Phase 4), see docs/ws-contract.md -----------------------------
// Console-friendly item; gs maps each `kind` to a MISSION_ITEM_INT.
export type MissionKind =
    | "takeoff" | "waypoint" | "loiter_unlim" | "loiter_time" | "loiter_turns" | "rtl" | "land";
export interface MissionItem {
    seq: number,
    kind: MissionKind,
    lat?: number,           // deg (omitted for rtl)
    lon?: number,           // deg
    alt?: number,           // m (relative-to-home)
    params?: Record<string, number>, // kind-specific: radius / seconds / turns
}
export interface MissionPushMessage {
    type: "mission_push",
    id: string,             // uuid; echoed back in the matching MissionAckMessage
    items: MissionItem[],
}
export interface MissionPullMessage { type: "mission_pull" }
export interface MissionSetCurrentMessage { type: "mission_set_current", seq: number }

// --- geofence + rally (Phase 4 extension), see docs/ws-contract.md ------------
// Same handshake as missions, generalized by mission_type. Fence polygons are a
// run of consecutive same-kind vertex items sharing a vertexCount; circles and
// rally points are single items.
export type FenceKind =
    | "fence_inclusion" | "fence_exclusion"            // polygon vertices
    | "fence_circle_inclusion" | "fence_circle_exclusion"; // single-point circles
export interface FenceItem {
    seq: number,
    kind: FenceKind,
    lat: number,            // deg
    lon: number,            // deg
    // vertexCount for polygon vertices (gs packs it into param1); radius (m) for
    // circles. The console fills these at push time.
    params?: Record<string, number>,
}
export interface RallyItem {
    seq: number,
    kind: "rally",
    lat: number,            // deg
    lon: number,            // deg
    alt?: number,           // m (relative-to-home)
}
export interface FencePushMessage { type: "fence_push", id: string, items: FenceItem[] }
export interface FencePullMessage { type: "fence_pull" }
export interface RallyPushMessage { type: "rally_push", id: string, items: RallyItem[] }
export interface RallyPullMessage { type: "rally_pull" }

export type ClientMessage =
    | CommandMessage | ClaimMessage | ParamRefreshMessage | ParamSetMessage | StreamMessage
    | MissionPushMessage | MissionPullMessage | MissionSetCurrentMessage
    | FencePushMessage | FencePullMessage | RallyPushMessage | RallyPullMessage;

// gs -> console
export interface TelemetryMessage extends TelemetryFrame { type: "telemetry" }
export interface AckMessage {
    // false = interim MAV_RESULT_IN_PROGRESS notice; the final ack follows (≤15 s).
    final?: boolean,
    type: "ack",
    id: string,             // matches the CommandMessage.id
    ok: boolean,            // convenience: result === 0 (ACCEPTED) or a local accept
    result: number,         // MAV_RESULT when from a COMMAND_ACK, else -1
    text: string,           // human-readable ("accepted" | "timeout" | "not commander" | …)
}
export interface LinkMessage { type: "link", state: LinkState, lastMsgMs: number }
export interface StatusTextMessage {
    type: "statustext",
    severity: number,       // MAV_SEVERITY (0 emergency … 7 debug)
    text: string,
    t: number,              // ms epoch
}
export interface ParamValueMessage {
    type: "param",
    name: string,
    value: number,
    ptype: number,          // MAV_PARAM_TYPE
    index: number,          // position in the full list
    count: number,          // total params (for progress)
}
// gs coalesces the PARAM_VALUE stream into batches (one WS message per ~50 ms).
export interface ParamsBatchMessage {
    type: "params",
    items: ParamValueMessage[],
}
export interface ParamProgressMessage {
    type: "param_progress",
    received: number,
    count: number,
    done?: boolean,         // refresh finished (all values received, or given up)
    error?: string,         // set with `done` when gs gave up (e.g. "timeout")
}
export interface ParamAckMessage {
    type: "param_ack",
    id: string,             // matches the ParamSetMessage.id
    name: string,
    value: number,          // the value gs read back after the set
    ok: boolean,
    text: string,
}

export interface MissionMessage { type: "mission", count: number, items: MissionItem[] }
export interface MissionProgressMessage {
    type: "mission_progress",
    phase: "upload" | "download",
    seq: number,            // item just transferred
    count: number,          // total items
}
export interface MissionAckMessage {
    type: "mission_ack",
    id: string,             // matches MissionPushMessage.id ("" for pull-side acks)
    ok: boolean,
    result: number,         // MAV_MISSION_RESULT (0 = ACCEPTED)
    text: string,
}
export interface MissionCurrentMessage { type: "mission_current", seq: number }
export interface MissionReachedMessage { type: "mission_reached", seq: number }

export interface FenceMessage { type: "fence", count: number, items: FenceItem[] }
export interface RallyMessage { type: "rally", count: number, items: RallyItem[] }
export interface FenceAckMessage { type: "fence_ack", id: string, ok: boolean, result: number, text: string }
export interface RallyAckMessage { type: "rally_ack", id: string, ok: boolean, result: number, text: string }

export type ServerMessage =
    | TelemetryMessage | AckMessage | LinkMessage | StatusTextMessage
    | ParamValueMessage | ParamsBatchMessage | ParamProgressMessage | ParamAckMessage
    | MissionMessage | MissionProgressMessage | MissionAckMessage
    | MissionCurrentMessage | MissionReachedMessage
    | FenceMessage | RallyMessage | FenceAckMessage | RallyAckMessage;
