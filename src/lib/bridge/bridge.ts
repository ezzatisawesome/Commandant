// MAVLink -> WebSocket telemetry bridge.
//
// Browsers cannot open raw UDP sockets, so this small ground-segment process
// connects to PX4's GCS MAVLink stream (UDP, the same port QGroundControl uses)
// and re-serves a decoded JSON telemetry frame over a WebSocket the Cesium UI
// subscribes to. It is blind to whether PX4 is driven by the sim (JSBSim) or a
// real airframe -- that is what makes "sim == real aircraft" hold.
//
//   PX4 SITL ──MAVLink/UDP:14550──► [this] ──JSON/WS:8790──► browser (Cesium)

import { createSocket } from "node:dgram";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { MavLinkPacketSplitter, MavLinkPacketParser, MavLinkProtocolV2 } from "node-mavlink";
import { minimal, common, standard } from "mavlink-mappings";

const UDP_PORT = Number(process.env.MAVLINK_UDP_PORT ?? 14550);
const JSON_UDP_PORT = Number(process.env.JSON_UDP_PORT ?? 14555);
const WS_PORT = Number(process.env.BRIDGE_WS_PORT ?? 8790);
const BROADCAST_HZ = 25;
const STALE_MS = 2000; // no MAVLink traffic for this long => "disconnected"

// PX4 servo/actuator PWM pulse width (µs) -> control-surface deflection percent,
// about the 1500 µs neutral with a ±500 µs full-scale throw, clamped to ±100 %.
// (Mirrors the sim's mavlink_io._norm so MAVLink and flightdyn read identically.)
const pwmPct = (us: number): number =>
	Math.max(-100, Math.min(100, ((us - 1500) / 500) * 100));

// Registry maps msgid -> message class so we can decode payloads.
const REGISTRY: Record<number, any> = {
	...minimal.REGISTRY,
	...common.REGISTRY,
	...standard.REGISTRY,
};

// Latest-known value per field; any may stay undefined until first message.
type Frame = {
	t: number;
	lat?: number;
	lon?: number;
	alt?: number;
	roll?: number;
	pitch?: number;
	yaw?: number;
	airspeed?: number;
	groundspeed?: number;
	heading?: number;
	throttle?: number;
	elevator?: number;
	aileron?: number;
	rudder?: number;
	voltage?: number;
	current?: number;         // NET pack current after solar (A)
	batteryRemaining?: number;
	// Power decomposition (sim JSON path): solar generation, total load, and the
	// gross propulsion draw — so the near-zero net current in daylight reads as
	// "solar is covering the load", not "no draw".
	genW?: number;            // solar array output (W)
	loadW?: number;           // total electrical load (W)
	propW?: number;           // propulsion demand (W)
	motorCurrent?: number;    // gross propulsion pack current (A)
	irradiance?: number;      // usable flux (W/m^2), incl. bank tilt
	sunEpochMs?: number;      // simulated instant (UTC epoch ms) for the sun/day-night clock
	armed?: boolean;
	mode?: string;
	// "What the autopilot wants": PX4's current position setpoint
	// (POSITION_TARGET_GLOBAL_INT) — the point it is actively steering toward. In
	// AUTO.LOITER this walks the intended orbit, so a trail of it is the commanded
	// path to overlay against the actual track.
	targetLat?: number;
	targetLon?: number;
	targetAlt?: number;
	connected: boolean;
};

let started = false;

// --- PX4 flight-mode decode (custom_mode main/sub) ---------------------------
const MAIN = ["", "MANUAL", "ALTCTL", "POSCTL", "AUTO", "ACRO", "OFFBOARD", "STABILIZED", "RATTITUDE"];
const AUTO_SUB = ["", "READY", "TAKEOFF", "LOITER", "MISSION", "RTL", "LAND", "RTGS", "FOLLOW", "PRECLAND"];
function decodeMode(customMode: number): string {
	const main = (customMode >> 16) & 0xff;
	const sub = (customMode >> 24) & 0xff;
	const mainName = MAIN[main] ?? `MODE${main}`;
	if (main === 4) return `AUTO.${AUTO_SUB[sub] ?? sub}`;
	return mainName;
}

/**
 * Start the telemetry bridge: bind the MAVLink (14550) and JSON (14555) UDP
 * inputs and serve merged frames over WebSocket (8790). Idempotent — Next may
 * invoke instrumentation more than once during dev hot-reload.
 */
