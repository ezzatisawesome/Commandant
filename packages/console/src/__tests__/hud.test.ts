import { describe, it, expect } from "vitest";

import {
	wrap180, wrap360, headingTicks, ladderRungs, horizonOffsetPx,
	tapeTicks, flightPathOffset, BANK_TICKS, bankMajor,
	type HudGeometry,
} from "@/lib/hud";

// A HUD that is wrong is worse than no HUD: the operator reads it instead of
// thinking. So the symbology is pinned numerically — sign conventions above all,
// because an inverted horizon or a backwards ladder looks plausible in a
// screenshot and is lethal in use.

const GEO: HudGeometry = { w: 600, h: 400, pxPerDeg: 8 };

describe("angle wrapping", () => {
	it("wraps differences into (-180, 180]", () => {
		expect(wrap180(0)).toBe(0);
		expect(wrap180(190)).toBe(-170);
		expect(wrap180(-190)).toBe(170);
		expect(wrap180(180)).toBe(180);
		expect(wrap180(540)).toBe(180);
	});

	it("wraps bearings into [0, 360)", () => {
		expect(wrap360(-10)).toBe(350);
		expect(wrap360(370)).toBe(10);
		expect(wrap360(360)).toBe(0);
	});
});

describe("heading tape", () => {
	it("puts the current heading under the pointer", () => {
		const ticks = headingTicks(90);
		const centre = ticks.find((t) => t.offsetDeg === 0);
		expect(centre?.deg).toBe(90);
		expect(centre?.label).toBe("E");
	});

	it("scrolls smoothly through north instead of jumping 360 degrees", () => {
		// Heading 005: the tape must show 350 and 000 to the LEFT, not at +350.
		const ticks = headingTicks(5);
		const byDeg = new Map(ticks.map((t) => [t.deg, t.offsetDeg]));
		expect(byDeg.get(350)).toBe(-15);
		expect(byDeg.get(0)).toBe(-5);
		expect(byDeg.get(10)).toBe(5);
		// Nothing may sit absurdly far off: every tick is inside the window.
		for (const t of ticks) expect(Math.abs(t.offsetDeg)).toBeLessThanOrEqual(40);
	});

	it("labels cardinals as letters and the rest as three digits", () => {
		const labels = headingTicks(0, 180, 10, 30)
			.filter((t) => t.label)
			.map((t) => t.label);
		expect(labels).toContain("N");
		expect(labels).toContain("E");
		expect(labels).toContain("S");
		expect(labels).toContain("W");
		expect(labels).toContain("030");
		expect(labels).toContain("210");
	});

	it("marks only labelled ticks as major", () => {
		for (const t of headingTicks(123)) {
			expect(t.major).toBe(t.label !== null);
		}
	});

	it("returns nothing for a missing heading rather than drawing north", () => {
		expect(headingTicks(NaN)).toEqual([]);
	});
});

describe("horizon and pitch ladder", () => {
	it("pushes the horizon DOWN the screen when climbing", () => {
		// This is the sign convention that matters most. Nose up, horizon drops.
		expect(horizonOffsetPx(10, GEO)).toBe(80);
		expect(horizonOffsetPx(-10, GEO)).toBe(-80);
		expect(horizonOffsetPx(0, GEO)).toBe(0);
	});

	it("puts the rung matching current pitch at the centre of the screen", () => {
		// At 10 degrees nose up, the +10 rung is the one you are flying at, so it
		// sits on the aircraft reference, not off near the horizon.
		const rung = ladderRungs(10, GEO).find((r) => r.deg === 10);
		expect(rung?.offsetPx).toBe(0);
	});

	it("places climb rungs above the horizon and dive rungs below", () => {
		const rungs = ladderRungs(0, GEO);
		const up = rungs.find((r) => r.deg === 20);
		const down = rungs.find((r) => r.deg === -20);
		expect(up!.offsetPx).toBeGreaterThan(0);
		expect(down!.offsetPx).toBeLessThan(0);
	});

	it("dashes the dive rungs and leaves climb rungs solid", () => {
		for (const r of ladderRungs(0, GEO)) {
			expect(r.dashed).toBe(r.deg < 0);
		}
	});

	it("never emits a rung for zero, which is the horizon's own line", () => {
		expect(ladderRungs(0, GEO).some((r) => r.deg === 0)).toBe(false);
	});

	it("culls rungs that have left the screen", () => {
		// Steep climb: the dive rungs are far below the bottom edge.
		const rungs = ladderRungs(60, GEO);
		for (const r of rungs) expect(Math.abs(r.offsetPx)).toBeLessThanOrEqual(GEO.h);
		expect(rungs.some((r) => r.deg === -60)).toBe(false);
	});

	it("shortens the steep rungs so the centre stays readable", () => {
		const rungs = ladderRungs(0, GEO);
		const shallow = rungs.find((r) => r.deg === 10)!;
		const steep = rungs.find((r) => r.deg === 40)!;
		expect(steep.armPx).toBeLessThan(shallow.armPx);
	});

	it("returns nothing for a missing pitch rather than drawing level flight", () => {
		expect(ladderRungs(NaN, GEO)).toEqual([]);
	});
});

