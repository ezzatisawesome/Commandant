import { describe, it, expect } from "vitest";

import { authoringAltM, drawHeightM, homeAltM, toRelativeM } from "@/lib/altFrames";

// The bug these pin, measured on a live flight: the aircraft reported alt 206.9 m
// MSL and relativeAlt 97.8 m. The console seeded a clicked waypoint with 206.9,
// and PX4 flew it as 206.9 ABOVE HOME — because mission items upload as
// GLOBAL_RELATIVE_ALT_INT. Home is at 109 m here, so every authored waypoint was
// 109 m TOO HIGH, and a "landing" taken from the aircraft's altitude sat well
// above the ground.
//
// Both numbers are metres and both were about 200, which is why nothing looked
// wrong. So the conversions are pinned numerically, including the unknown-home
// case, where silently assuming sea level would put the error straight back.

// A frame as the vehicle actually reported it.
const LIVE = { alt: 206.907, relativeAlt: 97.825 };   // home therefore 109.082 m MSL

describe("homeAltM", () => {
	it("derives home's elevation from the two altitudes the autopilot reports", () => {
		expect(homeAltM(LIVE)).toBeCloseTo(109.082, 3);
	});

	it("is null — not zero — when either altitude is missing", () => {
		// Coercing to 0 would treat home as sea level and reintroduce the whole
		// bug on exactly the terrain where it matters.
		expect(homeAltM({ alt: 206.907 })).toBeNull();
		expect(homeAltM({ relativeAlt: 97.825 })).toBeNull();
		expect(homeAltM({})).toBeNull();
		expect(homeAltM(null)).toBeNull();
		expect(homeAltM(undefined)).toBeNull();
	});

	it("is null for non-finite input rather than NaN", () => {
		expect(homeAltM({ alt: NaN, relativeAlt: 10 })).toBeNull();
		expect(homeAltM({ alt: Infinity, relativeAlt: 10 })).toBeNull();
	});

	it("handles home above the aircraft (a descent below launch)", () => {
		expect(homeAltM({ alt: 100, relativeAlt: -20 })).toBe(120);
	});
});

describe("authoringAltM", () => {
	it("authors in the frame the item uploads in: above home", () => {
		const got = authoringAltM(LIVE);
		expect(got.alt).toBeCloseTo(97.825, 3);
		expect(got.relative).toBe(true);
		// Emphatically NOT the MSL number, which is what the old code used — and
		// the gap between them is 109 m of unintended climb.
		expect(got.alt).not.toBeCloseTo(206.907, 1);
		expect(206.907 - got.alt).toBeCloseTo(109.082, 3);
	});

	it("falls back to MSL, and says so, when no relative altitude is reported", () => {
		const got = authoringAltM({ alt: 206.907 });
		expect(got.alt).toBeCloseTo(206.907, 6);
		// The caller is told which frame it got, so the UI can avoid implying a
		// precision it does not have.
		expect(got.relative).toBe(false);
	});

	it("never authors a waypoint below the ground", () => {
		expect(authoringAltM({ alt: 5, relativeAlt: -30 }).alt).toBe(0);
		expect(authoringAltM({ alt: -8 }).alt).toBe(0);
	});

	it("yields a usable zero when the vehicle has said nothing", () => {
		expect(authoringAltM(null)).toEqual({ alt: 0, relative: false });
	});
});

describe("drawHeightM", () => {
	it("lifts an above-home altitude onto an MSL globe", () => {
		// 97.825 above a home at 109.082 draws at the aircraft's own 206.907.
		expect(drawHeightM(97.825, 109.082)).toBeCloseTo(206.907, 6);
	});

	it("draws the relative number unchanged when home is unknown", () => {
		// Visibly low by home's elevation, which is better than pretending: it
		// affects only the drawing, never what is uploaded.
		expect(drawHeightM(97.825, null)).toBeCloseTo(97.825, 6);
	});

	it("treats a missing altitude as zero", () => {
		expect(drawHeightM(undefined, 109)).toBe(109);
		expect(drawHeightM(NaN, 109)).toBe(109);
	});
});

describe("toRelativeM", () => {
	it("is the inverse of drawHeightM", () => {
		for (const home of [0, 109.082, -5, 1800, null]) {
			const rel = 150;
			expect(toRelativeM(drawHeightM(rel, home), home)).toBeCloseTo(rel, 6);
		}
	});

	it("converts a height picked off the globe into the upload frame", () => {
		expect(toRelativeM(206.907, 109.082)).toBeCloseTo(97.825, 6);
	});
});
