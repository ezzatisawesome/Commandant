import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	$derived, startDerived, recomputeDerived, setTerrainSampler, resetDerived,
	EMPTY_DERIVED,
} from "@/stores/derived.store";
import { $hudFrame, pushFrame } from "@/stores/aircraft.store";
import { $fenceItems, setFenceItems } from "@/stores/geo.store";
import type { TelemetryFrame } from "@/types/app";

const LAT = 37.3985511, LON = -122.148853, GROUND = 111;
const M_PER_DEG = 111_320;

// Track needs a 30 m baseline, not two consecutive fixes: at 10 Hz and 13 m/s
// consecutive fixes are 1.3 m apart against 1.5 m of GPS noise, which fabricated
// 8.6 m/s of wind out of nothing. See windStability.test.ts.
const BASELINE_M = 40;

const frame = (over: Partial<TelemetryFrame> = {}): TelemetryFrame => ({
	t: 1000, connected: true, lat: LAT, lon: LON, alt: 233, ...over,
});

let stop: (() => void) | null = null;
beforeEach(() => {
	$hudFrame.set(null); $fenceItems.set([]); $derived.set(EMPTY_DERIVED);
	setTerrainSampler(null);
	pushFrame(frame({ t: 0, connected: false }));
	resetDerived();          // module-level bookkeeping is not per-test state
	stop = startDerived();
});
afterEach(() => { stop?.(); stop = null; setTerrainSampler(null); });

describe("terrain clearance", () => {
	it("reports AGL once terrain is available, and the band with it", () => {
		setTerrainSampler(() => GROUND);
		pushFrame(frame({ t: 10_000, alt: 233 }));
		const d = $derived.get();
		expect(d.terrainM).toBe(GROUND);
		expect(d.aglM).toBeCloseTo(122, 6);          // the 400 ft we command
		expect(d.clearance).toBe("ok");
	});

	it("is honest about not knowing before tiles load", () => {
		pushFrame(frame({ t: 11_000 }));
		expect($derived.get().aglM).toBeNull();
		expect($derived.get().clearance).toBe("unknown");
	});

	it("escalates the band as clearance shrinks", () => {
		setTerrainSampler(() => GROUND);
		pushFrame(frame({ t: 12_000, alt: GROUND + 20 }));
		expect($derived.get().clearance).toBe("critical");
		pushFrame(frame({ t: 12_100, alt: GROUND + 60 }));
		expect($derived.get().clearance).toBe("low");
	});
});

describe("wind and track come from the autopilot, not from here", () => {
	// These used to be reconstructed by differencing consecutive GPS positions,
	// which at 10 Hz and 13 m/s is a 1.3 m baseline against 1.5 m of GPS noise.
	// It fabricated 8.6 m/s of wind in still air. Both now come from PX4's EKF:
	// track from GLOBAL_POSITION_INT vx/vy, wind from WIND_COV.

	it("reads track straight from the frame", () => {
		pushFrame(frame({ t: 20_000, trackDeg: 123.4 }));
		expect($derived.get().trackDeg).toBeCloseTo(123.4, 6);
	});

	it("reads the estimator's wind, including its uncertainty", () => {
		pushFrame(frame({
			t: 21_000, trackDeg: 0, yaw: 0,
			windSpeed: 4.2, windFromDeg: 270, windSigma: 0.8,
		}));
		const w = $derived.get().wind!;
		expect(w.speedMps).toBeCloseTo(4.2, 6);
		expect(w.fromDeg).toBeCloseTo(270, 6);
		expect(w.sigmaMps).toBeCloseTo(0.8, 6);
	});

	it("shows no wind at all until the estimator has one", () => {
		// PX4 emits WIND_COV only once EKF2 has a wind estimate, which needs an
		// airspeed sensor and some flight time. A dash is the honest answer; the
		// old code invented a number here.
		pushFrame(frame({ t: 22_000, trackDeg: 90, yaw: 1.57, airspeed: 13, groundspeed: 13 }));
		expect($derived.get().wind).toBeNull();
	});

	it("still computes drift, which is geometry rather than an estimate", () => {
		// Nose north, tracking 045: pushed 45 degrees right of the nose.
		pushFrame(frame({
			t: 23_000, yaw: 0, trackDeg: 45, windSpeed: 10, windFromDeg: 270,
		}));
		expect($derived.get().wind!.driftDeg).toBeCloseTo(45, 6);
	});

	it("needs no history, so there is nothing to leak across a reconnect", () => {
		pushFrame(frame({ t: 24_000, trackDeg: 90, windSpeed: 5, windFromDeg: 180 }));
		expect($derived.get().wind).not.toBeNull();
		pushFrame({ t: 24_100, connected: false });       // link drops
		expect($derived.get()).toEqual(EMPTY_DERIVED);
		// One frame is enough to be correct again: no baseline to re-accumulate.
		pushFrame(frame({ t: 24_200, trackDeg: 270, windSpeed: 3, windFromDeg: 90 }));
		expect($derived.get().trackDeg).toBeCloseTo(270, 6);
		expect($derived.get().wind!.speedMps).toBeCloseTo(3, 6);
	});
});

