import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	BALL_EDGE_GAP,
	BALL_LABEL_DROP,
	ballBox,
	ballCentre,
	headingTapeBox,
	overlaps,
	type Box,
} from "@/lib/hud";

// Where an instrument sits is geometry, and it is the kind that breaks silently:
// a corner that is clear on a 1440 px laptop is not clear on a 900 px window,
// and two instruments drawn over the same pixels do not throw — they just stop
// being readable. The attitude ball moved from bottom-left to top-right, so the
// corner it moved INTO is pinned here against everything already there.

const BALL_R = 46;

// Viewports to check: a laptop, a small window, a tall portrait panel, and an
// ultrawide. The HUD is sized to the viewport, so every one of these is real.
const VIEWPORTS: Array<[number, number, string]> = [
	[1440, 900, "laptop"],
	[1280, 800, "small laptop"],
	[1024, 768, "small window"],
	[900, 600, "half-screen window"],
	[768, 1024, "portrait"],
	[2560, 1080, "ultrawide"],
	[3440, 1440, "wide desk monitor"],
];

/** The altitude tape's box, mirroring Hud.tsx: x = w - 112, vertically centred,
 *  half-height 92 px, plus two caption lines below and its label gutter. */
function altTapeBox(w: number, h: number): Box {
	const x = w - 112;
	const cy = h / 2;
	// Ticks and labels run to the RIGHT of the spine (side="right").
	return { x0: x - 60, y0: cy - 92, x1: x + 60, y1: cy + 92 + 31 };
}

/** The airspeed tape's box: x = 64, ticks and labels to the LEFT. */
function speedTapeBox(h: number): Box {
	const cy = h / 2;
	return { x0: 64 - 60, y0: cy - 92, x1: 64 + 60, y1: cy + 92 + 31 };
}

describe("the attitude ball sits in the top-right corner", () => {
	it("is anchored to the top and right edges, not the bottom", () => {
		const { cx, cy } = ballCentre(1440, 900, BALL_R);
		expect(cx).toBe(1440 - BALL_R - BALL_EDGE_GAP);
		expect(cy).toBe(BALL_R + BALL_EDGE_GAP);
		// The old placement was bottom-left; both coordinates must have flipped.
		expect(cx).toBeGreaterThan(1440 / 2);
		expect(cy).toBeLessThan(900 / 2);
	});

	it("keeps the same gap from the edges at every viewport", () => {
		for (const [w, h, name] of VIEWPORTS) {
			const box = ballBox(w, h, BALL_R);
			expect(box.y0, name).toBe(BALL_EDGE_GAP);
			expect(w - box.x1, name).toBe(BALL_EDGE_GAP);
		}
	});

	it("stays fully on screen, readout included", () => {
		for (const [w, h, name] of VIEWPORTS) {
			const box = ballBox(w, h, BALL_R);
			expect(box.x0, name).toBeGreaterThanOrEqual(0);
			expect(box.y0, name).toBeGreaterThanOrEqual(0);
			expect(box.x1, name).toBeLessThanOrEqual(w);
			expect(box.y1, name).toBeLessThanOrEqual(h);
		}
	});

	it("does not move when only the height changes", () => {
		// Anchored to the top edge, so a shorter window must not drag it inward —
		// the bug the old bottom-anchored placement had in reverse.
		const a = ballCentre(1440, 900, BALL_R);
		const b = ballCentre(1440, 500, BALL_R);
		expect(a).toEqual(b);
	});

	it("includes its roll/pitch readout in the box it claims", () => {
		const box = ballBox(1440, 900, BALL_R);
		const { cy } = ballCentre(1440, 900, BALL_R);
		// The readout hangs below the rim; a box that stopped at the rim would
		// let the heading tape or a tape caption land on top of the numbers.
		expect(box.y1).toBe(cy + BALL_R + BALL_LABEL_DROP);
		expect(BALL_LABEL_DROP).toBeGreaterThan(0);
	});
});