export function startBridge() {
	if (started) return;
	started = true;

	const latest: Frame = { t: 0, connected: false };
	let lastMsgAt = 0;

// --- MAVLink ingest ----------------------------------------------------------
const udpStream = new PassThrough();
const sock = createSocket("udp4");
let px4Addr: { address: string; port: number } | undefined;
sock.on("message", (msg, rinfo) => {
	px4Addr = rinfo; // remember PX4's endpoint so we can request streams
	udpStream.write(msg);
});
sock.on("error", (err) => console.error("[bridge] udp error:", err.message));
sock.bind(UDP_PORT, () => console.log(`[bridge] listening for MAVLink on udp:${UDP_PORT}`));

// Ask PX4 (via SET_MESSAGE_INTERVAL) to stream messages its default GCS set
// omits: ACTUATOR_OUTPUT_STATUS (375, control-surface outputs) and
// POSITION_TARGET_GLOBAL_INT (87, the nav setpoint we overlay as the commanded
// path). We keep asking until each field starts flowing, throttled to ~1 Hz.
const proto = new MavLinkProtocolV2();
let seq = 0;
const lastReqAt: Record<number, number> = {};
function requestMessage(targetSys: number, targetComp: number, msgId: number) {
	if (!px4Addr) return;
	const now = Date.now();
	if (now - (lastReqAt[msgId] ?? 0) < 1000) return; // throttle retries per msg
	lastReqAt[msgId] = now;
	const cmd = new common.CommandLong();
	cmd.targetSystem = targetSys;
	cmd.targetComponent = targetComp;
	cmd.command = common.MavCmd.SET_MESSAGE_INTERVAL;
	cmd._param1 = msgId;
	cmd._param2 = 40000; // interval µs → 25 Hz
	const buf = proto.serialize(cmd, seq++ & 0xff);
	sock.send(buf, px4Addr.port, px4Addr.address);
}
function requestExtraStreams(targetSys: number, targetComp: number) {
	if (latest.aileron === undefined) requestMessage(targetSys, targetComp, common.ActuatorOutputStatus.MSG_ID); // 375
	if (latest.targetLat === undefined) requestMessage(targetSys, targetComp, common.PositionTargetGlobalInt.MSG_ID); // 87
}

// GLOBAL_POSITION_INT can arrive out of order or duplicated over UDP; sampling a
// stale one makes the actual-track polyline snap back to a point the aircraft
// already passed. Gate on the message's own monotonic time_boot_ms and drop any
// frame that isn't strictly newer — except a large backward jump, which is a PX4
// reboot (a new run) and legitimately resets the clock.
let lastPosBootMs = -1;
const REBOOT_GAP_MS = 5000;

// The autopilot setpoint has two possible sources: PX4's POSITION_TARGET_GLOBAL_INT
// (below) and flightlink's JSON feed (which, in augment/PX4 runs, carries the sim's
// own setpoint and is declared authoritative there). Letting both write targetLat/
// targetLon makes the orange overlay zigzag between the two (loiter centre vs the
// on-circle steering point). Track when JSON last supplied a target so PX4's copy
// yields to it.
let jsonTargetAt = 0;
const TARGET_SOURCE_TTL_MS = 2000;

const reader = udpStream.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());