describe("sun", () => {
	it("uses the SIMULATED instant, not the wall clock", () => {
		// Local midnight at this longitude: the sun must be below the horizon even
		// though the test runs at some arbitrary real time.
		pushFrame(frame({ t: 30_000, sunEpochMs: Date.UTC(2026, 5, 22, 8, 8) }));
		expect($derived.get().sun!.elevationDeg).toBeLessThan(0);
		// Local noon on the same day: high.
		pushFrame(frame({ t: 30_100, sunEpochMs: Date.UTC(2026, 5, 21, 20, 8) }));
		expect($derived.get().sun!.elevationDeg).toBeGreaterThan(70);
	});
	it("is null when the sim provides no clock", () => {
		pushFrame(frame({ t: 31_000 }));
		expect($derived.get().sun).toBeNull();
	});
});

describe("fence proximity", () => {
	const square = [
		{ seq: 0, kind: "fence_inclusion" as const, lat: 37.39, lon: -122.16 },
		{ seq: 1, kind: "fence_inclusion" as const, lat: 37.39, lon: -122.14 },
		{ seq: 2, kind: "fence_inclusion" as const, lat: 37.41, lon: -122.14 },
		{ seq: 3, kind: "fence_inclusion" as const, lat: 37.41, lon: -122.16 },
	];

	it("quantifies the nearest boundary instead of just drawing it", () => {
		setFenceItems(square);
		pushFrame(frame({ t: 40_000, lat: 37.4099, lon: -122.15 }));
		const p = $derived.get().fence!;
		expect(p.distanceM).toBeLessThan(20);
		expect(p.violated).toBe(false);
	});

	it("flags a breach of an inclusion fence", () => {
		setFenceItems(square);
		pushFrame(frame({ t: 41_000, lat: 37.42, lon: -122.15 }));
		expect($derived.get().fence!.violated).toBe(true);
	});

	it("recomputes when the fence changes, not only when the aircraft moves", () => {
		pushFrame(frame({ t: 42_000, lat: 37.40, lon: -122.15 }));
		expect($derived.get().fence).toBeNull();
		setFenceItems(square);                       // aircraft has not moved
		expect($derived.get().fence).not.toBeNull();
	});
});

describe("no fix", () => {
	it("resets everything rather than reporting stale geometry", () => {
		setTerrainSampler(() => GROUND);
		pushFrame(frame({ t: 50_000, trackDeg: 0, windSpeed: 5, windFromDeg: 180 }));
		expect($derived.get().wind).not.toBeNull();
		pushFrame({ t: 50_200, connected: true });   // fix lost
		expect($derived.get()).toEqual(EMPTY_DERIVED);
	});
});

describe("tracking error", () => {
	it("measures the gap between the aircraft and its commanded setpoint", () => {
		// This is the number that tells a loiter apart from a decoding bug: on
		// fixed-wing PX4 the loiter setpoint is the orbit CENTRE, so ~one radius of
		// separation is correct, while kilometres is not.
		pushFrame(frame({
			t: 60_000, lat: LAT, lon: LON,
			targetLat: LAT + 805 / M_PER_DEG, targetLon: LON,
		}));
		expect($derived.get().targetDistM).toBeCloseTo(805, -1);
	});

	it("is null when no setpoint is present, rather than zero", () => {
		pushFrame(frame({ t: 61_000, lat: LAT, lon: LON }));
		expect($derived.get().targetDistM).toBeNull();
	});
});
