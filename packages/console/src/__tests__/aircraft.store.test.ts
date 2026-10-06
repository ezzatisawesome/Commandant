import { describe, it, expect, beforeEach } from "vitest";
import { Cartesian3 } from "cesium";

import {
	$aircraftStore, $hudFrame, $historyStore, $trailStore, $targetTrailStore,
	pushFrame, hasFix, appendTrail, sanitizeFrame, isNum,
} from "@/stores/aircraft.store";
import type { TelemetryFrame } from "@/types/app";

const base = (over: Partial<TelemetryFrame> = {}): TelemetryFrame => ({
	t: 1000, connected: true, lat: 37.4, lon: -122.1, alt: 100, ...over,
});

beforeEach(() => {
	$aircraftStore.set(null); $hudFrame.set(null);
	$historyStore.set([]); $trailStore.set([]); $targetTrailStore.set([]);
	// prime the run-boundary state so each test starts "connected"
	pushFrame(base({ t: 0, connected: false }));
	$trailStore.set([]); $historyStore.set([]);
});

describe("hasFix / isNum", () => {
	it("rejects undefined, NaN and the null-island sentinel", () => {
		expect(hasFix(undefined, 1)).toBe(false);
		expect(hasFix(NaN, 1)).toBe(false);
		expect(hasFix(0, 0)).toBe(false);
		expect(hasFix(0.00001, -0.00001)).toBe(false);
		expect(hasFix(37.4, -122.1)).toBe(true);
	});
	it("isNum is strict about finiteness", () => {
		expect(isNum(1.5)).toBe(true);
		expect(isNum(NaN)).toBe(false);
		expect(isNum(null)).toBe(false);
		expect(isNum("1")).toBe(false);
	});
});

describe("sanitizeFrame", () => {
	it("turns wire nulls (gs's NaN) into undefined so no field is ever null", () => {
		const f = sanitizeFrame({ t: 1, connected: true, alt: null, airspeed: 3 } as unknown as TelemetryFrame);
		expect(f.alt).toBeUndefined();
		expect("alt" in f).toBe(true);
		expect(f.airspeed).toBe(3);
	});
	it("pushFrame sanitizes and never throws on a null altitude", () => {
		expect(() => pushFrame({ ...base(), alt: null } as unknown as TelemetryFrame)).not.toThrow();
		expect($aircraftStore.get()?.alt).toBeUndefined();
		expect($trailStore.get()).toHaveLength(0); // no alt -> no trail point
	});
});

describe("pushFrame", () => {
	it("updates the Cesium-rate store every frame but the HUD store at ≤10 Hz", () => {
		let hud = 0, raw = 0;
		const u1 = $hudFrame.listen(() => hud++);
		const u2 = $aircraftStore.listen(() => raw++);
		for (let i = 0; i < 25; i++) pushFrame(base({ t: 10_000 + i * 40 })); // one second at 25 Hz
		u1(); u2();
		expect(raw).toBe(25);
		expect(hud).toBeGreaterThanOrEqual(9);
		expect(hud).toBeLessThanOrEqual(11);
	});
	it("downsamples history to 4 Hz and caps it", () => {
		for (let i = 0; i < 25 * 200; i++) pushFrame(base({ t: 10_000 + i * 40 }));
		const h = $historyStore.get();
		expect(h.length).toBe(480);
		expect(h[1].t - h[0].t).toBeGreaterThanOrEqual(250);
	});
	it("resets trail and history on a vehicle-link rising edge only", () => {
		pushFrame(base({ t: 1 }));
		pushFrame(base({ t: 2, lat: 37.401 }));
		expect($trailStore.get().length).toBeGreaterThan(0);
		pushFrame(base({ t: 3, connected: false }));  // link lost: keep what we have
		expect($trailStore.get().length).toBeGreaterThan(0);
		pushFrame(base({ t: 4 }));                     // back: new run
		expect($trailStore.get().length).toBe(1);
	});
	it("ignores (0,0) and NaN positions for the trail", () => {
		pushFrame(base({ lat: 0, lon: 0 }));
		pushFrame(base({ lat: NaN }));
		expect($trailStore.get()).toHaveLength(0);
	});
});

describe("appendTrail", () => {
	const p = (east: number) => Cartesian3.fromDegrees(-122.1 + east / 111_000, 37.4, 100);
	it("decimates points closer than 2 m and drops >2 km jumps", () => {
		let t = appendTrail([], p(0));
		t = appendTrail(t, p(0.5));     // too close: no new vertex
		expect(t).toHaveLength(1);
		t = appendTrail(t, p(5));       // moved: appended
		expect(t).toHaveLength(2);
		const before = t;
		t = appendTrail(t, p(5000));    // glitch: ignored, same array
		expect(t).toBe(before);
	});
	it("returns the same reference when nothing was appended (no re-upload)", () => {
		const a = appendTrail([], p(0));
		expect(appendTrail(a, p(0.1))).toBe(a);
	});
	it("caps at 3000 points", () => {
		let t: Cartesian3[] = [];
		for (let i = 0; i < 3100; i++) t = appendTrail(t, p(i * 3));
		expect(t).toHaveLength(3000);
	});
});