reader.on("data", (packet: any) => {
	const clazz = REGISTRY[packet.header.msgid];
	if (!clazz) return;
	lastMsgAt = Date.now();
	let data: any;
	try {
		data = packet.protocol.data(packet.payload, clazz);
	} catch {
		return;
	}

	switch (clazz) {
		case standard.GlobalPositionInt: {
			// Drop stale/reordered frames; a large backward jump is a reboot, not
			// reordering, so let it through and re-anchor the clock.
			const boot = data.timeBootMs;
			if (boot <= lastPosBootMs && lastPosBootMs - boot < REBOOT_GAP_MS) break;
			lastPosBootMs = boot;
			latest.lat = data.lat / 1e7;
			latest.lon = data.lon / 1e7;
			latest.alt = data.alt / 1000; // mm -> m (MSL)
			if (data.hdg !== 65535) latest.heading = data.hdg / 100;
			break;
		}
		case common.Attitude:
			latest.roll = data.roll;
			latest.pitch = data.pitch;
			latest.yaw = data.yaw;
			break;
		case common.PositionTargetGlobalInt:
			// The autopilot's commanded position (what it's steering toward). alt
			// frame varies (often relative-to-home); we only overlay the horizontal
			// path, and the store places the marker at the aircraft's own altitude.
			// Yield to flightlink's JSON setpoint when it's live (augment runs) so
			// the two sources don't fight over targetLat/targetLon.
			if (Date.now() - jsonTargetAt < TARGET_SOURCE_TTL_MS) break;
			latest.targetLat = data.latInt / 1e7;
			latest.targetLon = data.lonInt / 1e7;
			latest.targetAlt = data.alt;
			break;
		case common.VfrHud:
			latest.airspeed = data.airspeed;
			latest.groundspeed = data.groundspeed;
			latest.throttle = data.throttle;
			if (latest.heading === undefined) latest.heading = data.heading;
			break;
		case common.BatteryStatus: {
			const mv = Array.isArray(data.voltages) ? data.voltages.filter((v: number) => v !== 65535) : [];
			if (mv.length) latest.voltage = mv.reduce((a: number, b: number) => a + b, 0) / 1000;
			if (data.currentBattery !== -1) latest.current = data.currentBattery / 100; // cA -> A
			if (data.batteryRemaining !== -1) latest.batteryRemaining = data.batteryRemaining;
			break;
		}
		case common.ActuatorOutputStatus: {
			// Post-mixer outputs. Indices are the sim's PWM_MAIN output order
			// (rev6.bridge-config.xml): 2=rudder, 4=throttle, 5=aileron, 7=elevator.
			// These arrive as PWM PULSE WIDTHS in microseconds (~1000-2000, centre 1500),
			// NOT normalized -1..1 — so treating them as normalized made a 1288 µs
			// command render as 128800 %. Convert to -100..100 % about the 1500 µs
			// centre (matches the sim's mavlink_io _norm: (µs-1500)/500).
			const a = data.actuator as number[];
			if (a && a.length > 7) {
				latest.aileron = pwmPct(a[5]);
				latest.elevator = pwmPct(a[7]);
				latest.rudder = pwmPct(a[2]);
			}
			break;
		}
		case minimal.Heartbeat:
			latest.armed = (data.baseMode & 128) !== 0; // MAV_MODE_FLAG_SAFETY_ARMED
			latest.mode = decodeMode(data.customMode);
			// PX4 doesn't stream ACTUATOR_OUTPUT_STATUS or POSITION_TARGET_GLOBAL_INT
			// on the GCS link by default; request them (QGC-style) once we know
			// PX4's address.
			requestExtraStreams(packet.header.sysid, packet.header.compid);
			break;
	}
});

// --- JSON ingest (flightdyn path) --------------------------------------------
// In flightdyn mode the sim has no PX4/MAVLink, so its `flightlink` system sends
// ready-made JSON telemetry (already projected to lat/lon, attitude in radians)
// straight to this port. We merge defined keys into the same `latest` frame, so
// the WS output and the UI are identical regardless of source.
const JSON_KEYS = new Set([
	"lat", "lon", "alt", "roll", "pitch", "yaw", "airspeed", "groundspeed",
	"heading", "throttle", "elevator", "aileron", "rudder",
	"voltage", "current", "batteryRemaining", "armed", "mode",
	"genW", "loadW", "propW", "motorCurrent", "irradiance", "sunEpochMs",
	"targetLat", "targetLon", "targetAlt",
]);
const jsonSock = createSocket("udp4");
jsonSock.on("message", (buf) => {
	let obj: any;
	try {
		obj = JSON.parse(buf.toString("utf8"));
	} catch {
		return;
	}
	lastMsgAt = Date.now();
	for (const [k, v] of Object.entries(obj)) {
		if (JSON_KEYS.has(k) && v !== undefined) (latest as any)[k] = v;
	}
	// Claim the setpoint for the JSON feed so PX4's POSITION_TARGET yields to it.
	if (obj.targetLat !== undefined) jsonTargetAt = lastMsgAt;
});
jsonSock.on("error", (err) => console.error("[bridge] json udp error:", err.message));
jsonSock.bind(JSON_UDP_PORT, () =>
	console.log(`[bridge] listening for JSON telemetry on udp:${JSON_UDP_PORT}`)
);

// --- WebSocket egress --------------------------------------------------------
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("listening", () => console.log(`[bridge] websocket serving on ws://localhost:${WS_PORT}`));

setInterval(() => {
	latest.t = Date.now();
	latest.connected = latest.t - lastMsgAt < STALE_MS;
	const payload = JSON.stringify(latest);
	for (const client of wss.clients) {
		if (client.readyState === client.OPEN) client.send(payload);
	}
}, 1000 / BROADCAST_HZ);
}
