import { describe, it, expect } from "vitest";
import { JulianDate, Quaternion } from "cesium";

import { Cartesian3 } from "cesium";
import {
	BLUR_RPM, liftBarHeightM, nodeTransformations, propellerRpm, propellerStepRad, surfaceAngleRad,
	type ModelAnimation, type SurfaceSpec,
} from "@/lib/modelAnimation";
import { wingLoadNow, type WingLoads } from "@/lib/wingLoads";
import type { TelemetryFrame } from "@/types/app";

// The model's moving parts. The sign and throw live in the model's extras the sim
// writes (deg_per_pct); this file only applies them, and must never ask for a
// frame or advance a propeller twice in one.

const frame = (f: Partial<TelemetryFrame>): TelemetryFrame =>
	({ t: 0, connected: true, ...f }) as TelemetryFrame;
const ELEVATOR: SurfaceSpec = { node: "elevator", channel: "elevator", axis: [0, 1, 0], deg_per_pct: -0.15 };

describe("surfaceAngleRad", () => {
	it("is the channel percent times the model's degrees per percent", () => {
		expect(surfaceAngleRad(ELEVATOR, frame({ elevator: 100 }))).toBeCloseTo(-15 * Math.PI / 180);
		expect(surfaceAngleRad(ELEVATOR, frame({ elevator: -40 }))).toBeCloseTo(6 * Math.PI / 180);
	});
	it("clamps a reading past full command", () => {
		expect(surfaceAngleRad(ELEVATOR, frame({ elevator: 250 })))
			.toBeCloseTo(surfaceAngleRad(ELEVATOR, frame({ elevator: 100 })));
	});
	it("leaves the surface neutral when the channel is missing", () => {
		expect(surfaceAngleRad(ELEVATOR, frame({}))).toBe(0);
		expect(surfaceAngleRad(ELEVATOR, null)).toBe(0);
	});
});

describe("propellerStepRad", () => {
	it("is still when disarmed, at zero throttle, or on a stale link", () => {
		expect(propellerStepRad(frame({ armed: false, throttle: 60 }), 2)).toBe(0);
		expect(propellerStepRad(frame({ armed: true, throttle: 0 }), 2)).toBe(0);
		expect(propellerStepRad(frame({ armed: true, throttle: 60, connected: false }), 2)).toBe(0);
	});
	it("turns harder with throttle, always under half the blade spacing (no strobe standstill)", () => {
		const low = propellerStepRad(frame({ armed: true, throttle: 10 }), 2);
		const high = propellerStepRad(frame({ armed: true, throttle: 100 }), 2);
		expect(high).toBeGreaterThan(low);
		expect(high).toBeLessThan(Math.PI / 2);
	});
});

describe("nodeTransformations", () => {
	const anim: ModelAnimation = {
		surfaces: [ELEVATOR],
		propellers: [{ node: "propeller", axis: [1, 0, 0], blades: 2 }],
	};
	const now = JulianDate.now();

	it("builds one transformation per moving node", () => {
		const nt = nodeTransformations(anim, { frame: () => null, frameNumber: () => 0 });
		expect(Object.keys(nt).sort()).toEqual(["elevator", "propeller"]);
	});

	it("advances the propeller once per drawn frame, however often it is read", () => {
		let n = 0;
		const f = frame({ armed: true, throttle: 50 });
		const nt = nodeTransformations(anim, { frame: () => f, frameNumber: () => n });
		const angle = () => {
			const q = nt.propeller.getValue(now).rotation as Quaternion;
			return 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w);
		};
		angle();                    // first drawn frame: the reference
		n = 1;
		const a1 = angle();
		const again = angle();      // read twice in the same frame
		n = 2;
		const a2 = angle();
		const step = propellerStepRad(f, 2);
		expect(a1).toBeCloseTo(step);
		expect(again).toBeCloseTo(a1);
		expect(a2).toBeCloseTo(2 * step);
	});

	it("deflects the elevator from the live frame", () => {
		let f = frame({ elevator: 0 });
		const nt = nodeTransformations(anim, { frame: () => f, frameNumber: () => 0 });
		const q0 = nt.elevator.getValue(now).rotation as Quaternion;
		expect(q0.w).toBeCloseTo(1);
		f = frame({ elevator: 100 });
		const q = nt.elevator.getValue(now).rotation as Quaternion;
		expect(2 * Math.asin(q.y)).toBeCloseTo(-15 * Math.PI / 180);
	});
});

describe("real propeller speed", () => {
	const anim: ModelAnimation = {
		surfaces: [],
		propellers: [{ node: "propeller", disc: "propeller_disc", axis: [1, 0, 0], blades: 2 }],
	};
	const now = JulianDate.now();
	const angleOf = (q: Quaternion) => 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w);

	it("reads the sim's rpm, and 0 on a stale link", () => {
		expect(propellerRpm(frame({ motorRpm: 2200 }))).toBe(2200);
		expect(propellerRpm(frame({ motorRpm: 2200, connected: false }))).toBe(0);
		expect(propellerRpm(frame({}))).toBeNull();
	});

	it("turns the blades at the true rate below the blur speed", () => {
		let n = 0, ms = 0;
		const f = frame({ motorRpm: 60 });               // one rev a second
		const nt = nodeTransformations(anim, { frame: () => f, frameNumber: () => n, nowMs: () => ms });
		nt.propeller.getValue(now);
		n = 1; ms = 100;                                   // 0.1 s later: 36 deg
		expect(angleOf(nt.propeller.getValue(now).rotation as Quaternion)).toBeCloseTo(0.1 * 2 * Math.PI);
		expect((nt.propeller.getValue(now).scale as Cartesian3).x).toBe(1);
		expect((nt.propeller_disc.getValue(now).scale as Cartesian3).x).toBe(0);
	});

	it("swaps the blades for the blur disc at speed", () => {
		let n = 0;
		const f = frame({ motorRpm: BLUR_RPM + 2000 });
		const nt = nodeTransformations(anim, { frame: () => f, frameNumber: () => n, nowMs: () => n * 66 });
		nt.propeller.getValue(now);
		n = 1;
		expect((nt.propeller.getValue(now).scale as Cartesian3).x).toBe(0);
		expect((nt.propeller_disc.getValue(now).scale as Cartesian3).x).toBe(1);
	});
});