describe("the ball does not collide with anything already on screen", () => {
	it("clears the heading tape, which owns the top centre", () => {
		for (const [w, h, name] of VIEWPORTS) {
			expect(overlaps(ballBox(w, h, BALL_R), headingTapeBox(w)), name).toBe(false);
		}
	});

	it("clears the altitude tape down the right edge", () => {
		// The tape shares the right side but is vertically centred, so the two
		// only threaten each other in a short window.
		for (const [w, h, name] of VIEWPORTS) {
			expect(overlaps(ballBox(w, h, BALL_R), altTapeBox(w, h)), name).toBe(false);
		}
	});

	it("clears the airspeed tape on the left", () => {
		for (const [w, h, name] of VIEWPORTS) {
			expect(overlaps(ballBox(w, h, BALL_R), speedTapeBox(h)), name).toBe(false);
		}
	});

	it("names the window height at which it WOULD reach the altitude tape", () => {
		// Honest about the limit rather than pretending there isn't one. The ball
		// ends at 22 + 46 + 46 + 15 = 129 px; the tape starts at h/2 - 92. They
		// meet when h/2 - 92 < 129, i.e. below ~442 px of viewport height.
		const ballBottom = BALL_EDGE_GAP + 2 * BALL_R + BALL_LABEL_DROP;
		expect(ballBottom).toBe(129);
		const h = 420;   // shorter than any real browser window on a desktop
		expect(overlaps(ballBox(1440, h, BALL_R), altTapeBox(1440, h))).toBe(true);
		// One pixel of headroom above the threshold and they are clear again.
		const ok = 2 * (ballBottom + 92) + 2;
		expect(overlaps(ballBox(1440, ok, BALL_R), altTapeBox(1440, ok))).toBe(false);
	});
});

describe("overlaps", () => {
	const a: Box = { x0: 0, y0: 0, x1: 10, y1: 10 };

	it("detects a genuine intersection", () => {
		expect(overlaps(a, { x0: 5, y0: 5, x1: 15, y1: 15 })).toBe(true);
	});

	it("treats touching edges as clear, not colliding", () => {
		// Two instruments that abut exactly are fine; a 1 px overlap is not worth
		// failing a layout over either.
		expect(overlaps(a, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBe(false);
		expect(overlaps(a, { x0: 0, y0: 10, x1: 10, y1: 20 })).toBe(false);
	});

	it("is symmetric", () => {
		const b: Box = { x0: 5, y0: 5, x1: 15, y1: 15 };
		expect(overlaps(a, b)).toBe(overlaps(b, a));
	});

	it("separates on either axis alone", () => {
		expect(overlaps(a, { x0: 50, y0: 0, x1: 60, y1: 10 })).toBe(false);
		expect(overlaps(a, { x0: 0, y0: 50, x1: 10, y1: 60 })).toBe(false);
	});
});

// Cesium's own scene-mode button is positioned in CSS, not in React, so it is
// invisible to every other test here — and it lived at top: 14px, right: 14px,
// which is exactly where the ball moved to. The HUD is pointer-events-none, so
// the button kept working while being drawn over: a layout bug that only LOOKS
// broken, and so the kind most likely to ship. Parsing the stylesheet is ugly
// but it is the only way to hold the two in the same assertion.
describe("Cesium's scene-mode toolbar clears the attitude ball", () => {
	const CSS = readFileSync(
		join(__dirname, "..", "app", "globals.css"), "utf8",
	);

	function toolbarRule(prop: string): number {
		const block = CSS.slice(CSS.indexOf(".cesium-viewer-toolbar {"));
		const m = block.slice(0, block.indexOf("}")).match(
			new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`),
		);
		expect(m, `.cesium-viewer-toolbar must set ${prop} in px`).not.toBeNull();
		return Number(m![1]);
	}

	it("is pinned to the right edge, below the ball's readout", () => {
		const top = toolbarRule("top");
		const ballBottom = ballBox(1440, 900, BALL_R).y1;
		expect(top).toBeGreaterThanOrEqual(ballBottom);
	});

	it("does not overlap the ball's box at any viewport", () => {
		// The button is 32 px square in Cesium's own stylesheet.
		const BTN = 32;
		const right = toolbarRule("right");
		const top = toolbarRule("top");
		for (const [w, h, name] of VIEWPORTS) {
			const toolbar: Box = {
				x0: w - right - BTN, y0: top, x1: w - right, y1: top + BTN,
			};
			expect(overlaps(ballBox(w, h, BALL_R), toolbar), name).toBe(false);
		}
	});

	it("is not anchored to the bottom, where the telemetry strip lives", () => {
		const block = CSS.slice(CSS.indexOf(".cesium-viewer-toolbar {"));
		expect(block.slice(0, block.indexOf("}"))).toContain("bottom: auto");
	});
});
