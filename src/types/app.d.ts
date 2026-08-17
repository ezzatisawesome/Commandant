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
}