describe("wing loads", () => {
	const LOADS: WingLoads = {
		weight_N: 98.48, half_span_m: 3, y_m: [0, 3], lift_N_per_m_1g: [17.8, 8.8],
		root_shear_1g_N: 49.1, root_bending_1g_Nm: 68.0, stall_speed_eas_mps: 8.16,
	};

	it("scales the 1 g root loads by the live load factor", () => {
		const w = wingLoadNow(frame({ loadFactor: 1.5, airspeed: 9.5 }), LOADS)!;
		expect(w.rootBendingNm).toBeCloseTo(102);
		expect(w.rootShearN).toBeCloseTo(73.65);
		// (9.5 / 8.16)^2 = 1.355 g is the stall line at 9.5 m/s: 1.5 g is past it
		expect(w.envelopePct!).toBeCloseTo(110.7, 0);
	});

	it("drops a load factor whose IMU stream has stopped", () => {
		expect(wingLoadNow(frame({ loadFactor: 1, airspeed: 9.5, ages: { imu: 60_000 } }), LOADS)).toBeNull();
		expect(wingLoadNow(frame({ loadFactor: 1, airspeed: 9.5, ages: { imu: 80 } }), LOADS)).not.toBeNull();
	});

	it("gives no stall-load share when not flying (on the ground)", () => {
		expect(wingLoadNow(frame({ loadFactor: 1, airspeed: 0 }), LOADS)!.envelopePct).toBeNull();
	});

	it("has nothing to say without a load factor, or on a stale link", () => {
		expect(wingLoadNow(frame({ airspeed: 9.5 }), LOADS)).toBeNull();
		expect(wingLoadNow(frame({ loadFactor: 1, connected: false }), LOADS)).toBeNull();
	});

	it("stands each lift bar to its station's lift times the load factor", () => {
		const bar = { node: "lift_bar_R00", lift_N_per_m_1g: 17.8 };
		expect(liftBarHeightM(bar, 1.5 / 17.8, frame({ loadFactor: 2 }))).toBeCloseTo(3.0);
		expect(liftBarHeightM(bar, 1.5 / 17.8, frame({}))).toBe(0);
	});

	it("hides the bars when switched off", () => {
		const anim: ModelAnimation = {
			surfaces: [], propellers: [],
			liftBars: [{ node: "lift_bar_R00", lift_N_per_m_1g: 17.8 }], liftBarMetresPerNPerM: 1.5 / 17.8,
		};
		let show = true;
		const nt = nodeTransformations(anim, {
			frame: () => frame({ loadFactor: 1 }), frameNumber: () => 0, showLiftBars: () => show,
		});
		const now = JulianDate.now();
		expect((nt.lift_bar_R00.getValue(now).scale as Cartesian3).z).toBeCloseTo(1.5);
		show = false;
		// Hidden UNIFORMLY: a scale zero in z alone is a singular matrix that
		// Cesium cannot invert, and it stopped the whole scene rendering.
		expect(nt.lift_bar_R00.getValue(now).scale).toEqual(new Cartesian3(0, 0, 0));
	});

	it("never flattens a bar in one axis, which Cesium cannot render", () => {
		const anim: ModelAnimation = {
			surfaces: [], propellers: [],
			liftBars: [{ node: "lift_bar_R00", lift_N_per_m_1g: 17.8 }], liftBarMetresPerNPerM: 1.5 / 17.8,
		};
		const now = JulianDate.now();
		for (const f of [frame({}), frame({ loadFactor: 0 }), frame({ loadFactor: -0.5 }), frame({ loadFactor: 1, connected: false })]) {
			const s = nodeTransformations(anim, { frame: () => f, frameNumber: () => 0 }).lift_bar_R00.getValue(now).scale as Cartesian3;
			const degenerate = (s.x === 0 || s.y === 0 || s.z === 0) && !(s.x === 0 && s.y === 0 && s.z === 0);
			expect(degenerate).toBe(false);
		}
	});
});

describe("the model's own data (glTF extras)", () => {
	it("is read from the .glb's JSON chunk, and absent extras read as null", async () => {
		const { glbExtras } = await import("@/stores/modelMeta.store");
		const glb = (json: object) => {
			const body = new TextEncoder().encode(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, " "));
			const buf = new ArrayBuffer(20 + body.length);
			const v = new DataView(buf);
			v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, buf.byteLength, true);
			v.setUint32(12, body.length, true); v.setUint32(16, 0x4e4f534a, true);
			new Uint8Array(buf, 20).set(body);
			return buf;
		};
		expect(glbExtras(glb({ asset: { version: "2.0" }, extras: { loads: { root_bending_1g_Nm: 68 } } })))
			.toEqual({ loads: { root_bending_1g_Nm: 68 } });
		expect(glbExtras(glb({ asset: { version: "2.0" } }))).toBeNull();
		expect(glbExtras(new ArrayBuffer(8))).toBeNull();
	});
});
