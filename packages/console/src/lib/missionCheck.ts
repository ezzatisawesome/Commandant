// Will PX4 actually RUN this plan?
//
// Uploading a mission and running one are different things, and PX4 validates
// the plan at the MODE CHANGE, not the upload. It accepts an upload, acks it
// "accepted", and then refuses AUTO.MISSION if the plan fails its feasibility
// checks — announcing the reason only through STATUSTEXT, at that instant. On
// this vehicle no STATUSTEXT arrived at all over two minutes of observation, so
// there was nothing to catch even if the operator had been watching for it.
//
// Both failures below were measured against a live PX4, not reasoned about:
//
//   1. MIS_TKO_LAND_REQ = 2 makes a landing item mandatory. A plan of bare
//      waypoints uploaded fine and would not run.
//   2. Adding a landing item was not enough. FW_LND_ANG = 5 degrees, but the
//      plan put the landing 349 m after a waypoint 160 m above it — a 24.6
//      degree approach, which PX4 rejects as infeasible.
//
// (2) is why this module computes geometry rather than only counting item
// kinds: "add a landing" was correct advice that still did not work, and a
// presence check would have pronounced the plan fine.
//
// Each finding is returned as DATA, not a sentence to paste on screen: a code,
// the item it points at, two words for a chip and a full explanation for a
// tooltip. That lets the UI point AT the offending row and draw the constraint
// on the globe, instead of stacking paragraphs the operator has to read and
// then translate back into which thing to drag.

import type { MissionItem } from "@/types/app";

/** PX4 parameter deciding whether a plan must carry takeoff/landing items. */
export const TKO_LAND_REQ_PARAM = "MIS_TKO_LAND_REQ";

/** PX4 parameter for the fixed-wing landing glide slope, in degrees. */
export const LND_ANG_PARAM = "FW_LND_ANG";

/** A landing point this far above home is almost certainly a mistake (m). */
export const LAND_ALT_TOLERANCE_M = 5;

/** Reads a live PX4 parameter value, or undefined if it is not known yet. */
export type ParamLookup = (name: string) => number | undefined;

export type BlockerCode =
	| "needs-takeoff"
	| "needs-landing"
	| "needs-either"
	| "land-altitude"
	| "approach-too-steep";

export interface Blocker {
	code: BlockerCode;
	/** The mission item this is about, or null when it is about the plan. */
	seq: number | null;
	/** Two or three words, for a chip or a row flag. */
	short: string;
	/** The whole story, for a tooltip. Names the parameter behind it. */
	detail: string;
}

/**
 * PX4's MIS_TKO_LAND_REQ values.
 *
 * 0 none · 1 takeoff required · 2 landing required · 3 both required ·
 * 4 at least one of the two required.
 *
 * Deliberately advisory: every detail names the parameter and its value so the
 * operator can verify against PX4's own documentation rather than trust this
 * table, and a value this code does not recognise produces no finding instead
 * of a wrong one. A warning that is confidently wrong sends the operator to fix
 * the wrong thing, which is worse than no warning.
 */
export function needsTakeoff(req: number): boolean {
	return req === 1 || req === 3;
}

export function needsLanding(req: number): boolean {
	return req === 2 || req === 3;
}

export function needsEither(req: number): boolean {
	return req === 4;
}

const positioned = (it: MissionItem) =>
	typeof it.lat === "number" && typeof it.lon === "number";

const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. Haversine: exact enough at mission scale
 *  and, unlike a flat approximation, it does not drift with latitude. */
export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const R = 6_371_000;
	const dLat = toRad(bLat - aLat);
	const dLon = toRad(bLon - aLon);
	const h = Math.sin(dLat / 2) ** 2
		+ Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface LandingGeometry {
	/** seq of the landing item, and of the waypoint the approach starts from. */
	landSeq: number;
	fromSeq: number;
	/** Horizontal run from the approach waypoint to the landing point, metres. */
	runM: number;
	/** Height the aircraft must lose over that run, metres. */
	dropM: number;
	/** Glide slope the plan therefore demands, degrees. */
	slopeDeg: number;
	/** Altitude of the landing item itself, metres (relative to home). */
	landAltM: number;
}

/**
 * The approach geometry of the plan's landing, or null if there is none to
 * measure (no positioned landing item, or nothing positioned before it).
 */
export function landingGeometry(items: MissionItem[]): LandingGeometry | null {
	const landIdx = items.findIndex((it) => it.kind === "land" && positioned(it));
	if (landIdx < 0) return null;
	// The approach is flown from the last positioned item before the landing.
	let prev: MissionItem | undefined;
	for (let i = landIdx - 1; i >= 0; i--) {
		if (positioned(items[i])) { prev = items[i]; break; }
	}
	if (!prev) return null;

	const land = items[landIdx];
	const landAltM = Number.isFinite(land.alt) ? (land.alt as number) : 0;
	const prevAltM = Number.isFinite(prev.alt) ? (prev.alt as number) : 0;
	const runM = metresBetween(prev.lat!, prev.lon!, land.lat!, land.lon!);
	const dropM = prevAltM - landAltM;
	// A level or climbing "approach" has no slope problem to report.
	const slopeDeg = dropM <= 0 || runM <= 0 ? 0 : (Math.atan2(dropM, runM) * 180) / Math.PI;
	return { landSeq: land.seq, fromSeq: prev.seq, runM, dropM, slopeDeg, landAltM };
}

