// The aircraft model's moving parts: control surfaces that deflect with PX4's
// outputs, and propellers that spin with throttle.
//
// What moves, about which axis and by how much is the MODEL's to say, not this
// file's: the sim writes it into the model itself (its glTF extras,
// `animation`; stores/modelMeta), from the airframe's own hinge lines and throws, with PX4's sign
// convention already folded into `deg_per_pct`. A model without that block (an
// older mesh, the placeholder) simply does not animate.
//
// Cost. Nothing here asks for a frame. The rotations are CallbackProperties
// read when Cesium draws a frame it was going to draw anyway (driveRendering
// caps those at 15 Hz), each written into the result object Cesium hands in --
// no allocation per frame, a handful of node matrices to update.
//
// The propeller turns at the sim's real rpm (`motorRpm`, JSBSim's propeller),
// integrated over the real time between drawn frames, once per DRAWN frame
// (keyed on the frame number, so a second read in the same frame does not
// double it). Real speed cannot be drawn as blades: cruise is ~2200 rpm, 37
// rev/s, ~900 deg between 15 Hz frames, which strobes into random or backward
// blades. So above BLUR_RPM the blades give way to the model's translucent
// disc -- a spinning propeller as the eye sees it -- and below it (spin-up,
// spin-down, windmilling) the blades turn at their true rate. A feed with no
// rpm falls back to a throttle-driven turn and no disc.
//
// Lift bars (`liftBars`): unit-height bars on the wing's quarter-chord line,
// stood in z to their station's 1 g lift x the live load factor (lib/wingLoads)
// -- the wing's spanwise load as it flies. Hidden (zero height) when switched
// off, on a stale link, or before gs has a load factor.

import { Cartesian3, CallbackProperty, NodeTransformationProperty, Quaternion } from "cesium";

import { loadFactor } from "@/lib/wingLoads";
import type { TelemetryFrame } from "@/types/app";

export interface SurfaceSpec {
	node: string;
	channel: "aileron" | "elevator" | "rudder";
	axis: [number, number, number];
	/** Degrees about `axis` per percent of the channel (-100..100). */
	deg_per_pct: number;
}

export interface PropellerSpec {
	node: string;
	/** The translucent swept-disc node shown instead of the blades at speed. */
	disc?: string;
	axis: [number, number, number];
	blades: number;
}

/** Above this the blades would strobe at 15 Hz: draw the blur disc instead. */
export const BLUR_RPM = 200;

export interface LiftBarSpec {
	node: string;
	/** Lift per metre of span at this station at 1 g, N/m. */
	lift_N_per_m_1g: number;
}

export interface ModelAnimation {
	surfaces: SurfaceSpec[];
	propellers: PropellerSpec[];
	liftBars?: LiftBarSpec[];
	/** A bar's height per (N/m of lift), m. */
	liftBarMetresPerNPerM?: number;
}

/** What drives the animation: the live frame and the render clock, plus the
 *  viewer's display choices. */
export interface AnimationInputs {
	frame: () => TelemetryFrame | null;
	/** Count of DRAWN frames: per-frame state advances once per drawn frame. */
	frameNumber: () => number;
	nowMs?: () => number;
	/** Multiplier on surface deflections (the View panel's exaggeration). */
	surfaceGain?: () => number;
	/** Whether the lift bars are shown. */
	showLiftBars?: () => boolean;
}

const DEG = Math.PI / 180;

/** A surface's deflection now, rad about its axis. A channel the frame does not
 *  carry (no output map yet, an older gs) leaves the surface neutral. */
export function surfaceAngleRad(s: SurfaceSpec, frame: TelemetryFrame | null): number {
	const pct = frame?.[s.channel];
	if (typeof pct !== "number" || !Number.isFinite(pct)) return 0;
	return Math.max(-100, Math.min(100, pct)) * s.deg_per_pct * DEG;
}

/** How far a propeller turns per drawn frame. Still when disarmed, at zero
 *  throttle, or on a stale link (the last frame's throttle is not "now");
 *  otherwise between 35 % and 90 % of half the blade spacing, so the
 *  eye always reads forward rotation (at a whole blade spacing per frame it
 *  would look stopped). */
export function propellerStepRad(frame: TelemetryFrame | null, blades: number): number {
	const thr = frame?.throttle;
	if (!frame?.connected || !frame.armed || typeof thr !== "number" || !(thr > 0.5)) return 0;
	const halfSpacing = Math.PI / Math.max(1, blades);
	return halfSpacing * (0.35 + 0.55 * Math.min(1, thr / 100));
}

