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
