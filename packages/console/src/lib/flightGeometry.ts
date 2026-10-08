// Pure flight geometry: the numbers behind the globe overlays.
//
// Deliberately free of Cesium and of any store, so each one is a function of its
// inputs and can be tested directly. The Cesium layers read these; they never
// reimplement them.

export const R_EARTH_M = 6_371_000;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** A finite number. gs sends `null` for non-finite floats, so `typeof` is not enough. */
export function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

// --- bearings and distances ---------------------------------------------------

/** Great-circle distance in metres. Haversine: stable for the short legs we care
 *  about, where the planar approximation starts to lie near the poles. */
export function distanceM(
	lat1: number, lon1: number, lat2: number, lon2: number,
): number {
	const dLat = (lat2 - lat1) * DEG;
	const dLon = (lon2 - lon1) * DEG;
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
	return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing, degrees true, 0..360. */
export function bearingDeg(
	lat1: number, lon1: number, lat2: number, lon2: number,
): number {
	const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
	const y = Math.sin(dl) * Math.cos(p2);
	const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
	return (Math.atan2(y, x) * RAD + 360) % 360;
}

/** Smallest signed difference a - b, in (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
	let d = ((a - b) % 360 + 540) % 360 - 180;
	if (d === -180) d = 180;
	return d;
}

// --- wind triangle ------------------------------------------------------------

export interface Wind {
	/** Direction the wind blows FROM, degrees true — the aviation convention. */
	fromDeg: number;
	speedMps: number;
	/** Track minus heading, degrees. Positive = pushed right of the nose. */
	driftDeg: number;
	/** 1-sigma horizontal uncertainty from the estimator, m/s, when known. */
	sigmaMps?: number;
}

/**
 * Solve the wind triangle from heading/airspeed and track/groundspeed.
 *
 * NOT used by the app: wind comes from PX4's EKF2 via WIND_COV, which fuses the
 * same inputs with a sideslip model and reports an uncertainty. This is kept as
 * a documented fallback for a vehicle that reports no WIND_COV, and because the
 * identity below is what makes the estimator's output checkable.
 *
 *   ground velocity = air velocity + wind
 *
 * Air velocity is airspeed along the *heading* (where the nose points); ground
 * velocity is groundspeed along the *track* (where the aircraft actually goes).
 * The difference is the wind. Reported as the direction it blows FROM, because
 * that is what every wind report in aviation means.
 */
export function solveWind(
	headingDeg: number, airspeedMps: number,
	trackDeg: number, groundspeedMps: number,
): Wind | null {
	if (![headingDeg, airspeedMps, trackDeg, groundspeedMps].every(isNum)) return null;
	// Components in a north/east frame.
	const ax = airspeedMps * Math.cos(headingDeg * DEG);   // north
	const ay = airspeedMps * Math.sin(headingDeg * DEG);   // east
	const gx = groundspeedMps * Math.cos(trackDeg * DEG);
	const gy = groundspeedMps * Math.sin(trackDeg * DEG);
	const wx = gx - ax, wy = gy - ay;                      // wind vector (toward)
	const speedMps = Math.hypot(wx, wy);
	// Blowing TOWARD atan2(wy,wx); FROM is the reciprocal.
	const towardDeg = (Math.atan2(wy, wx) * RAD + 360) % 360;
	return {
		fromDeg: (towardDeg + 180) % 360,
		speedMps,
		driftDeg: angleDiffDeg(trackDeg, headingDeg),
	};
}

/** Track (course over ground) from two consecutive fixes, or null if the aircraft
 *  has not moved far enough for the bearing to be meaningful rather than noise. */
export function trackFromFixes(
	prevLat: number, prevLon: number, lat: number, lon: number,
	minMoveM = 1.0,
): number | null {
	if (![prevLat, prevLon, lat, lon].every(isNum)) return null;
	if (distanceM(prevLat, prevLon, lat, lon) < minMoveM) return null;
	return bearingDeg(prevLat, prevLon, lat, lon);
}

// --- solar geometry -----------------------------------------------------------

export interface SunPosition {
	/** Degrees true, 0..360: the compass direction of the sun. */
	azimuthDeg: number;
	/** Degrees above the horizon; negative means below (night). */
	elevationDeg: number;
}

/**
 * Sun azimuth/elevation for a time and place (NOAA solar position, low-precision
 * form). Accurate to a fraction of a degree, which is far better than a solar
 * aircraft's operational needs, and it avoids pulling in an ephemeris.
 *
 * `epochMs` is the SIMULATED instant — the sim drives time-of-day, so this must
 * come from the telemetry frame's `sunEpochMs`, never from the wall clock.
 */
export function sunPosition(epochMs: number, latDeg: number, lonDeg: number): SunPosition | null {
	if (![epochMs, latDeg, lonDeg].every(isNum)) return null;
	// Julian day -> centuries since J2000.
	const jd = epochMs / 86_400_000 + 2_440_587.5;
	const n = jd - 2_451_545.0;
	const L = (280.460 + 0.9856474 * n) % 360;                 // mean longitude
	const g = ((357.528 + 0.9856003 * n) % 360) * DEG;         // mean anomaly
	const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;  // ecliptic lon
	const eps = (23.439 - 0.0000004 * n) * DEG;                // obliquity

	const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
	const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

	// Greenwich mean sidereal time -> local hour angle.
	const gmst = (18.697375 + 24.065709824279 * n) % 24;
	const lst = ((gmst * 15 + lonDeg) % 360 + 360) % 360;
	const ha = (lst * DEG) - ra;

	const phi = latDeg * DEG;
	const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
	const elevationDeg = Math.asin(Math.max(-1, Math.min(1, sinEl))) * RAD;
	const azimuthDeg = (Math.atan2(
		-Math.sin(ha) * Math.cos(dec),
		Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(ha),
	) * RAD + 360) % 360;
	return { azimuthDeg, elevationDeg };
}

