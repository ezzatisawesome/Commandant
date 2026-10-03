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
    linkState?: LinkState,  // richer link state (connected == linkState === "alive")
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
    | "takeoff" | "land" | "rtl" | "hold" | "reposition";

// console -> gs
export interface CommandMessage {
    type: "command",
    id: string,             // uuid; echoed back in the matching AckMessage
    name: CommandName,
    args: Record<string, unknown>,
}
export interface ClaimMessage { type: "claim" } // bid to be the single commander
export interface ParamRefreshMessage { type: "param_refresh" } // request the full param list
export interface ParamSetMessage {
    type: "param_set",
    id: string,             // uuid; echoed back in the matching ParamAckMessage
    name: string,
    value: number,
    ptype?: number,         // MAV_PARAM_TYPE; gs infers if omitted
}
export interface StreamMessage {
    type: "stream",
    msgId: number,          // MAVLink message id to (de)activate
    hz: number,             // rate; 0 disables the stream
}
export type ClientMessage =
    | CommandMessage | ClaimMessage | ParamRefreshMessage | ParamSetMessage | StreamMessage;

// gs -> console
export interface TelemetryMessage extends TelemetryFrame { type: "telemetry" }
export interface AckMessage {
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
export interface ParamProgressMessage {
    type: "param_progress",
    received: number,
    count: number,
}
export interface ParamAckMessage {
    type: "param_ack",
    id: string,             // matches the ParamSetMessage.id
    name: string,
    value: number,          // the value gs read back after the set
    ok: boolean,
    text: string,
}

export type ServerMessage =
    | TelemetryMessage | AckMessage | LinkMessage | StatusTextMessage
    | ParamValueMessage | ParamProgressMessage | ParamAckMessage;
