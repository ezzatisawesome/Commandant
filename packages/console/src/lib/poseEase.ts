// The aircraft's drawn pose between telemetry samples.
//
// Telemetry arrives at 25 Hz and the display draws at 60. Drawing each sample
// as it lands moves the aircraft in 40 ms steps, which reads as a low frame
// rate however fast the scene draws. So each new sample is eased toward over
// the interval since the one before it, starting from wherever the drawn pose
// is now: the pose stays continuous, trails the data by about one sample
// (40 ms), and never extrapolates past what was received.
//
// driveRendering asks for a frame on every display frame until `easeUntilMs`,
// so a moving aircraft draws at the display's rate and a parked one (whose
// samples do not move) costs nothing extra.

import { $aircraftStore, hasFix, isNum } from "@/stores/aircraft.store";
import type { TelemetryFrame } from "@/types/app";

export interface Pose {
	lat: number;
	lon: number;
	alt: number;
	/** rad */
	roll: number;
	pitch: number;
	yaw: number;
}

const KEYS = ["lat", "lon", "alt", "roll", "pitch", "yaw"] as const;
const ANGLES = new Set<string>(["roll", "pitch", "yaw"]);

/** A gap longer than this (a dropped stream, a reconnect) jumps to the new
 *  sample instead of crawling toward it. */
export const MAX_EASE_MS = 200;

let from: Pose | null = null;
let to: Pose | null = null;
let startMs = 0;
let durMs = 0;
let lastArrivalMs: number | null = null;

function poseOf(f: TelemetryFrame | null): Pose | null {
	if (!f || !hasFix(f.lat, f.lon) || !isNum(f.alt)) return null;
	return {
		lat: f.lat!, lon: f.lon!, alt: f.alt,
		roll: isNum(f.roll) ? f.roll : 0,
		pitch: isNum(f.pitch) ? f.pitch : 0,
		yaw: isNum(f.yaw) ? f.yaw : 0,
	};
}

/** Shortest signed turn from a to b, rad. */
const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** The pose to draw now; null without a position fix. */
export function easedPose(now: number = performance.now()): Pose | null {
	if (!to) return null;
	if (!from || durMs <= 0) return to;
	const k = Math.min(1, Math.max(0, (now - startMs) / durMs));
	if (k >= 1) return to;
	const out = { ...to };
	for (const key of KEYS) {
		const d = ANGLES.has(key) ? turn(from[key], to[key]) : to[key] - from[key];
		out[key] = from[key] + d * k;
	}
	return out;
}

/** When the drawn pose reaches the newest sample (performance.now() ms). */
export function easeUntilMs(): number {
	return from ? startMs + durMs : 0;
}

/** Take a new sample. Exported for tests; startPoseEasing feeds it the store. */
export function easeSample(f: TelemetryFrame | null, now: number = performance.now()): void {
	const next = poseOf(f);
	if (!next) {
		from = to = null;
		lastArrivalMs = null;
		return;
	}
	const gap = lastArrivalMs === null ? Infinity : now - lastArrivalMs;
	lastArrivalMs = now;
	if (to && KEYS.every((k) => next[k] === to![k])) return;     // parked: nothing to ease
	if (gap > MAX_EASE_MS) {
		from = null;
		to = next;
		durMs = 0;
		return;
	}
	from = easedPose(now);
	to = next;
	startMs = now;
	durMs = gap;
}

/** Follow the aircraft store; returns the unsubscribe. */
export function startPoseEasing(): () => void {
	easeSample($aircraftStore.get());
	return $aircraftStore.listen((f) => easeSample(f));
}