// --- geofence proximity -------------------------------------------------------

export interface FencePoint { lat: number; lon: number }

/**
 * Perpendicular distance from a point to a segment, in metres, using a local
 * equirectangular projection. Exact enough well past any fence we would draw,
 * and it keeps the maths readable.
 */
export function distanceToSegmentM(
	lat: number, lon: number,
	aLat: number, aLon: number, bLat: number, bLon: number,
): number {
	const k = Math.cos(lat * DEG);
	const toXY = (la: number, lo: number): [number, number] =>
		[(lo - lon) * DEG * R_EARTH_M * k, (la - lat) * DEG * R_EARTH_M];
	const [ax, ay] = toXY(aLat, aLon);
	const [bx, by] = toXY(bLat, bLon);
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return Math.hypot(ax, ay);
	// Project the origin (our position) onto the segment, clamped to its ends.
	let t = -(ax * dx + ay * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(ax + t * dx, ay + t * dy);
}

export interface FenceProximity {
	/** Metres to the nearest boundary. */
	distanceM: number;
	/** What that boundary is, for the readout. */
	kind: string;
	/** True when crossing it would be a breach: outside an inclusion, or inside
	 *  an exclusion. This is the bit that decides whether to warn. */
	violated: boolean;
}

/** True if a point is inside a polygon (ray casting, lon/lat plane). */
export function pointInPolygon(lat: number, lon: number, poly: FencePoint[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const { lat: yi, lon: xi } = poly[i];
		const { lat: yj, lon: xj } = poly[j];
		if ((xi > lon) !== (xj > lon)
			&& lat < ((yj - yi) * (lon - xi)) / (xj - xi) + yi) {
			inside = !inside;
		}
	}
	return inside;
}

interface FenceLike {
	kind: string;
	lat: number;
	lon: number;
	params?: { radius?: number } & Record<string, unknown>;
}

/**
 * Nearest geofence boundary and whether we are on the wrong side of it.
 *
 * The fence is already drawn on the globe but says nothing numeric, so an
 * operator cannot tell 50 m from 500 m. Polygon vertices arrive as consecutive
 * runs of the same kind (the MAVLink convention), which is how they are grouped.
 */
export function fenceProximity(
	lat: number, lon: number, items: FenceLike[],
): FenceProximity | null {
	if (!isNum(lat) || !isNum(lon) || items.length === 0) return null;
	let best: FenceProximity | null = null;
	const consider = (d: number, kind: string, violated: boolean) => {
		if (!best || d < best.distanceM) best = { distanceM: d, kind, violated };
	};

	// Circles are independent items.
	for (const c of items) {
		if (!c.kind.startsWith("fence_circle")) continue;
		const r = c.params?.radius ?? 0;
		const dCentre = distanceM(lat, lon, c.lat, c.lon);
		const inside = dCentre <= r;
		consider(Math.abs(dCentre - r), c.kind,
			c.kind.includes("inclusion") ? !inside : inside);
	}

	// Polygons: each contiguous run of one kind is one ring.
	let i = 0;
	while (i < items.length) {
		const kind = items[i].kind;
		if (!(kind === "fence_inclusion" || kind === "fence_exclusion")) { i++; continue; }
		let j = i;
		while (j < items.length && items[j].kind === kind) j++;
		const ring = items.slice(i, j).map((p) => ({ lat: p.lat, lon: p.lon }));
		if (ring.length >= 3) {
			let nearest = Infinity;
			for (let k = 0; k < ring.length; k++) {
				const a = ring[k], b = ring[(k + 1) % ring.length];
				nearest = Math.min(nearest,
					distanceToSegmentM(lat, lon, a.lat, a.lon, b.lat, b.lon));
			}
			const inside = pointInPolygon(lat, lon, ring);
			consider(nearest, kind, kind === "fence_inclusion" ? !inside : inside);
		}
		i = j;
	}
	return best;
}

// --- terrain clearance --------------------------------------------------------

/**
 * Height above ground. `terrainM` comes from the globe's loaded tiles and is
 * undefined until they arrive, which is a real state the UI must show honestly
 * rather than reporting a confident zero.
 *
 * This exists because MAVLink gives altitude as MSL, so an operator asked to
 * hold "400 ft AGL" over a 111 m hill has to do arithmetic in their head
 * mid-flight. That is exactly the kind of sum that goes wrong.
 */
export function aglM(altMslM: number | undefined, terrainM: number | undefined): number | null {
	if (!isNum(altMslM) || !isNum(terrainM)) return null;
	return altMslM - terrainM;
}

/** Clearance bands for colouring. Thresholds are deliberately conservative for a
 *  slow aircraft that cannot dive away from terrain. */
export type ClearanceBand = "critical" | "low" | "ok" | "unknown";
export function clearanceBand(agl: number | null): ClearanceBand {
	if (agl === null) return "unknown";
	if (agl < 30) return "critical";
	if (agl < 100) return "low";
	return "ok";
}
