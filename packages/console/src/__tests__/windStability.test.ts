import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { $derived, startDerived, setTerrainSampler, EMPTY_DERIVED } from "@/stores/derived.store";
import { $hudFrame, pushFrame } from "@/stores/aircraft.store";
import { $fenceItems } from "@/stores/geo.store";
import type { TelemetryFrame } from "@/types/app";

// HYPOTHESIS: track (and therefore wind) is derived from consecutive fixes, and
// the HUD store runs at 10 Hz. At 13 m/s that is a 1.3 m baseline — against the
// sim's own configured GPS noise of 1.5 m CEP. The noise is larger than the
// signal, so the reported wind should be unusable.
//
// If true, the baseline must be longer: accumulate distance before recomputing.

const LAT = 37.3985511, LON = -122.148853, M = 111_320;
const NOISE_M = 1.5;          // matches rev6.bridge-config.xml position_xy_stddev

let stop: (() => void) | null = null;
beforeEach(() => {
	$hudFrame.set(null); $fenceItems.set([]); $derived.set(EMPTY_DERIVED);
	setTerrainSampler(null);
	pushFrame({ t: 0, connected: false });
	stop = startDerived();
});
afterEach(() => { stop?.(); stop = null; });

/** Fly due north at 13 m/s in zero wind, with GPS noise on each fix. */
function flyNorthNoisy(seconds: number, seed = 1) {
	let s = seed;
	const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
	const headings: number[] = [];
	const winds: number[] = [];
	const dt = 0.1;                       // the HUD store's 10 Hz
	for (let i = 0; i < seconds / dt; i++) {
		const trueNorthM = i * 13 * dt;
		pushFrame({
			t: 10_000 + i * 100, connected: true,
			lat: LAT + (trueNorthM + rnd() * 2 * NOISE_M) / M,
			lon: LON + (rnd() * 2 * NOISE_M) / (M * Math.cos(LAT * Math.PI / 180)),
			alt: 233, yaw: 0, airspeed: 13, groundspeed: 13,
		} as TelemetryFrame);
		const d = $derived.get();
		if (d.trackDeg !== null) headings.push(d.trackDeg);
		if (d.wind !== null) winds.push(d.wind.speedMps);
	}
	return { headings, winds };
}

/** Spread of a sample, as a rough standard deviation. */
function spread(xs: number[]): number {
	if (xs.length < 2) return 0;
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

describe("wind stability under realistic GPS noise", () => {
	it("reports a steady track when flying straight in zero wind", () => {
		const { headings } = flyNorthNoisy(60);
		expect(headings.length).toBeGreaterThan(50);
		// Flying due north: the reported track should cluster near 0/360. Measure
		// spread about north, handling the wrap.
		const about0 = headings.map((h) => (h > 180 ? h - 360 : h));
		expect(spread(about0)).toBeLessThan(10);   // degrees — was 56 before the fix
	});

	it("reports near-zero wind when there is none", () => {
		const { winds } = flyNorthNoisy(60);
		expect(winds.length).toBeGreaterThan(50);
		const mean = winds.reduce((a, b) => a + b, 0) / winds.length;
		// True wind is zero. A noise-dominated baseline invents several m/s.
		expect(mean).toBeLessThan(2);   // was 8.6 m/s of invented wind before the fix
	});
});
