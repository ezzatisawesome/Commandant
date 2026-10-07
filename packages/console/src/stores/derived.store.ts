// Derived flight state: terrain clearance, wind, sun geometry, fence proximity.
//
// Computed once per HUD tick and shared, rather than recomputed by each consumer
// (the HUD readout, the globe overlay, a future warning). All the maths lives in
// lib/flightGeometry.ts and is tested there; this is wiring plus the one piece of
// state that needs history (the previous fix, for track).

import { atom } from "nanostores";

import {
	solveWind, trackFromFixes, sunPosition, fenceProximity, aglM, clearanceBand,
	type Wind, type SunPosition, type FenceProximity, type ClearanceBand, isNum,
} from "@/lib/flightGeometry";
import { $hudFrame } from "@/stores/aircraft.store";
import { $fenceItems } from "@/stores/geo.store";

export interface DerivedState {
	/** Height above ground, metres. null until terrain tiles cover the aircraft. */
	aglM: number | null;
	clearance: ClearanceBand;
	/** Terrain elevation under the aircraft, metres MSL. */
	terrainM: number | null;
	wind: Wind | null;
	/** Course over ground, degrees true. */
	trackDeg: number | null;
	sun: SunPosition | null;
	fence: FenceProximity | null;
}

export const EMPTY_DERIVED: DerivedState = {
	aglM: null, clearance: "unknown", terrainM: null,
	wind: null, trackDeg: null, sun: null, fence: null,
};

export const $derived = atom<DerivedState>(EMPTY_DERIVED);

// Terrain height is sampled from the globe's loaded tiles, which only the Cesium
// layer can do. It publishes here so the derived state stays Cesium-free.
let terrainSampler: (() => number | null) | null = null;
export function setTerrainSampler(fn: (() => number | null) | null) {
	terrainSampler = fn;
}

// Previous fix, for deriving track. Kept module-local because it is pure
// bookkeeping, not state anyone should read.
let prev: { lat: number; lon: number } | null = null;
let lastTrackDeg: number | null = null;

/** Recompute from the current frame. Called on each $hudFrame change. */
export function recomputeDerived(): void {
	const f = $hudFrame.get();
	if (!f || !isNum(f.lat) || !isNum(f.lon)) {
		prev = null; lastTrackDeg = null;
		$derived.set(EMPTY_DERIVED);
		return;
	}

	// Track: bearing between consecutive fixes. Hold the last good value through
	// a slow patch rather than flickering to null, since wind depends on it.
	const t = prev ? trackFromFixes(prev.lat, prev.lon, f.lat, f.lon) : null;
	if (t !== null) lastTrackDeg = t;
	prev = { lat: f.lat, lon: f.lon };
	const trackDeg = lastTrackDeg;

	const terrainM = terrainSampler ? terrainSampler() : null;
	const agl = aglM(f.alt, terrainM ?? undefined);

	// Heading is where the nose points. Prefer the attitude yaw (radians, from
	// ATTITUDE) over the GPS-derived `heading` field, which on some stacks is
	// actually course over ground and would make the wind triangle degenerate.
	const headingDeg = isNum(f.yaw)
		? ((f.yaw * 180) / Math.PI + 360) % 360
		: (isNum(f.heading) ? f.heading : null);

	const wind = (headingDeg !== null && trackDeg !== null)
		? solveWind(headingDeg, f.airspeed as number, trackDeg, f.groundspeed as number)
		: null;

	// Sun from the SIMULATED instant: the sim owns time-of-day, so using the wall
	// clock here would put the sun in the wrong place for every replay and run.
	const sun = isNum(f.sunEpochMs) ? sunPosition(f.sunEpochMs, f.lat, f.lon) : null;

	$derived.set({
		aglM: agl,
		clearance: clearanceBand(agl),
		terrainM: terrainM ?? null,
		wind, trackDeg, sun,
		fence: fenceProximity(f.lat, f.lon, $fenceItems.get()),
	});
}

/** Wire the recompute to its inputs. Returns an unsubscribe. */
export function startDerived(): () => void {
	const offs = [$hudFrame.listen(recomputeDerived), $fenceItems.listen(recomputeDerived)];
	return () => offs.forEach((o) => o());
}
