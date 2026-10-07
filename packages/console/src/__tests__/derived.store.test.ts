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

describe("wind", () => {
	it("needs real movement before it can know the track", () => {
		pushFrame(frame({ t: 20_000, yaw: 0, airspeed: 10, groundspeed: 10 }));
		expect($derived.get().trackDeg).toBeNull();
		expect($derived.get().wind).toBeNull();
	});

	it("solves a headwind from consecutive fixes", () => {
		// Moving north; nose north (yaw 0); airspeed 12, groundspeed 8.
		pushFrame(frame({ t: 21_000, yaw: 0, airspeed: 12, groundspeed: 8 }));
		pushFrame(frame({
			t: 21_100, lat: LAT + BASELINE_M / M_PER_DEG, yaw: 0, airspeed: 12, groundspeed: 8,
		}));
		const d = $derived.get();
		expect(d.trackDeg).toBeCloseTo(0, 0);
		expect(d.wind!.speedMps).toBeCloseTo(4, 2);
		expect(d.wind!.fromDeg).toBeCloseTo(0, 0);   // from the north, on the nose
	});

	it("prefers attitude yaw over the GPS heading field", () => {
		// yaw says east (pi/2); `heading` says north. Track is east. If `heading`
		// were used the triangle would show a huge phantom crosswind.
		pushFrame(frame({ t: 22_000, yaw: Math.PI / 2, heading: 0, airspeed: 10, groundspeed: 10 }));
		pushFrame(frame({
			t: 22_100, lon: LON + BASELINE_M / (M_PER_DEG * Math.cos(LAT * Math.PI / 180)),
			yaw: Math.PI / 2, heading: 0, airspeed: 10, groundspeed: 10,
		}));
		expect($derived.get().wind!.speedMps).toBeCloseTo(0, 1);
	});

	it("holds the last track through a stationary patch rather than flickering", () => {
		pushFrame(frame({ t: 23_000, yaw: 0, airspeed: 10, groundspeed: 10 }));
		pushFrame(frame({ t: 23_100, lat: LAT + BASELINE_M / M_PER_DEG, yaw: 0, airspeed: 10, groundspeed: 10 }));
		const moving = $derived.get().trackDeg;
		expect(moving).not.toBeNull();
		// Same position again: below the baseline, so the last track is held.
		pushFrame(frame({ t: 23_200, lat: LAT + BASELINE_M / M_PER_DEG, yaw: 0, airspeed: 10, groundspeed: 10 }));
		expect($derived.get().trackDeg).toBeCloseTo(moving!, 6);
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
		pushFrame(frame({ t: 50_000, yaw: 0, airspeed: 10, groundspeed: 10 }));
		pushFrame(frame({ t: 50_100, lat: LAT + BASELINE_M / M_PER_DEG, yaw: 0, airspeed: 10, groundspeed: 10 }));
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
