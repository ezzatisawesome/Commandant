import { atom } from "nanostores";
import { Cartesian3 } from "cesium";
import type { Entity } from "cesium";

import type { TelemetryFrame } from "@/types/app";

// Latest telemetry frame (null until the first frame arrives).
export const $aircraftStore = atom<TelemetryFrame | null>(null);

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

// Recent telemetry history for sparklines/trends. Downsampled in time so the
// arrays stay small (the live frames arrive at 25 Hz, which is far more than a
// tiny sparkline needs). One sample every HISTORY_INTERVAL_MS, capped at
// HISTORY_MAX samples → ~HISTORY_MAX * HISTORY_INTERVAL_MS / 1000 seconds of window.
const HISTORY_INTERVAL_MS = 250; // 4 Hz
const HISTORY_MAX = 480; // ~2 minutes
export const $historyStore = atom<TelemetryFrame[]>([]);

export function pushFrame(frame: TelemetryFrame) {
	$aircraftStore.set(frame);

	// Append to the downsampled history if enough time has passed since the
	// last stored sample (using the frame's own bridge timestamp `t`).
	const hist = $historyStore.get();
	const lastSample = hist[hist.length - 1];
	if (!lastSample || frame.t - lastSample.t >= HISTORY_INTERVAL_MS) {
		const next = hist.length >= HISTORY_MAX ? hist.slice(hist.length - HISTORY_MAX + 1) : hist.slice();
		next.push(frame);
		$historyStore.set(next);
	}

	// A frame with no fix (e.g. the disconnected sentinel) breaks the path: the
	// next real fix starts a new segment instead of being chorded to the last.
	if (frame.lat === undefined || frame.lon === undefined || frame.alt === undefined) {
		return;
	}

	const point = Cartesian3.fromDegrees(frame.lon, frame.lat, frame.alt);
	const trail = $trailStore.get();
	const last = trail[trail.length - 1];
	if (last && Cartesian3.distance(last, point) > TRAIL_JUMP_M) {
		$trailStore.set([point]); // discontinuity — drop the stale path, don't chord across it
		return;
	}
	const next = trail.length >= TRAIL_MAX ? trail.slice(trail.length - TRAIL_MAX + 1) : trail.slice();
	next.push(point);
	$trailStore.set(next);
}

export function clearTrail() {
	$trailStore.set([]);
}
