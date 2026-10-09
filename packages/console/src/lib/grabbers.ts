// Drag maths for the on-globe grabbers (waypoint altitude, waypoint/circle
// radius). Kept here, free of Cesium, so the arithmetic that decides what a
// pixel of mouse travel means in metres is unit-testable without a scene.
//
// The screen-space problem: a waypoint's altitude handle is dragged with the
// mouse, but "up" on screen is not the screen Y axis — it is wherever the
// world's local vertical happens to project under the current camera. Tilt the
// camera and vertical travel becomes mostly horizontal; look straight down and
// it collapses to almost nothing. So the caller projects two world points (the
// item at its current altitude, and the same item one SAMPLE_M higher), hands
// us that screen-space vector, and we resolve the mouse delta along it.

export interface Vec2 {
	x: number;
	y: number;
}

/** How far apart (metres) the two projected altitude samples are taken. */
export const ALT_SAMPLE_M = 100;

/** Altitude floor/ceiling for a dragged waypoint, metres (relative to home). */
export const ALT_MIN_M = 0;
export const ALT_MAX_M = 30000;

/** Radius floor/ceiling for a dragged loiter or circle-fence radius, metres. */
export const RADIUS_MIN_M = 5;
export const RADIUS_MAX_M = 100000;

export function clampAlt(alt: number): number {
	if (!Number.isFinite(alt)) return ALT_MIN_M;
	return Math.min(ALT_MAX_M, Math.max(ALT_MIN_M, alt));
}

export function clampRadius(r: number): number {
	if (!Number.isFinite(r)) return RADIUS_MIN_M;
	return Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, r));
}

/**
 * Metres of altitude change for a mouse move, by projecting the drag onto the
 * screen-space local vertical.
 *
 * `up` is screen(point at alt + sampleM) - screen(point at alt): the direction
 * and length, in pixels, that `sampleM` metres of height occupies right now.
 * `drag` is the mouse delta in the same pixel space, with Y growing DOWNWARD as
 * every browser reports it — which is why no sign flip appears here. Dragging
 * against `up` (i.e. down the screen when up-is-up) yields a negative result.
 *
 * Returns 0 when the vertical is degenerate on screen (a top-down camera, where
 * the handle has nowhere to travel and any answer would be a wild guess).
 */
export function altDeltaFromDrag(drag: Vec2, up: Vec2, sampleM: number = ALT_SAMPLE_M): number {
	const len2 = up.x * up.x + up.y * up.y;
	// Below ~1 px of travel for the whole sample, the projection is noise: a
	// single pixel of jitter would swing the altitude by hundreds of metres.
	if (!Number.isFinite(len2) || len2 < 1) return 0;
	const along = (drag.x * up.x + drag.y * up.y) / len2;
	const delta = along * sampleM;
	return Number.isFinite(delta) ? delta : 0;
}

/** Apply a drag to a starting altitude, clamped. Convenience for the layers. */
export function altFromDrag(startAlt: number, drag: Vec2, up: Vec2, sampleM: number = ALT_SAMPLE_M): number {
	return clampAlt(startAlt + altDeltaFromDrag(drag, up, sampleM));
}

/**
 * Round a dragged value to a readable step, so a grabber lands on 250 m rather
 * than 247.83 m. Steps coarsen with magnitude: metre-accurate down low, where
 * the operator cares, and tens of metres up high, where they do not.
 */
export function snap(value: number): number {
	const abs = Math.abs(value);
	const step = abs < 50 ? 1 : abs < 500 ? 5 : abs < 5000 ? 25 : 100;
	return Math.round(value / step) * step;
}

/**
 * Which `params` key carries the horizontal "dimension" a mission item's radius
 * grabber edits, or null when the kind has no radius to drag.
 *
 * The two are genuinely different quantities on the MAVLink wire — a loiter
 * radius is the orbit the aircraft flies (param3), a waypoint's accept radius is
 * the sphere that counts as arrival (param2) — so they get different keys and
 * gs packs them into different params. The grabber is the same gesture either
 * way, which is the point: the circle you see on the globe is the number.
 */
export function radiusParamKey(kind: string): string | null {
	if (kind === "loiter_unlim" || kind === "loiter_time" || kind === "loiter_turns") return "radius";
	if (kind === "waypoint") return "acceptRadius";
	return null;
}

/** Default radius (m) shown for a kind that has no explicit one yet. */
export function defaultRadius(kind: string): number {
	return kind === "waypoint" ? 25 : 150;
}
