// Derived flight state: terrain clearance, wind, sun geometry, fence proximity.
//
// Computed once per HUD tick and shared, rather than recomputed by each consumer
// (the HUD readout, the globe overlay, a future warning). All the maths lives in
// lib/flightGeometry.ts and is tested there; this is wiring plus the one piece of
// state that needs history (the previous fix, for track).

import { atom } from "nanostores";

import {
	sunPosition, fenceProximity, aglM, clearanceBand, distanceM, angleDiffDeg,
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
	/** Horizontal distance from the aircraft to the commanded setpoint, metres.
	 *
	 *  This exists to answer a question the globe alone cannot: the commanded path
	 *  (orange) sitting well away from the flown path (cyan) can mean either a
	 *  decoding bug OR correct behaviour, because on fixed-wing PX4 a loiter's
	 *  position setpoint is the orbit CENTRE — which is one radius away by
	 *  definition. If this reads ~= the loiter radius, the separation is right. If
	 *  it reads kilometres, something is wrong. */
	targetDistM: number | null;
}

export const EMPTY_DERIVED: DerivedState = {
	aglM: null, clearance: "unknown", terrainM: null,
	wind: null, trackDeg: null, sun: null, fence: null, targetDistM: null,
};

export const $derived = atom<DerivedState>(EMPTY_DERIVED);

// Terrain height is sampled from the globe's loaded tiles, which only the Cesium
// layer can do. It publishes here so the derived state stays Cesium-free.
let terrainSampler: (() => number | null) | null = null;
export function setTerrainSampler(fn: (() => number | null) | null) {
	terrainSampler = fn;
}

// No local bookkeeping any more. Track and wind come from the autopilot's own
// estimator (see below), so there is no anchor fix, no baseline, no smoothing and
// nothing to leak across a reconnect.
/** Drop all derived state and its bookkeeping.
 *
 *  This must happen on a link loss as well as on a lost fix. The anchor,
 *  held track and smoothed wind are history, and replaying them after a gap
 *  would present stale geometry as current — the same failure mode as a frozen
 *  position reported "alive". */
export function resetDerived(): void {
	$derived.set(EMPTY_DERIVED);
}

/** Recompute from the current frame. Called on each $hudFrame change. */
export function recomputeDerived(): void {
	const f = $hudFrame.get();
	// A disconnected frame is not a position report, even if it carries a stale
	// lat/lon, so the derived state goes with it.
	if (!f || !f.connected || !isNum(f.lat) || !isNum(f.lon)) {
		resetDerived();
		return;
	}

	// Track comes straight from the EKF velocity (GLOBAL_POSITION_INT vx/vy,
	// Doppler-derived), computed in gs. It replaced a position-differencing
	// reconstruction here that needed a 30 m baseline and smoothing just to beat
	// the GPS noise it was amplifying.
	const trackDeg = isNum(f.trackDeg) ? f.trackDeg : null;

	const terrainM = terrainSampler ? terrainSampler() : null;
	const agl = aglM(f.alt, terrainM ?? undefined);

	// Heading is where the nose points. Prefer the attitude yaw (radians, from
	// ATTITUDE) over the GPS-derived `heading` field, which on some stacks is
	// actually course over ground and would make the wind triangle degenerate.
	const headingDeg = isNum(f.yaw)
		? ((f.yaw * 180) / Math.PI + 360) % 360
		: (isNum(f.heading) ? f.heading : null);

	// Wind is PX4's EKF2 estimate (WIND_COV), not a triangle solved here. The
	// estimator fuses airspeed, GPS velocity and a sideslip model, and reports an
	// uncertainty — which a hand-rolled triangle cannot. `sigmaMps` lets the UI
	// say "unreliable" rather than being believed.
	//
	// NOTE: PX4 only produces this once EKF2 has a wind estimate, which needs an
	// airspeed sensor and some flight time. Before then it is null, and the UI
	// shows a dash rather than inventing a number.
	const wind: Wind | null = (isNum(f.windSpeed) && isNum(f.windFromDeg))
		? {
			fromDeg: f.windFromDeg,
			speedMps: f.windSpeed,
			// Drift is still geometry, not an estimate: track minus heading.
			driftDeg: (headingDeg !== null && trackDeg !== null)
				? angleDiffDeg(trackDeg, headingDeg) : 0,
			sigmaMps: isNum(f.windSigma) ? f.windSigma : undefined,
		}
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
		targetDistM: (isNum(f.targetLat) && isNum(f.targetLon))
			? distanceM(f.lat, f.lon, f.targetLat, f.targetLon)
			: null,
	});
}

/** Wire the recompute to its inputs. Returns an unsubscribe. */
export function startDerived(): () => void {
	const offs = [$hudFrame.listen(recomputeDerived), $fenceItems.listen(recomputeDerived)];
	return () => offs.forEach((o) => o());
}
