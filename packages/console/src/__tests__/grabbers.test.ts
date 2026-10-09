import { describe, it, expect } from "vitest";

import {
	ALT_MAX_M,
	ALT_SAMPLE_M,
	RADIUS_MAX_M,
	RADIUS_MIN_M,
	altDeltaFromDrag,
	altFromDrag,
	clampAlt,
	clampRadius,
	defaultRadius,
	radiusParamKey,
	snap,
} from "@/lib/grabbers";

// The grabber maths decides what a pixel of mouse travel costs in metres of
// altitude. Getting the SIGN wrong here is the kind of bug that flies an
// aircraft into terrain while the operator is sure they dragged upwards, so the
// axis conventions are pinned explicitly rather than inferred from the code.
describe("altDeltaFromDrag", () => {
	// Screen Y grows downward, so a camera with the world's vertical pointing up
	// the screen projects +100 m as a NEGATIVE y vector.
	const upOnScreen = { x: 0, y: -50 }; // 100 m occupies 50 px, up the screen

	it("dragging up the screen raises altitude", () => {
		// Mouse moved 50 px up => -50 in screen coords => one full sample up.
		expect(altDeltaFromDrag({ x: 0, y: -50 }, upOnScreen)).toBeCloseTo(ALT_SAMPLE_M);
	});

	it("dragging down the screen lowers altitude", () => {
		expect(altDeltaFromDrag({ x: 0, y: 50 }, upOnScreen)).toBeCloseTo(-ALT_SAMPLE_M);
	});

	it("scales linearly with drag distance", () => {
		expect(altDeltaFromDrag({ x: 0, y: -25 }, upOnScreen)).toBeCloseTo(ALT_SAMPLE_M / 2);
		expect(altDeltaFromDrag({ x: 0, y: -100 }, upOnScreen)).toBeCloseTo(ALT_SAMPLE_M * 2);
	});

	it("ignores drag across the vertical, not along it", () => {
		// Sideways travel is not altitude: the operator is moving the mouse past
		// the handle, not up it.
		expect(altDeltaFromDrag({ x: 80, y: 0 }, upOnScreen)).toBeCloseTo(0);
	});

	it("follows a tilted vertical rather than the screen Y axis", () => {
		// Camera rolled/tilted so 100 m projects diagonally.
		const tilted = { x: 30, y: -40 }; // length 50 px
		// A drag along that same diagonal is one full sample.
		expect(altDeltaFromDrag({ x: 30, y: -40 }, tilted)).toBeCloseTo(ALT_SAMPLE_M);
		// A drag perpendicular to it is none of it.
		expect(altDeltaFromDrag({ x: 40, y: 30 }, tilted)).toBeCloseTo(0);
	});

	it("refuses to guess when the vertical collapses on screen", () => {
		// Straight-down camera: height has nowhere to project, so a pixel of
		// jitter must not become a kilometre of altitude.
		expect(altDeltaFromDrag({ x: 10, y: 10 }, { x: 0, y: 0 })).toBe(0);
		expect(altDeltaFromDrag({ x: 10, y: 10 }, { x: 0.2, y: -0.3 })).toBe(0);
	});

	it("survives non-finite input", () => {
		expect(altDeltaFromDrag({ x: NaN, y: 0 }, upOnScreen)).toBe(0);
		expect(altDeltaFromDrag({ x: 0, y: -50 }, { x: NaN, y: NaN })).toBe(0);
	});
});

describe("altFromDrag", () => {
	it("adds the drag to the starting altitude", () => {
		expect(altFromDrag(200, { x: 0, y: -50 }, { x: 0, y: -50 })).toBeCloseTo(300);
	});

	it("never drags a waypoint below the ground", () => {
		expect(altFromDrag(20, { x: 0, y: 500 }, { x: 0, y: -50 })).toBe(0);
	});

	it("never drags one into orbit", () => {
		expect(altFromDrag(100, { x: 0, y: -100000 }, { x: 0, y: -50 })).toBe(ALT_MAX_M);
	});
});

describe("clampAlt / clampRadius", () => {
	it("clamps altitude to the flyable band", () => {
		expect(clampAlt(-5)).toBe(0);
		expect(clampAlt(450)).toBe(450);
		expect(clampAlt(1e9)).toBe(ALT_MAX_M);
		expect(clampAlt(NaN)).toBe(0);
	});

	it("keeps a radius positive and finite", () => {
		// A zero or negative radius is not a small circle, it is a degenerate
		// entity Cesium will not draw and PX4 will not accept.
		expect(clampRadius(0)).toBe(RADIUS_MIN_M);
		expect(clampRadius(-80)).toBe(RADIUS_MIN_M);
		expect(clampRadius(250)).toBe(250);
		expect(clampRadius(1e9)).toBe(RADIUS_MAX_M);
		expect(clampRadius(NaN)).toBe(RADIUS_MIN_M);
	});
});

describe("snap", () => {
	it("stays metre-accurate down low", () => {
		expect(snap(23.4)).toBe(23);
		expect(snap(49.6)).toBe(50);
	});

	it("coarsens with magnitude", () => {
		expect(snap(247.83)).toBe(250);   // 5 m steps in the hundreds
		expect(snap(1013)).toBe(1025);    // 25 m steps in the thousands
		expect(snap(12_340)).toBe(12_300); // 100 m steps above that
	});
});

describe("radiusParamKey", () => {
	it("maps loiter kinds to the orbit radius", () => {
		for (const k of ["loiter_unlim", "loiter_time", "loiter_turns"]) {
			expect(radiusParamKey(k)).toBe("radius");
		}
	});

	it("maps a waypoint to its accept radius, a different wire param", () => {
		expect(radiusParamKey("waypoint")).toBe("acceptRadius");
	});

	it("gives positionless and terminal kinds no radius to drag", () => {
		expect(radiusParamKey("rtl")).toBeNull();
		expect(radiusParamKey("takeoff")).toBeNull();
		expect(radiusParamKey("land")).toBeNull();
	});

	it("offers a tighter default for an accept radius than for an orbit", () => {
		expect(defaultRadius("waypoint")).toBeLessThan(defaultRadius("loiter_unlim"));
	});
});
