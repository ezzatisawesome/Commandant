import { atom } from "nanostores";
import { Cartesian3 } from "cesium";
import type { Entity } from "cesium";

import type { TelemetryFrame } from "@/types/app";

// Latest telemetry frame (null until the first frame arrives). Updated at the
// full link rate (25 Hz); Cesium reads it through CallbackProperties each render.
export const $aircraftStore = atom<TelemetryFrame | null>(null);

// The same frame, throttled to UI rate for React subscribers (HUD, health strip,
// command bar). Re-rendering a React tree 25×/s for numbers a human reads is
// pure waste and competes with Cesium for the main thread; 10 Hz is still
// visually live. Cesium overlays keep using $aircraftStore.
const HUD_INTERVAL_MS = 100;
export const $hudFrame = atom<TelemetryFrame | null>(null);
let lastHudAt = 0;

// A finite number (gs sends `null` for a non-finite float; JSON has no NaN).
export function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

// Normalize a wire frame: every `null` becomes `undefined` so the rest of the UI
// only ever deals with "present and finite" or "absent".
export function sanitizeFrame<T extends object>(frame: T): T {
	const out = frame as Record<string, unknown>;
	for (const k in out) {
		if (out[k] === null) out[k] = undefined;
	}
	return frame;
}

// The Cesium model entity, published by Aircraft.tsx so UI (the Track button)
// can point the camera at it.
export const $aircraftEntityStore = atom<Entity | null>(null);

// Bounded trail of recent positions for the flight path polyline.
const TRAIL_MAX = 3000;
// Distance (m) between consecutive fixes beyond which we treat the path as
// discontinuous (a new run respawning at home, a source switch, a teleport) and
// start a fresh trail — otherwise the polyline draws a long chord across the gap,
// which reads as the trail "connecting to itself in weird ways".
const TRAIL_JUMP_M = 2000;
export const $trailStore = atom<Cartesian3[]>([]);

// Bounded trail of the autopilot's commanded position setpoint
// (POSITION_TARGET_GLOBAL_INT) — "what the autopilot wants to do". Drawn as a
// second polyline so the intended path can be compared to the actual track: in a
// healthy loiter both are the same closed circle; if the commanded path closes
// but the actual doesn't, that's a tracking/control failure, and if the
// commanded path itself doesn't close, the loiter center is drifting.
export const $targetTrailStore = atom<Cartesian3[]>([]);

// Recent telemetry history for sparklines/trends. Downsampled in time so the
// arrays stay small (the live frames arrive at 25 Hz, which is far more than a
// tiny sparkline needs). One sample every HISTORY_INTERVAL_MS, capped at
// HISTORY_MAX samples → ~HISTORY_MAX * HISTORY_INTERVAL_MS / 1000 seconds of window.
const HISTORY_INTERVAL_MS = 250; // 4 Hz
const HISTORY_MAX = 480; // ~2 minutes
export const $historyStore = atom<TelemetryFrame[]>([]);

// Track the link state across frames so we can detect a run boundary: the sim
// stops sending between runs, the bridge marks frames `connected:false` after
// STALE_MS, then a new run reconnects. On that rising edge we drop the stale
// trail + history so a fresh run starts clean instead of chording its path back
// to where the previous run left off.
let wasConnected = false;

export function pushFrame(frame: TelemetryFrame) {
	sanitizeFrame(frame);
	if (frame.connected && !wasConnected) {
		$trailStore.set([]);
		$historyStore.set([]);
		$targetTrailStore.set([]);
	}
	wasConnected = frame.connected;

	$aircraftStore.set(frame);
	if (frame.t - lastHudAt >= HUD_INTERVAL_MS || !frame.connected) {
		lastHudAt = frame.t;
		$hudFrame.set(frame);
	}

	// Append to the downsampled history if enough time has passed since the
	// last stored sample (using the frame's own bridge timestamp `t`).
	const hist = $historyStore.get();
	const lastSample = hist[hist.length - 1];
	if (!lastSample || frame.t - lastSample.t >= HISTORY_INTERVAL_MS) {
		const next = hist.length >= HISTORY_MAX ? hist.slice(hist.length - HISTORY_MAX + 1) : hist.slice();
		next.push(frame);
		$historyStore.set(next);
	}

	// A frame with no valid fix breaks the path so the next real fix starts a new
	// segment instead of being chorded to the last. "No valid fix" also rejects the
	// null-island (0,0) sentinel some glitch/uninitialized frames carry — otherwise
	// the polyline shoots a long chord off to (0,0), which reads as a "cone".
	if (!hasFix(frame.lat, frame.lon) || !isNum(frame.alt)) {
		return;
	}

	const point = Cartesian3.fromDegrees(frame.lon!, frame.lat!, frame.alt);
	$trailStore.set(appendTrail($trailStore.get(), point));

	// Commanded-path trail: place the setpoint at the aircraft's current altitude
	// so the two polylines are coplanar and the horizontal comparison (does the
	// orbit close?) is honest — the setpoint's own alt frame is unreliable.
	if (!hasFix(frame.targetLat, frame.targetLon)) {
		return;
	}
	const target = Cartesian3.fromDegrees(frame.targetLon!, frame.targetLat!, frame.alt);
	$targetTrailStore.set(appendTrail($targetTrailStore.get(), target));
}

// A usable horizontal fix: both defined, finite, and not the null-island (0,0)
// sentinel (|lat|,|lon| < ~0.0001 deg ≈ 11 m of the Gulf of Guinea origin).
export function hasFix(lat?: number, lon?: number): boolean {
	return (
		lat !== undefined && lon !== undefined &&
		Number.isFinite(lat) && Number.isFinite(lon) &&
		(Math.abs(lat) > 1e-4 || Math.abs(lon) > 1e-4)
	);
}

// Minimum spacing between trail points. At 25 Hz a 15 m/s aircraft moves 0.6 m
// per frame; storing every frame burned the 3000-point cap in 2 minutes and
// re-copied the array 25×/s. Decimating to ≥2 m stretches the trail to tens of
// minutes and makes most frames a no-op (no new array, no Cesium re-upload).
const TRAIL_MIN_STEP_M = 2;

// Append a point to a bounded trail, DROPPING an outlier that jumps more than
// TRAIL_JUMP_M from the last point (a single glitch frame) rather than chording
// to it or reseeding the path on it — either of which draws the stray line.
export function appendTrail(trail: Cartesian3[], point: Cartesian3): Cartesian3[] {
	const last = trail[trail.length - 1];
	if (last) {
		const d = Cartesian3.distance(last, point);
		if (d > TRAIL_JUMP_M) return trail; // outlier — ignore it, keep the existing path intact
		if (d < TRAIL_MIN_STEP_M) return trail; // hasn't moved enough to be worth a vertex
	}
	const next = trail.length >= TRAIL_MAX ? trail.slice(trail.length - TRAIL_MAX + 1) : trail.slice();
	next.push(point);
	return next;
}

export function clearTrail() {
	$trailStore.set([]);
	$targetTrailStore.set([]);
}
