import { describe, it, expect } from "vitest";

import {
	wrap180, wrap360, headingTicks, tapeTicks,
	ballPitchMarks, BALL_BANK_TICKS, bankMajor, rollLabel, pitchLabel,
	quantize, HUD_STEP,
} from "@/lib/hud";

// An instrument that is wrong is worse than no instrument: the operator reads it
// instead of thinking. So the symbology is pinned numerically — sign conventions
// above all, because an inverted horizon looks plausible in a screenshot and is
// lethal in use.

const BALL_R = 46;
const BALL_PX = 1.2;

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

describe("attitude ball", () => {
	it("puts the horizon at the aircraft reference in level flight", () => {
		// Pitch 0 -> the horizon sits at offset 0, which is where the fixed
		// aircraft reference is drawn. Anything else reads as a standing climb.
		const marks = ballPitchMarks(0, BALL_R, BALL_PX);
		expect(marks.some((m) => m.deg === 0)).toBe(false);   // horizon is its own line
		// The +10 mark is one scale step ABOVE the reference...
		expect(marks.find((m) => m.deg === 10)!.offsetPx).toBe(-10 * BALL_PX);
		// ...and -10 one step below.
		expect(marks.find((m) => m.deg === -10)!.offsetPx).toBe(10 * BALL_PX);
	});

	it("moves the scale DOWN as the nose comes up", () => {
		// The sign convention that matters most. At 10 degrees nose up, the mark
		// for 10 degrees is at the aircraft reference, not off near the rim.
		expect(ballPitchMarks(10, BALL_R, BALL_PX).find((m) => m.deg === 10)!.offsetPx)
			.toBe(0);
		// And the horizon-adjacent marks have all shifted downward.
		const level = ballPitchMarks(0, BALL_R, BALL_PX).find((m) => m.deg === -10)!;
		const climbing = ballPitchMarks(10, BALL_R, BALL_PX).find((m) => m.deg === -10)!;
		expect(climbing.offsetPx).toBeGreaterThan(level.offsetPx);
	});

	it("keeps every mark inside the disc", () => {
		for (const pitch of [-40, -10, 0, 10, 40, 85]) {
			for (const m of ballPitchMarks(pitch, BALL_R, BALL_PX)) {
				expect(Math.abs(m.offsetPx), `pitch ${pitch} deg ${m.deg}`)
					.toBeLessThanOrEqual(BALL_R);
			}
		}
	});

	it("lengthens every second mark, so the scale is countable", () => {
		const marks = ballPitchMarks(0, BALL_R, BALL_PX);
		for (const m of marks) expect(m.major).toBe(Math.abs(m.deg) % 20 === 0);
		expect(marks.find((m) => m.deg === 20)!.armPx)
			.toBeGreaterThan(marks.find((m) => m.deg === 10)!.armPx);
	});

	it("actually fits three marks either side at level flight", () => {
		// The scale and the cull margin have to be chosen together. At 1.7 px/deg
		// the 20 degree marks fell outside the disc, so the ball showed a horizon
		// and two anonymous ticks and no countable scale at all. This is that bug.
		const degs = ballPitchMarks(0, BALL_R, BALL_PX).map((m) => m.deg).sort((a, b) => a - b);
		expect(degs).toEqual([-30, -20, -10, 10, 20, 30]);
		expect(ballPitchMarks(0, BALL_R, BALL_PX).filter((m) => m.major)).toHaveLength(2);
	});

	it("returns nothing for a missing pitch rather than drawing level flight", () => {
		expect(ballPitchMarks(NaN, BALL_R, BALL_PX)).toEqual([]);
	});
});

