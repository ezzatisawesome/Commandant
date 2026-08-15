// MAVLink -> WebSocket telemetry bridge.
//
// Browsers cannot open raw UDP sockets, so this small ground-segment process
// connects to PX4's GCS MAVLink stream (UDP, the same port QGroundControl uses)
// and re-serves a decoded JSON telemetry frame over a WebSocket the Cesium UI
// subscribes to. It is blind to whether PX4 is driven by the sim (JSBSim) or a
// real airframe -- that is what makes "sim == real aircraft" hold.
//
//   PX4 SITL ──MAVLink/UDP:14550──► [this] ──JSON/WS:8080──► browser (Cesium)

import { createSocket } from "node:dgram";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { MavLinkPacketSplitter, MavLinkPacketParser } from "node-mavlink";
import { minimal, common, standard } from "mavlink-mappings";

const UDP_PORT = Number(process.env.MAVLINK_UDP_PORT ?? 14550);
const JSON_UDP_PORT = Number(process.env.JSON_UDP_PORT ?? 14555);
const WS_PORT = Number(process.env.BRIDGE_WS_PORT ?? 8080);
const BROADCAST_HZ = 25;
const STALE_MS = 2000; // no MAVLink traffic for this long => "disconnected"

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
	voltage?: number;
	current?: number;
	batteryRemaining?: number;
	armed?: boolean;
	mode?: string;
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
 * inputs and serve merged frames over WebSocket (8080). Idempotent — Next may
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
sock.on("message", (msg) => udpStream.write(msg));
sock.on("error", (err) => console.error("[bridge] udp error:", err.message));
sock.bind(UDP_PORT, () => console.log(`[bridge] listening for MAVLink on udp:${UDP_PORT}`));

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
		case standard.GlobalPositionInt:
			latest.lat = data.lat / 1e7;
			latest.lon = data.lon / 1e7;
			latest.alt = data.alt / 1000; // mm -> m (MSL)
			if (data.hdg !== 65535) latest.heading = data.hdg / 100;
			break;
		case common.Attitude:
			latest.roll = data.roll;
			latest.pitch = data.pitch;
			latest.yaw = data.yaw;
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
		case minimal.Heartbeat:
			latest.armed = (data.baseMode & 128) !== 0; // MAV_MODE_FLAG_SAFETY_ARMED
			latest.mode = decodeMode(data.customMode);
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
	"heading", "throttle", "voltage", "current", "batteryRemaining", "armed", "mode",
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
