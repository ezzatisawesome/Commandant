// Two altitudes, and which one a mission item means.
//
// This is the bug that made authored missions fly wrong, and it was invisible
// because both numbers are "metres" and both were roughly 200:
//
//   frame.alt          height above MEAN SEA LEVEL (GLOBAL_POSITION_INT.alt)
//   frame.relativeAlt  height above HOME            (…relative_alt)
//
// A mission item's `alt` goes to PX4 as MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, so it
// is the SECOND of those. But the console only had the first, so clicking the
// globe seeded a waypoint with an MSL number that PX4 then flew as above-home.
//
// Measured on the live vehicle: alt 206.9 m MSL against relativeAlt 97.8 m, so
// home sits at 109 m and every authored waypoint was 109 m TOO HIGH. (An
// earlier guess of ~30 m from terrain elevation was badly short — which is the
// argument for reading the number rather than estimating it.) It is also why a
// landing taken from the aircraft's altitude sat well above the ground.
//
// Cesium, meanwhile, draws at MSL. So the plan has to be CONVERTED to be drawn,
// which needs home's own elevation. Home is the difference between the two
// numbers the autopilot already reports, so nothing extra has to be plumbed:
//
//   homeAltM = alt - relativeAlt
//
// Keeping that arithmetic in one tested place is the point. Every one of these
// conversions is a sign error waiting to happen, and a sign error here flies an
// aircraft into terrain while every number on screen looks plausible.

export interface AltSource {
	alt?: number;
	relativeAlt?: number;
}

const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Elevation of HOME above mean sea level, or null when the vehicle has not
 * reported both altitudes.
 *
 * Null is meaningful and must not be coerced to 0: treating an unknown home as
 * sea level silently reintroduces exactly the error this module exists to fix,
 * on terrain where it matters most.
 */
export function homeAltM(f: AltSource | null | undefined): number | null {
	const a = num(f?.alt);
	const r = num(f?.relativeAlt);
	if (a === null || r === null) return null;
	return a - r;
}

/**
 * The altitude to AUTHOR a new mission item with: height above home, matching
 * the frame the item uploads in.
 *
 * Falls back to MSL only when the vehicle has not reported a relative altitude,
 * because some number is better than none for a waypoint the operator is about
 * to drag anyway — but the caller is told which it got, so the UI can say so
 * rather than implying a precision it does not have.
 */
export function authoringAltM(f: AltSource | null | undefined): { alt: number; relative: boolean } {
	const r = num(f?.relativeAlt);
	if (r !== null) return { alt: Math.max(0, r), relative: true };
	const a = num(f?.alt);
	return { alt: a !== null ? Math.max(0, a) : 0, relative: false };
}

/**
 * Convert a mission item's above-home altitude to the MSL height Cesium draws
 * at. With home unknown, the relative number is the honest best guess and the
 * plan sits low by home's elevation — visibly wrong rather than wrong in a way
 * that affects what is uploaded.
 */
export function drawHeightM(itemAltM: number | undefined, home: number | null): number {
	const a = num(itemAltM) ?? 0;
	return home === null ? a : a + home;
}

/** Inverse of drawHeightM: an MSL height picked off the globe, as above-home. */
export function toRelativeM(mslM: number, home: number | null): number {
	const a = num(mslM) ?? 0;
	return home === null ? a : a - home;
}
