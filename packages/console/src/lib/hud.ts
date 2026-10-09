// Flight instrument geometry: the heading tape, the two vertical tapes, and the
// compact attitude ball.
//
// Everything here is a pure function of the flight state, so the symbology is
// testable without a browser: an attitude ball that banks the wrong way, or a
// heading tape that wraps wrongly through north, is a numeric bug and should be
// caught as one. The components do nothing but turn these into SVG.
//
// Conventions, which are the aviation ones rather than invented:
//
//  * The aircraft reference never moves; the horizon moves against it. So the
//    horizon ROTATES by minus the bank angle and TRANSLATES by the pitch —
//    climbing pushes the horizon down.
//  * Tapes scroll against a fixed pointer. The number under the pointer is the
//    current value; it is also boxed, because reading a tape to the nearest
//    unit is slower than reading a digit.
//
// A screen-height pitch ladder, a full-width horizon and a flight path marker
// used to live here too, for a cockpit HUD through the centre of the globe. They
// were removed with it: see Hud.tsx for why that metaphor was wrong here. Git
// has them if a cockpit view ever earns its place.

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

// --- compact attitude ball ----------------------------------------------------

export interface BallMark {
	deg: number;
	/** Offset from the ball centre, px, positive DOWN the screen. */
	offsetPx: number;
	/** Half-length of the mark, px. */
	armPx: number;
	/** Every second mark is longer, so the scale can be counted at a glance.
	 *  The exact angles are in the readout under the ball; a 92 px disc is too
	 *  small to carry legible numbers of its own. */
	major: boolean;
}

/**
 * Pitch marks for the small attitude ball.
 *
 * Separate from `ladderRungs` because the constraints are different: the ball is
 * a ~92 px disc, so it carries a 10 degree scale clipped to the disc rather than
 * a full screen-height ladder, and marks are culled against the radius instead
 * of the viewport.
 *
 * As with the big ladder, climbing moves the horizon DOWN, so a mark at `deg`
 * sits (pitch - deg) * pxPerDeg below centre.
 */
export function ballPitchMarks(
	pitchDeg: number, radiusPx: number, pxPerDeg: number, step = 10,
): BallMark[] {
	if (!Number.isFinite(pitchDeg)) return [];
	const out: BallMark[] = [];
	const limit = 90;
	for (let deg = -limit; deg <= limit; deg += step) {
		if (deg === 0) continue;                      // the horizon line itself
		const offsetPx = (pitchDeg - deg) * pxPerDeg;
		// Keep marks inside the disc, with margin so a mark never kisses the rim.
		// The margin and `pxPerDeg` have to be chosen together: too fine a scale
		// and this culls the long marks, leaving a disc with a horizon and two
		// anonymous ticks. At 1.2 px/deg and this margin, +-10, +-20 and +-30 all
		// fit at level flight.
		if (Math.abs(offsetPx) > radiusPx * 0.8) continue;
		out.push({
			deg,
			offsetPx,
			armPx: Math.abs(deg) % 20 === 0 ? radiusPx * 0.3 : radiusPx * 0.17,
			major: Math.abs(deg) % 20 === 0,
		});
	}
	return out;
}

/** Is this bank tick a major (longer) one? Dense near level, where small
 *  corrections matter; sparse past 30, where the exact number does not. */
export function bankMajor(deg: number): boolean {
	return deg === 0 || Math.abs(deg) === 30 || Math.abs(deg) === 60;
}

/** Bank ticks around the rim of the ball, in degrees from vertical. */
export const BALL_BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60] as const;

/** Roll as an operator reads it aloud: "4 R", "12 L", "level". */
export function rollLabel(rollDeg: number | null): string {
	if (rollDeg === null || !Number.isFinite(rollDeg)) return "--";
	const r = Math.round(rollDeg);
	if (r === 0) return "level";
	return `${Math.abs(r)}\u00b0 ${r > 0 ? "R" : "L"}`;
}

/** Pitch as a signed number of degrees with an explicit sign. */
export function pitchLabel(pitchDeg: number | null): string {
	if (pitchDeg === null || !Number.isFinite(pitchDeg)) return "--";
	const p = Math.round(pitchDeg);
	return `${p > 0 ? "+" : ""}${p}\u00b0`;
}