/** Horizontal run needed to lose `dropM` at `slopeDeg`, metres. */
export function runNeededM(dropM: number, slopeDeg: number): number {
	if (slopeDeg <= 0 || dropM <= 0) return 0;
	return dropM / Math.tan(toRad(slopeDeg));
}

/** The configured landing slope, if PX4 has told us. */
export function landingSlopeLimit(param: ParamLookup): number | undefined {
	const v = param(LND_ANG_PARAM);
	return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * How far out the landing must be from its approach waypoint to be flyable, in
 * metres — the radius the globe draws so the constraint can be seen and the
 * landing dragged outside it. Undefined when it cannot be computed.
 */
export function minLegalRunM(items: MissionItem[], param: ParamLookup): number | undefined {
	const geom = landingGeometry(items);
	const limit = landingSlopeLimit(param);
	if (!geom || limit === undefined || geom.dropM <= 0) return undefined;
	return runNeededM(geom.dropM, limit);
}

/**
 * Everything predictable that will stop PX4 flying this plan.
 *
 * Silent about anything it cannot check: an undownloaded parameter list yields
 * no findings at all, rather than findings based on assumed defaults.
 */
export function missionBlockers(items: MissionItem[], param: ParamLookup): Blocker[] {
	if (items.length === 0) return [];
	const out: Blocker[] = [];

	// --- required items ---------------------------------------------------
	const req = param(TKO_LAND_REQ_PARAM);
	if (req !== undefined && Number.isFinite(req)) {
		const takeoff = items.some((it) => it.kind === "takeoff");
		const land = items.some((it) => it.kind === "land");
		const tag = `${TKO_LAND_REQ_PARAM} = ${req}`;
		if (needsEither(req) && !takeoff && !land) {
			out.push({
				code: "needs-either", seq: null, short: "needs takeoff or landing",
				detail: `PX4 requires this plan to contain a takeoff or a landing item (${tag}); it has neither, so AUTO.MISSION will be refused.`,
			});
		} else {
			if (needsTakeoff(req) && !takeoff) {
				out.push({
					code: "needs-takeoff", seq: null, short: "needs a takeoff",
					detail: `PX4 requires a takeoff item (${tag}); this plan has none, so AUTO.MISSION will be refused even though the upload succeeds.`,
				});
			}
			if (needsLanding(req) && !land) {
				out.push({
					code: "needs-landing", seq: null, short: "needs a landing",
					detail: `PX4 requires a landing item (${tag}); this plan has none, so AUTO.MISSION will be refused even though the upload succeeds.`,
				});
			}
		}
	}

	// --- landing approach -------------------------------------------------
	// Adding a landing item is not sufficient: it also has to be reachable on
	// the configured glide slope, which is the trap that made "add a landing"
	// look like it had not helped.
	const geom = landingGeometry(items);
	if (geom) {
		if (geom.landAltM > LAND_ALT_TOLERANCE_M) {
			out.push({
				code: "land-altitude", seq: geom.landSeq,
				short: `landing is ${Math.round(geom.landAltM)} m up`,
				detail: `The landing item sits ${Math.round(geom.landAltM)} m above home, but a landing is where the aircraft touches down — its altitude should normally be 0. Drag its ▲ handle down, or type 0.`,
			});
		}
		const limit = landingSlopeLimit(param);
		if (limit !== undefined && geom.slopeDeg > limit + 0.1) {
			const need = runNeededM(geom.dropM, limit);
			out.push({
				code: "approach-too-steep", seq: geom.landSeq,
				short: `approach ${geom.slopeDeg.toFixed(0)}° > ${limit}°`,
				detail: `The approach is too steep: losing ${Math.round(geom.dropM)} m over ${Math.round(geom.runM)} m needs ${geom.slopeDeg.toFixed(1)}°, but PX4 will only fly ${limit}° (${LND_ANG_PARAM}). Move the landing to about ${Math.round(need)} m from item ${geom.fromSeq}, or lower that waypoint.`,
			});
		}
	}

	return out;
}

/** The blockers attached to one item, for a row flag. */
export function blockersForSeq(blockers: Blocker[], seq: number): Blocker[] {
	return blockers.filter((b) => b.seq === seq);
}

/** Does this plan look runnable? */
export function missionLooksRunnable(items: MissionItem[], param: ParamLookup): boolean {
	return items.length > 0 && missionBlockers(items, param).length === 0;
}

/** A ParamLookup over the console's params store shape. */
export function lookupFrom(params: Record<string, { value: number }>): ParamLookup {
	return (name) => params[name]?.value;
}