describe("bank scale", () => {
	it("is symmetric about level", () => {
		for (const d of BALL_BANK_TICKS.filter((x) => x > 0)) {
			expect(BALL_BANK_TICKS).toContain(-d as never);
		}
	});

	it("is denser near level, where small corrections matter", () => {
		const gaps: number[] = [];
		for (let i = 1; i < BALL_BANK_TICKS.length; i++) {
			gaps.push(BALL_BANK_TICKS[i] - BALL_BANK_TICKS[i - 1]);
		}
		expect(Math.min(...gaps)).toBe(10);
		expect(Math.max(...gaps)).toBe(15);
	});

	it("marks level, 30 and 60 as major", () => {
		expect(bankMajor(0)).toBe(true);
		expect(bankMajor(30)).toBe(true);
		expect(bankMajor(-60)).toBe(true);
		expect(bankMajor(10)).toBe(false);
	});
});

describe("attitude in words", () => {
	it("says which way the aircraft is banked, the way it is read aloud", () => {
		expect(rollLabel(4)).toBe("4\u00b0 R");
		expect(rollLabel(-12)).toBe("12\u00b0 L");
		expect(rollLabel(0)).toBe("level");
	});

	it("signs the pitch explicitly, so -4 and 4 cannot be confused", () => {
		expect(pitchLabel(4)).toBe("+4\u00b0");
		expect(pitchLabel(-4)).toBe("-4\u00b0");
		expect(pitchLabel(0)).toBe("0\u00b0");
	});

	it("shows a dash rather than a zero when attitude is unknown", () => {
		expect(rollLabel(null)).toBe("--");
		expect(pitchLabel(null)).toBe("--");
		expect(rollLabel(NaN)).toBe("--");
		expect(pitchLabel(NaN)).toBe("--");
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

describe("input quantisation", () => {
	// This is a performance primitive, not cosmetic rounding: it exists so React
	// memo comparisons can succeed on a 10 Hz float feed. A quantiser that
	// returns a value differing in its last bits would defeat its own purpose, so
	// the identity below is the point of the whole function.

	it("returns a value that compares equal across repeated calls", () => {
		// The failure this guards: 0.1 + 0.2 arithmetic producing
		// 0.30000000000000004 and making every frame look like a change.
		const a = quantize(13.37, 0.2);
		const b = quantize(13.38, 0.2);
		expect(a).toBe(b);
		expect(Object.is(a, b)).toBe(true);
	});

	it("holds steady while the input jitters below the step", () => {
		// A real airspeed trace wobbling inside sensor noise must produce one
		// value, or the tape redraws for nothing.
		const jitter = [13.40, 13.42, 13.38, 13.45, 13.36, 13.41];
		const out = new Set(jitter.map((v) => quantize(v, HUD_STEP.speedMps)));
		expect(out.size).toBe(1);
	});

	it("still moves when the input genuinely moves", () => {
		expect(quantize(13.4, 0.2)).not.toBe(quantize(13.8, 0.2));
	});

	it("rounds to the nearest step, not toward zero", () => {
		expect(quantize(10.4, 0.5)).toBe(10.5);
		expect(quantize(10.2, 0.5)).toBe(10);
		expect(quantize(-10.4, 0.5)).toBe(-10.5);
	});

	it("passes through null for anything that is not a finite number", () => {
		// gs sends null for non-finite floats, and an instrument must show a dash
		// rather than a confident zero.
		expect(quantize(null, 0.5)).toBeNull();
		expect(quantize(undefined, 0.5)).toBeNull();
		expect(quantize(NaN, 0.5)).toBeNull();
		expect(quantize(Infinity, 0.5)).toBeNull();
		expect(quantize("12.3", 0.5)).toBeNull();
	});

	it("never rounds a value to beyond the precision its instrument shows", () => {
		// Every step is coarser than the smallest change the display can render.
		for (const step of Object.values(HUD_STEP)) {
			expect(step).toBeGreaterThan(0);
			expect(step).toBeLessThanOrEqual(1);
		}
	});

	it("keeps a quantised integer exact", () => {
		expect(quantize(214, 0.5)).toBe(214);
		expect(quantize(103, 1)).toBe(103);
	});
});
