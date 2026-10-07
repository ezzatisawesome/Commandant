import { describe, it, expect } from "vitest";

import {
	distanceM, bearingDeg, angleDiffDeg, solveWind, trackFromFixes,
	sunPosition, distanceToSegmentM, pointInPolygon, fenceProximity,
	aglM, clearanceBand,
} from "@/lib/flightGeometry";

// Coyote Hill, the site we actually fly: 37.3985511 / -122.148853, ground 111 m.
const LAT = 37.3985511;
const LON = -122.148853;

describe("distance and bearing", () => {
	it("measures a known short leg", () => {
		// 0.001 deg of latitude is ~111.2 m anywhere.
		expect(distanceM(LAT, LON, LAT + 0.001, LON)).toBeCloseTo(111.2, 0);
		// 0.001 deg of longitude shrinks by cos(lat).
		const east = distanceM(LAT, LON, LAT, LON + 0.001);
		expect(east).toBeCloseTo(111.2 * Math.cos(37.3985511 * Math.PI / 180), 0);
	});
	it("is zero for the same point and symmetric", () => {
		expect(distanceM(LAT, LON, LAT, LON)).toBe(0);
		expect(distanceM(LAT, LON, 0, 0)).toBeCloseTo(distanceM(0, 0, LAT, LON), 3);
	});
	it("gives cardinal bearings", () => {
		expect(bearingDeg(LAT, LON, LAT + 0.01, LON)).toBeCloseTo(0, 1);
		expect(bearingDeg(LAT, LON, LAT, LON + 0.01)).toBeCloseTo(90, 1);
		expect(bearingDeg(LAT, LON, LAT - 0.01, LON)).toBeCloseTo(180, 1);
		expect(bearingDeg(LAT, LON, LAT, LON - 0.01)).toBeCloseTo(270, 1);
	});
});

describe("angleDiffDeg", () => {
	it("takes the short way round the circle", () => {
		expect(angleDiffDeg(10, 350)).toBe(20);
		expect(angleDiffDeg(350, 10)).toBe(-20);
		expect(angleDiffDeg(0, 0)).toBe(0);
		expect(Math.abs(angleDiffDeg(180, 0))).toBe(180);
	});
});

describe("solveWind", () => {
	it("reports no wind when track and heading agree at equal speeds", () => {
		const w = solveWind(90, 12, 90, 12)!;
		expect(w.speedMps).toBeCloseTo(0, 6);
		expect(w.driftDeg).toBeCloseTo(0, 6);
	});

	it("names a pure headwind by the direction it blows FROM", () => {
		// Flying east at 12 airspeed but only 8 over the ground: 4 m/s on the nose.
		// Nose points east (090), so the wind comes FROM the east.
		const w = solveWind(90, 12, 90, 8)!;
		expect(w.speedMps).toBeCloseTo(4, 6);
		expect(w.fromDeg).toBeCloseTo(90, 4);
	});

	it("names a pure tailwind as blowing from behind", () => {
		const w = solveWind(90, 12, 90, 16)!;
		expect(w.speedMps).toBeCloseTo(4, 6);
		expect(w.fromDeg).toBeCloseTo(270, 4);
	});

	it("resolves a crosswind into drift", () => {
		// Nose north at 10, but tracking 045 at 10*sqrt(2): a 10 m/s wind from the west.
		const w = solveWind(0, 10, 45, 10 * Math.SQRT2)!;
		expect(w.speedMps).toBeCloseTo(10, 4);
		expect(w.fromDeg).toBeCloseTo(270, 2);
		expect(w.driftDeg).toBeCloseTo(45, 6);   // pushed right of the nose
	});

	it("returns null rather than NaN on missing data", () => {
		expect(solveWind(NaN, 12, 90, 8)).toBeNull();
		expect(solveWind(90, 12, 90, undefined as unknown as number)).toBeNull();
	});
});

describe("trackFromFixes", () => {
	it("ignores jitter below the movement threshold", () => {
		expect(trackFromFixes(LAT, LON, LAT + 1e-7, LON)).toBeNull();
	});
	it("gives the course once the aircraft has actually moved", () => {
		expect(trackFromFixes(LAT, LON, LAT, LON + 0.001)).toBeCloseTo(90, 1);
	});
});

describe("sunPosition", () => {
	it("puts the sun high at local noon and below the horizon at local midnight", () => {
		// 2026-06-21, solar noon at this longitude is ~20:08 UTC (lon/15 = 8.14 h).
		const noon = sunPosition(Date.UTC(2026, 5, 21, 20, 8), LAT, LON)!;
		expect(noon.elevationDeg).toBeGreaterThan(70);   // near solstice, mid-latitude
		const midnight = sunPosition(Date.UTC(2026, 5, 22, 8, 8), LAT, LON)!;
		expect(midnight.elevationDeg).toBeLessThan(0);
	});

	it("rises in the east and sets in the west", () => {
		// Morning: sun east of south, i.e. azimuth < 180. Evening: > 180.
		const morning = sunPosition(Date.UTC(2026, 5, 21, 15, 0), LAT, LON)!;
		const evening = sunPosition(Date.UTC(2026, 5, 22, 1, 0), LAT, LON)!;
		expect(morning.azimuthDeg).toBeLessThan(180);
		expect(evening.azimuthDeg).toBeGreaterThan(180);
	});

	it("is higher in summer than winter at the same local time", () => {
		const summer = sunPosition(Date.UTC(2026, 5, 21, 20, 8), LAT, LON)!;
		const winter = sunPosition(Date.UTC(2026, 11, 21, 20, 8), LAT, LON)!;
		expect(summer.elevationDeg).toBeGreaterThan(winter.elevationDeg + 30);
	});

	it("keeps azimuth in range and rejects bad input", () => {
		const s = sunPosition(Date.UTC(2026, 2, 1, 12, 0), LAT, LON)!;
		expect(s.azimuthDeg).toBeGreaterThanOrEqual(0);
		expect(s.azimuthDeg).toBeLessThan(360);
		expect(sunPosition(NaN, LAT, LON)).toBeNull();
	});
});