describe("bank scale", () => {
	it("is symmetric about level", () => {
		const positive = BANK_TICKS.filter((d) => d > 0);
		for (const d of positive) expect(BANK_TICKS).toContain(-d as never);
	});

	it("is denser near level, where small corrections matter", () => {
		const gaps: number[] = [];
		for (let i = 1; i < BANK_TICKS.length; i++) gaps.push(BANK_TICKS[i] - BANK_TICKS[i - 1]);
		// The gap next to level is no wider than the gap out at the extremes.
		expect(Math.min(...gaps)).toBe(10);
		expect(Math.max(...gaps)).toBe(15);
	});

	it("labels level, 30 and 60", () => {
		expect(bankMajor(0)).toBe(true);
		expect(bankMajor(30)).toBe(true);
		expect(bankMajor(-60)).toBe(true);
		expect(bankMajor(10)).toBe(false);
	});
});

describe("vertical tapes", () => {
	it("puts the current value at the pointer", () => {
		const ticks = tapeTicks(214, 2, 10, 4, 60);
		const at = ticks.find((t) => t.value === 214);
		expect(at?.offsetPx).toBe(0);
	});

	it("draws higher values above the pointer", () => {
		const ticks = tapeTicks(214, 2, 10, 4, 60);
		const above = ticks.find((t) => t.value === 220)!;
		const below = ticks.find((t) => t.value === 208)!;
		expect(above.offsetPx).toBeLessThan(0);   // negative y is up
		expect(below.offsetPx).toBeGreaterThan(0);
	});

	it("scales by pixels per unit", () => {
		const ticks = tapeTicks(100, 10, 20, 3, 90);
		const t = ticks.find((x) => x.value === 110)!;
		expect(t.offsetPx).toBe(-30);             // 10 units * 3 px
	});

	it("stays inside the requested half-height", () => {
		for (const t of tapeTicks(13.4, 1, 5, 6, 70)) {
			expect(Math.abs(t.offsetPx)).toBeLessThanOrEqual(70.0001);
		}
	});

	it("labels on the label interval only", () => {
		const ticks = tapeTicks(100, 2, 10, 4, 80);
		expect(ticks.find((t) => t.value === 100)?.label).toBe("100");
		expect(ticks.find((t) => t.value === 102)?.label).toBeNull();
	});

	it("snaps ticks to exact multiples despite float drift", () => {
		// 0.1-sized steps are where a naive accumulator produces 9.999999.
		for (const t of tapeTicks(13.37, 0.5, 2, 20, 60)) {
			expect(Math.abs(t.value * 2 - Math.round(t.value * 2))).toBeLessThan(1e-9);
		}
	});

	it("returns nothing for a missing value or a nonsense scale", () => {
		expect(tapeTicks(NaN, 2, 10, 4, 60)).toEqual([]);
		expect(tapeTicks(10, 0, 10, 4, 60)).toEqual([]);
		expect(tapeTicks(10, 2, 10, 0, 60)).toEqual([]);
	});
});

describe("flight path marker", () => {
	it("sits on the aircraft reference in still-air level flight", () => {
		const o = flightPathOffset(90, 90, 0, 13, GEO)!;
		expect(o.x).toBe(0);
		expect(o.y).toBe(0);
	});

	it("rises above centre in a climb", () => {
		// 13 m/s forward, 1.3 m/s up -> about 5.7 degrees, upward is negative y.
		const o = flightPathOffset(90, 90, 1.3, 13, GEO)!;
		expect(o.y).toBeLessThan(0);
		expect(Math.abs(-o.y / GEO.pxPerDeg - 5.71)).toBeLessThan(0.1);
	});

	it("drops below centre in a descent", () => {
		expect(flightPathOffset(90, 90, -1.3, 13, GEO)!.y).toBeGreaterThan(0);
	});

	it("moves to the side the aircraft is actually drifting toward", () => {
		// Nose 090, going 100: the track is right of the nose, so the marker is
		// right of centre. Getting this backwards would have the operator correct
		// the wrong way in a crosswind.
		const right = flightPathOffset(100, 90, 0, 13, GEO)!;
		expect(right.x).toBeGreaterThan(0);
		expect(right.x).toBe(10 * GEO.pxPerDeg);
		const left = flightPathOffset(80, 90, 0, 13, GEO)!;
		expect(left.x).toBeLessThan(0);
	});

	it("handles drift across north without flinging the marker off screen", () => {
		const o = flightPathOffset(5, 355, 0, 13, GEO)!;
		expect(o.x).toBe(10 * GEO.pxPerDeg);
	});

	it("hides itself below taxi speed, where the angle is meaningless", () => {
		expect(flightPathOffset(90, 90, 0.2, 0.5, GEO)).toBeNull();
	});

	it("hides itself when any input is missing", () => {
		expect(flightPathOffset(null, 90, 0, 13, GEO)).toBeNull();
		expect(flightPathOffset(90, null, 0, 13, GEO)).toBeNull();
		expect(flightPathOffset(90, 90, null, 13, GEO)).toBeNull();
		expect(flightPathOffset(90, 90, 0, null, GEO)).toBeNull();
	});
});
