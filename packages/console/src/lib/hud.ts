// Head-up display geometry.
//
// Everything here is a pure function of the flight state, so the symbology is
// testable without a browser: a pitch ladder that reads 10 degrees high, or a
// heading tape that wraps wrongly through north, is a numeric bug and should be
// caught as one. The component does nothing but turn these into SVG.
//
// Conventions, which are the aviation ones rather than invented:
//
//  * The symbology is fixed to the screen and the world moves behind it, the way
//    a real HUD works. So the horizon ROTATES by minus the bank angle and
//    TRANSLATES by the pitch — climbing pushes the horizon down the screen.
//  * Pitch and bank scales are in degrees, converted to pixels by one factor
//    (`pxPerDeg`). Everything shares it, so the ladder and the horizon cannot
//    drift apart.
//  * Tapes scroll against a fixed pointer. The number under the pointer is the
//    current value; it is also boxed, because reading a tape to the nearest
//    unit is slower than reading a digit.

export interface HudGeometry {
	/** Half-width/height of the drawing area, px. */
	w: number;
	h: number;
	/** Pixels per degree for the pitch ladder and horizon translation. */
	pxPerDeg: number;
}

/** Wrap to (-180, 180]. Used wherever a difference of bearings is taken, so a
 *  heading tape crossing north scrolls instead of jumping 360 degrees. */
export function wrap180(deg: number): number {
	let d = ((deg % 360) + 540) % 360 - 180;
	if (d === -180) d = 180;
	return d;
}

/** Normalise negative zero to zero.
 *
 *  `-0` renders identically but compares unequal to `0` under Object.is, which
 *  makes exact assertions on "centred" offsets fail for no real reason. Pinned
 *  here rather than worked around in each test. */
function z(n: number): number {
	return n === 0 ? 0 : n;
}

/** Wrap to [0, 360). */
export function wrap360(deg: number): number {
	return ((deg % 360) + 360) % 360;
}

// --- heading tape -------------------------------------------------------------

export interface HeadingTick {
	/** Signed offset from the pointer, degrees: negative is left of centre. */
	offsetDeg: number;
	/** The compass bearing this tick marks, 0..359. */
	deg: number;
	/** Cardinal letter, a 3-digit label, or null for a minor tick. */
	label: string | null;
	major: boolean;
}

const CARDINALS: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };

/**
 * Ticks for the heading tape: every `step` degrees within `spanDeg` either side
 * of the current heading, labelled every `labelEvery`.
 *
 * Cardinals are letters rather than numbers because "N" is recognised without
 * being read, and north is the one bearing an operator orients from.
 */
export function headingTicks(
	headingDeg: number, spanDeg = 40, step = 10, labelEvery = 30,
): HeadingTick[] {
	if (!Number.isFinite(headingDeg)) return [];
	const hdg = wrap360(headingDeg);
	const out: HeadingTick[] = [];
	// Walk the ticks that fall inside the window, in absolute bearings, so the
	// labels stay attached to their bearing as the tape scrolls through north.
	const first = Math.ceil((hdg - spanDeg) / step) * step;
	for (let d = first; d <= hdg + spanDeg; d += step) {
		const deg = wrap360(d);
		const major = deg % labelEvery === 0;
		out.push({
			offsetDeg: wrap180(d - hdg),
			deg,
			label: major ? (CARDINALS[deg] ?? String(deg).padStart(3, "0")) : null,
			major,
		});
	}
	return out;
}

// --- pitch ladder -------------------------------------------------------------

export interface LadderRung {
	deg: number;
	/** Offset from the horizon in px: positive is UP the screen. */
	offsetPx: number;
	/** Climb rungs are solid, dive rungs dashed — the standard cue for which
	 *  side of the horizon you are reading without checking the sign. */
	dashed: boolean;
	/** Half-length of each rung arm, px. Shallower rungs are shorter so the
	 *  centre of the display stays clear. */
	armPx: number;
}

/**
 * Pitch ladder rungs visible for the current pitch.
 *
 * Only rungs inside the display are returned, so the component never draws
 * hundreds of off-screen lines: at 10 degrees of pitch the ladder has moved and
 * the far rungs have left the screen.
 */