describe("distanceToSegmentM", () => {
	it("measures perpendicular distance to the middle of a segment", () => {
		// Segment running east along LAT; stand 0.001 deg north of its midpoint.
		const d = distanceToSegmentM(LAT + 0.001, LON, LAT, LON - 0.01, LAT, LON + 0.01);
		expect(d).toBeCloseTo(111.2, 0);
	});
	it("clamps to an endpoint when the foot falls outside", () => {
		// Well east of the segment's east end: distance is to that end, not the line.
		const d = distanceToSegmentM(LAT, LON + 0.02, LAT, LON - 0.01, LAT, LON + 0.01);
		const toEnd = distanceM(LAT, LON + 0.02, LAT, LON + 0.01);
		expect(d).toBeCloseTo(toEnd, 0);
	});
	it("handles a degenerate zero-length segment", () => {
		const d = distanceToSegmentM(LAT + 0.001, LON, LAT, LON, LAT, LON);
		expect(d).toBeCloseTo(111.2, 0);
	});
});

describe("pointInPolygon", () => {
	const square = [
		{ lat: 37.39, lon: -122.16 }, { lat: 37.39, lon: -122.14 },
		{ lat: 37.41, lon: -122.14 }, { lat: 37.41, lon: -122.16 },
	];
	it("distinguishes inside from outside", () => {
		expect(pointInPolygon(37.40, -122.15, square)).toBe(true);
		expect(pointInPolygon(37.42, -122.15, square)).toBe(false);
		expect(pointInPolygon(37.40, -122.10, square)).toBe(false);
	});
});

describe("fenceProximity", () => {
	const inclusionSquare = [
		{ kind: "fence_inclusion", lat: 37.39, lon: -122.16 },
		{ kind: "fence_inclusion", lat: 37.39, lon: -122.14 },
		{ kind: "fence_inclusion", lat: 37.41, lon: -122.14 },
		{ kind: "fence_inclusion", lat: 37.41, lon: -122.16 },
	];

	it("reports distance to the nearest edge from inside, not violated", () => {
		const p = fenceProximity(37.4099, -122.15, inclusionSquare)!;
		expect(p.violated).toBe(false);
		// ~0.0001 deg from the northern edge.
		expect(p.distanceM).toBeLessThan(20);
		expect(p.kind).toBe("fence_inclusion");
	});

	it("flags a violation once outside an inclusion fence", () => {
		const p = fenceProximity(37.42, -122.15, inclusionSquare)!;
		expect(p.violated).toBe(true);
		expect(p.distanceM).toBeCloseTo(1112, -2);   // ~0.01 deg north of the edge
	});

	it("inverts the verdict for an exclusion fence", () => {
		const excl = inclusionSquare.map((i) => ({ ...i, kind: "fence_exclusion" }));
		expect(fenceProximity(37.40, -122.15, excl)!.violated).toBe(true);   // inside = bad
		expect(fenceProximity(37.42, -122.15, excl)!.violated).toBe(false);  // outside = fine
	});

	it("handles circle fences by radius", () => {
		const circle = [{
			kind: "fence_circle_inclusion", lat: LAT, lon: LON, params: { radius: 500 },
		}];
		const inside = fenceProximity(LAT + 0.001, LON, circle)!;   // ~111 m out of 500
		expect(inside.violated).toBe(false);
		expect(inside.distanceM).toBeCloseTo(389, -1);              // 500 - 111
		const outside = fenceProximity(LAT + 0.01, LON, circle)!;   // ~1112 m out
		expect(outside.violated).toBe(true);
	});

	it("picks the nearest of several boundaries", () => {
		const mixed = [
			...inclusionSquare,
			{ kind: "fence_circle_exclusion", lat: 37.4005, lon: -122.15, params: { radius: 50 } },
		];
		const p = fenceProximity(37.4004, -122.15, mixed)!;
		expect(p.kind).toBe("fence_circle_exclusion");   // the close circle wins
	});

	it("returns null with no fence at all", () => {
		expect(fenceProximity(LAT, LON, [])).toBeNull();
		expect(fenceProximity(NaN, LON, inclusionSquare)).toBeNull();
	});
});

describe("terrain clearance", () => {
	it("subtracts terrain from MSL", () => {
		// The case from a real flight: hold 400 ft AGL over Coyote Hill's 111 m.
		expect(aglM(233, 111)).toBeCloseTo(122, 6);
		expect((aglM(233, 111)! * 3.28084)).toBeCloseTo(400, 0);
	});
	it("is null when terrain tiles have not loaded, rather than a confident zero", () => {
		expect(aglM(233, undefined)).toBeNull();
		expect(aglM(undefined, 111)).toBeNull();
		expect(aglM(233, NaN)).toBeNull();
	});
	it("bands clearance conservatively for a slow aircraft", () => {
		expect(clearanceBand(null)).toBe("unknown");
		expect(clearanceBand(10)).toBe("critical");
		expect(clearanceBand(29.9)).toBe("critical");
		expect(clearanceBand(30)).toBe("low");
		expect(clearanceBand(99.9)).toBe("low");
		expect(clearanceBand(122)).toBe("ok");
	});
});
