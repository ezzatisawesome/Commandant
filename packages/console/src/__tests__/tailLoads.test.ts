import { describe, it, expect } from "vitest";
import { Cartesian3, JulianDate } from "cesium";

import { nodeTransformations, type ModelAnimation } from "@/lib/modelAnimation";
import { sideslipRad, tailForceN, type TailSurfaceSpec } from "@/lib/wingLoads";
import type { TelemetryFrame } from "@/types/app";

// The tail's live loads: the force model is the sim's (the model's extras,
// mesh.py _tail_loads, signs in the FDM's convention); this applies it.

const frame = (f: Partial<TelemetryFrame>): TelemetryFrame =>
	({ t: 0, connected: true, loadFactor: 1, airspeed: 10, ...f }) as TelemetryFrame;

// rev7's, as the sim writes them
const HSTAB: TailSurfaceSpec = {
	surface: "HStab", axis: [0, 0, 1], trim_N_1g: 0.8, S_ref_m2: 1.86,
	control: "elevator", control_per_rad: 0.25, control_rad_per_pct: -0.0026180, beta_per_rad: 0,
};
const FIN: TailSurfaceSpec = {
	surface: "VStab", axis: [0, 1, 0], trim_N_1g: 0, S_ref_m2: 1.86,
	control: "rudder", control_per_rad: 0.12, control_rad_per_pct: -0.0034907, beta_per_rad: -0.17,
};
const qS = 0.5 * 1.225 * 100 * 1.86;
// calm, flying north, nose north: no sideslip
const STRAIGHT = { vn: 10, ve: 0, yaw: 0, windSpeed: 0, windFromDeg: 0 };

describe("tail loads", () => {
	it("carries the trim load times n, and an up-elevator pushes the tail down", () => {
		expect(tailForceN(HSTAB, frame({ loadFactor: 2 }))).toBeCloseTo(1.6);
		// +50 % is trailing edge up: the FDM's -0.131 rad, a down-load
		expect(tailForceN(HSTAB, frame({ elevator: 50 }))!).toBeCloseTo(0.8 + qS * 0.25 * 50 * -0.002618, 3);
		expect(tailForceN(HSTAB, frame({ elevator: 50 }))!).toBeLessThan(0);
	});

	it("reads sideslip from the air-relative velocity, + with the air from the right", () => {
		expect(sideslipRad(frame(STRAIGHT))).toBeCloseTo(0);
		// nose 5 deg left of the air's path: the air comes from the right
		expect(sideslipRad(frame({ ...STRAIGHT, yaw: (-5 * Math.PI) / 180 }))!).toBeCloseTo((5 * Math.PI) / 180);
		// 3 m/s from the west, crabbing into it with the nose on the air's path: no sideslip
		const crab = Math.atan2(3, 10);   // ground track north, heading west of it
		expect(sideslipRad(frame({ vn: 10, ve: 0, windSpeed: 3, windFromDeg: 270, yaw: -crab }))!).toBeCloseTo(0);
	});

	it("puts sideslip and rudder on the fin, signed as the FDM flies them", () => {
		const b = (5 * Math.PI) / 180;
		// air from the right pushes the fin to port (CYb < 0)
		expect(tailForceN(FIN, frame({ ...STRAIGHT, yaw: -b }))!).toBeCloseTo(qS * -0.17 * b, 3);
		// +rudder is trailing edge right: the tail is pushed to port
		expect(tailForceN(FIN, frame({ ...STRAIGHT, rudder: 50 }))!).toBeLessThan(0);
	});

	it("has nothing to say about the fin without a wind estimate, or about any of it without airspeed", () => {
		expect(tailForceN(FIN, frame({ vn: 10, ve: 0, yaw: 0 }))).toBeNull();
		expect(tailForceN(HSTAB, frame({ airspeed: undefined }))).toBeNull();
	});

	it("points a fin bar sideways and a down-loaded H-stab bar down, never flat in one axis", () => {
		const anim: ModelAnimation = {
			surfaces: [], propellers: [], liftBarMetresPerNPerM: 0.1,
			tailSurfaces: [HSTAB, FIN],
			tailBars: [{ node: "h", surface: "HStab", share_per_m: 1.4 }, { node: "v", surface: "VStab", share_per_m: 2.8 }],
		};
		const now = JulianDate.now();
		const f = frame({ ...STRAIGHT, elevator: 50, rudder: 50 });
		const nt = nodeTransformations(anim, { frame: () => f, frameNumber: () => 0 });
		const h = nt.h.getValue(now).scale as Cartesian3;
		const v = nt.v.getValue(now).scale as Cartesian3;
		expect(h.x).toBe(1); expect(h.y).toBe(1); expect(h.z).toBeLessThan(0);
		expect(v.x).toBe(1); expect(v.z).toBe(1); expect(v.y).toBeLessThan(0);
		const off = nodeTransformations(anim, { frame: () => frame({}), frameNumber: () => 0 });
		expect(off.v.getValue(now).scale).toEqual(new Cartesian3(0, 0, 0));
	});
});