export function ladderRungs(
	pitchDeg: number, geo: HudGeometry, step = 10, limit = 90,
): LadderRung[] {
	if (!Number.isFinite(pitchDeg)) return [];
	const out: LadderRung[] = [];
	for (let deg = -limit; deg <= limit; deg += step) {
		if (deg === 0) continue;                     // the horizon is its own line
		// Screen offset above the horizon. The horizon itself sits `pitch` below
		// centre, so a rung at `deg` sits (deg - pitch) above centre.
		const offsetPx = (deg - pitchDeg) * geo.pxPerDeg;
		if (Math.abs(offsetPx) > geo.h) continue;    // off screen
		out.push({
			deg,
			offsetPx,
			dashed: deg < 0,
			armPx: Math.abs(deg) >= 30 ? geo.w * 0.14 : geo.w * 0.2,
		});
	}
	return out;
}

/** Vertical offset of the horizon line from screen centre, px, positive DOWN.
 *
 *  Climbing moves the horizon down the screen, so this is +pitch * pxPerDeg. */
export function horizonOffsetPx(pitchDeg: number, geo: HudGeometry): number {
	return (Number.isFinite(pitchDeg) ? pitchDeg : 0) * geo.pxPerDeg;
}

// --- bank scale ---------------------------------------------------------------

/** Bank tick angles, degrees. Dense near level where small corrections matter,
 *  sparse past 30 where the exact number does not. */
export const BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60] as const;

/** Is this bank tick a major (labelled, longer) one? */
export function bankMajor(deg: number): boolean {
	return deg === 0 || Math.abs(deg) === 30 || Math.abs(deg) === 60;
}

// --- vertical tapes -----------------------------------------------------------

export interface TapeTick {
	value: number;
	/** Offset from the pointer in px: negative is UP (higher values above). */
	offsetPx: number;
	label: string | null;
	major: boolean;
}

/**
 * Ticks for a vertical tape centred on `value`.
 *
 * `pxPerUnit` sets the scale; `halfPx` is how far the tape extends above and
 * below the pointer. Higher values are drawn upward, which is the convention for
 * both speed and altitude and matches the direction the aircraft moves.
 */
export function tapeTicks(
	value: number, step: number, labelEvery: number,
	pxPerUnit: number, halfPx: number,
): TapeTick[] {
	if (!Number.isFinite(value) || step <= 0 || pxPerUnit <= 0) return [];
	const halfUnits = halfPx / pxPerUnit;
	const first = Math.ceil((value - halfUnits) / step) * step;
	const out: TapeTick[] = [];
	for (let v = first; v <= value + halfUnits; v += step) {
		// Guard against float drift making an exact multiple read as 9.999…
		const snapped = Math.round(v / step) * step;
		const major = Math.abs(snapped % labelEvery) < step / 2;
		out.push({
			value: snapped,
			offsetPx: z(-(snapped - value) * pxPerUnit),
			label: major ? String(snapped) : null,
			major,
		});
	}
	return out;
}

// --- flight path marker -------------------------------------------------------

/**
 * Where the flight path marker sits relative to the horizon: the direction the
 * aircraft is actually going, as opposed to where its nose points.
 *
 * Returns screen offsets in px from the CENTRE, positive x right and positive y
 * down. Horizontally it is the drift (track minus heading); vertically it is the
 * climb angle, which is the arcsine of climb rate over groundspeed-with-climb.
 *
 * Returns null when the aircraft is too slow for the angle to mean anything,
 * rather than drawing a marker that swings wildly at taxi speed.
 */
export function flightPathOffset(
	trackDeg: number | null, headingDeg: number | null,
	climbMps: number | null, groundspeedMps: number | null,
	geo: HudGeometry,
): { x: number; y: number } | null {
	if (trackDeg === null || headingDeg === null) return null;
	if (climbMps === null || groundspeedMps === null) return null;
	if (!Number.isFinite(groundspeedMps) || groundspeedMps < 2) return null;
	const driftDeg = wrap180(trackDeg - headingDeg);
	const climbDeg = Math.atan2(climbMps, groundspeedMps) * 180 / Math.PI;
	return {
		x: z(driftDeg * geo.pxPerDeg),
		// Climbing puts the marker ABOVE centre, so negative y.
		y: z(-climbDeg * geo.pxPerDeg),
	};
}
