// Live wing loads: the model's 1 g spanwise loading (the sim writes it into the
// model's glTF extras, `loads`: Schrenk's approximation from the airframe) scaled by the load
// factor gs reads off PX4's IMU (`loadFactor`, HIGHRES_IMU body z).
//
// Lift only: the wing's own weight relieves the bending and is not subtracted,
// so the bending reads high (conservative). `envelopePct` is how much of the
// load the wing can make at this airspeed before it stalls -- (V / Vstall)^2 --
// it is using: 100 % is the stall line, at any speed.

import { GROUP_STALE_MS, groupAgeMs } from "@/lib/flightGeometry";
import type { TelemetryFrame } from "@/types/app";

export interface WingLoads {
	weight_N: number;
	half_span_m: number;
	y_m: number[];
	lift_N_per_m_1g: number[];
	root_shear_1g_N: number;
	root_bending_1g_Nm: number;
	stall_speed_eas_mps: number;
}

export interface WingLoadNow {
	/** Load factor, g. */
	n: number;
	/** Root bending and shear of one half-wing, from lift alone. */
	rootBendingNm: number;
	rootShearN: number;
	/** n as a share of the stall-limited load factor at this airspeed; null
	 *  without an airspeed. */
	envelopePct: number | null;
}

/** The live load factor, g; null without one, on a stale link, or when the IMU
 *  stream itself has stopped (gs keeps the last value, so its age is the gate,
 *  as for the wind). */
export function loadFactor(frame: TelemetryFrame | null): number | null {
	const n = frame?.loadFactor;
	if (!frame?.connected || typeof n !== "number" || !Number.isFinite(n)) return null;
	const age = groupAgeMs(frame.ages, "imu");
	return age !== null && age > GROUP_STALE_MS ? null : n;
}

/** Below this share of the stall speed the aircraft is not flying (on the
 *  ground, on the roll), and the stall-limited load is meaningless. */
const ENVELOPE_MIN_SPEED_FRAC = 0.5;

export function wingLoadNow(frame: TelemetryFrame | null, loads: WingLoads | null | undefined): WingLoadNow | null {
	const n = loadFactor(frame);
	if (n === null || !loads) return null;
	const v = frame?.airspeed;
	const flying = typeof v === "number" && v > ENVELOPE_MIN_SPEED_FRAC * loads.stall_speed_eas_mps;
	const nStall = flying ? (v / loads.stall_speed_eas_mps) ** 2 : null;
	return {
		n,
		rootBendingNm: n * loads.root_bending_1g_Nm,
		rootShearN: n * loads.root_shear_1g_N,
		envelopePct: nStall ? (100 * n) / nStall : null,
	};
}

// Tail loads: each tail surface's force, live, from the force model the sim
// writes into the model (`animation.tailSurfaces`, aircraftsim mesh.py
// `_tail_loads`) -- the H-stab's lift (+ up), the fins' side force (+ starboard):
//
//   trim_N_1g x n  +  q x S x (control_per_rad x deflection + beta_per_rad x beta)
//
// q from PX4's airspeed (equivalent: VFR_HUD, so sea-level density), the
// deflection from PX4's output percent, and sideslip from the EKF's own
// velocity and wind against the heading (`sideslipRad`).

export interface TailSurfaceSpec {
	surface: string;
	/** The bar's direction in the model frame: [0,0,1] up, [0,1,0] starboard. */
	axis: [number, number, number];
	trim_N_1g: number;
	S_ref_m2: number;
	control: "elevator" | "rudder";
	control_per_rad: number;
	/** The FDM's deflection (rad) per PX4 output percent. */
	control_rad_per_pct: number;
	beta_per_rad: number;
}

const RHO0_KGM3 = 1.225;

/** Sideslip, rad (+ = the air comes from the right, JSBSim's sign): the
 *  air-relative velocity (EKF velocity minus the EKF's wind) against the
 *  heading, in the level plane (bank and climb are not projected out). Null
 *  without the velocity, the heading or a live wind estimate: on a windy day,
 *  ground track alone would read the crab as sideslip. */
export function sideslipRad(frame: TelemetryFrame | null): number | null {
	const f = frame;
	if (!f?.connected) return null;
	const { vn, ve, yaw, windSpeed, windFromDeg } = f;
	if (![vn, ve, yaw, windSpeed, windFromDeg].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
	const age = groupAgeMs(f.ages, "wind");
	if (age !== null && age > GROUP_STALE_MS) return null;
	const from = (windFromDeg! * Math.PI) / 180;
	const aN = vn! + windSpeed! * Math.cos(from);   // the wind blows TOWARD from + 180 deg
	const aE = ve! + windSpeed! * Math.sin(from);
	const u = aN * Math.cos(yaw!) + aE * Math.sin(yaw!);
	const v = -aN * Math.sin(yaw!) + aE * Math.cos(yaw!);
	return u > 1 ? Math.atan2(v, u) : null;           // not flying forward through the air
}

/** A tail surface's force now, N along its axis; null when an input it needs is
 *  missing or stale. */
export function tailForceN(s: TailSurfaceSpec, frame: TelemetryFrame | null): number | null {
	const n = loadFactor(frame);
	const v = frame?.airspeed;
	if (n === null || typeof v !== "number" || !Number.isFinite(v)) return null;
	const pct = frame?.[s.control];
	const delta = typeof pct === "number" && Number.isFinite(pct)
		? Math.max(-100, Math.min(100, pct)) * s.control_rad_per_pct : 0;
	let beta = 0;
	if (s.beta_per_rad !== 0) {
		const b = sideslipRad(frame);
		if (b === null) return null;
		beta = b;
	}
	const qS = 0.5 * RHO0_KGM3 * v * v * s.S_ref_m2;
	return s.trim_N_1g * n + qS * (s.control_per_rad * delta + s.beta_per_rad * beta);
}