/** The propeller's real speed now, rpm; null when the feed carries none. A
 *  stale link reads 0: its last rpm is not now. */
export function propellerRpm(frame: TelemetryFrame | null): number | null {
	const rpm = frame?.motorRpm;
	if (typeof rpm !== "number" || !Number.isFinite(rpm)) return null;
	return frame?.connected ? Math.max(0, rpm) : 0;
}

const ONE = new Cartesian3(1, 1, 1);
// Hiding a node is a UNIFORM zero scale: Cesium special-cases (0, 0, 0) when it
// inverts a node's matrix for lighting, but a scale zero in one axis only is
// singular and throws ("matrix is not invertible"), stopping all rendering.
const ZERO = new Cartesian3(0, 0, 0);
/** Below this a lift bar is hidden (uniform zero), never flattened to 0 in z. */
const LIFT_BAR_MIN_M = 1e-3;

/** A bar's height now, m: zero without a live load factor. */
export function liftBarHeightM(bar: LiftBarSpec, metresPerNPerM: number, frame: TelemetryFrame | null): number {
	const n = loadFactor(frame);
	return n === null ? 0 : Math.max(0, bar.lift_N_per_m_1g * n * metresPerNPerM);
}

/** Cesium nodeTransformations for a model entity (see AnimationInputs). */
export function nodeTransformations(anim: ModelAnimation, inputs: AnimationInputs): Record<string, NodeTransformationProperty> {
	const { frame, frameNumber } = inputs;
	const nowMs = inputs.nowMs ?? (() => performance.now());
	const surfaceGain = inputs.surfaceGain ?? (() => 1);
	const showLiftBars = inputs.showLiftBars ?? (() => true);
	const out: Record<string, NodeTransformationProperty> = {};
	for (const s of anim.surfaces ?? []) {
		const axis = Cartesian3.normalize(Cartesian3.fromArray(s.axis), new Cartesian3());
		out[s.node] = new NodeTransformationProperty({
			rotation: new CallbackProperty(
				(_t, result) => Quaternion.fromAxisAngle(axis, surfaceAngleRad(s, frame()) * surfaceGain(),
					(result as Quaternion | undefined) ?? new Quaternion()),
				false,
			),
		});
	}
	for (const p of anim.propellers ?? []) {
		const axis = Cartesian3.normalize(Cartesian3.fromArray(p.axis), new Cartesian3());
		// One state per propeller, advanced once per drawn frame by whichever of
		// its callbacks Cesium reads first.
		const s = { angle: 0, at: -1, atMs: 0, blurred: false };
		const advance = () => {
			const n = frameNumber();
			if (n === s.at) return;
			const now = nowMs();
			const f = frame();
			const rpm = propellerRpm(f);
			if (s.at >= 0) {
				const step = rpm === null
					? propellerStepRad(f, p.blades) * Math.min(n - s.at, 2)
					: (rpm / 60) * 2 * Math.PI * Math.min(0.25, (now - s.atMs) / 1000);
				s.angle = (s.angle + step) % (2 * Math.PI);
			}
			s.blurred = rpm !== null && rpm >= BLUR_RPM && !!p.disc;
			s.at = n;
			s.atMs = now;
		};
		out[p.node] = new NodeTransformationProperty({
			rotation: new CallbackProperty((_t, result) => {
				advance();
				return Quaternion.fromAxisAngle(axis, s.angle, (result as Quaternion | undefined) ?? new Quaternion());
			}, false),
			scale: new CallbackProperty((_t, result) => {
				advance();
				return Cartesian3.clone(s.blurred ? ZERO : ONE, (result as Cartesian3 | undefined) ?? new Cartesian3());
			}, false),
		});
		if (p.disc) {
			out[p.disc] = new NodeTransformationProperty({
				scale: new CallbackProperty((_t, result) => {
					advance();
					return Cartesian3.clone(s.blurred ? ONE : ZERO, (result as Cartesian3 | undefined) ?? new Cartesian3());
				}, false),
			});
		}
	}
	const k = anim.liftBarMetresPerNPerM ?? 0;
	for (const bar of anim.liftBars ?? []) {
		out[bar.node] = new NodeTransformationProperty({
			scale: new CallbackProperty((_t, result) => {
				const h = showLiftBars() ? liftBarHeightM(bar, k, frame()) : 0;
				const out = (result as Cartesian3 | undefined) ?? new Cartesian3();
				return h < LIFT_BAR_MIN_M ? Cartesian3.clone(ZERO, out) : Cartesian3.fromElements(1, 1, h, out);
			}, false),
		});
	}
	return out;
}
