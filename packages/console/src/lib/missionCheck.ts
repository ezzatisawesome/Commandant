// Will PX4 actually RUN this plan?
//
// Uploading a mission and running one are different things, and PX4 validates
// the plan at the second step, not the first. It accepts an upload, acks it
// "accepted", and then refuses to enter AUTO.MISSION if the plan does not meet
// its configured requirements — announcing the reason only through STATUSTEXT,
// which scrolls past in the status log if the operator is not watching it at
// that exact moment.
//
// Measured on this vehicle: MIS_TKO_LAND_REQ = 2, a plan of bare waypoints with
// no landing item, and a mode change that reported success while the aircraft
// stayed in AUTO.LOITER. The console showed a green tick for the upload and
// nothing at all for the refusal, so "it doesn't work" was the only symptom
// available. This module turns that into a sentence BEFORE the upload.
//
// The repo already learned the general lesson from a live PX4 (see the
// validation commit): an ack is RECEIPT, not proof of effect. This is the
// preventive half of that — check what we can predict, rather than only
// reporting what came back.

import type { MissionItem } from "@/types/app";

/** PX4 parameter deciding whether a plan must carry takeoff/landing items. */
export const TKO_LAND_REQ_PARAM = "MIS_TKO_LAND_REQ";

/**
 * PX4's MIS_TKO_LAND_REQ values.
 *
 * 0 none · 1 takeoff required · 2 landing required · 3 both required ·
 * 4 at least one of the two required.
 *
 * Deliberately advisory: the message names the parameter and its value so the
 * operator can check PX4's own documentation rather than trust this table, and
 * a value this code does not recognise produces no warning instead of a wrong
 * one. A warning that is confidently wrong is worse than none — it sends the
 * operator to fix the wrong thing.
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

const hasKind = (items: MissionItem[], kind: string) => items.some((it) => it.kind === kind);

/**
 * Why PX4 will refuse to fly this plan, or null if nothing is predictable.
 *
 * `req` is the live value of MIS_TKO_LAND_REQ, or undefined when the parameter
 * list has not been downloaded — in which case this stays quiet rather than
 * guessing at PX4's configuration.
 */
export function missionRejectionReason(items: MissionItem[], req: number | undefined): string | null {
	if (items.length === 0) return null;          // nothing to say about an empty plan
	if (req === undefined || !Number.isFinite(req)) return null;

	const takeoff = hasKind(items, "takeoff");
	const land = hasKind(items, "land");
	const tag = `${TKO_LAND_REQ_PARAM} = ${req}`;

	if (needsEither(req) && !takeoff && !land) {
		return `PX4 requires this plan to contain a takeoff or a landing item (${tag}); it has neither, so AUTO.MISSION will be refused.`;
	}

	const missing: string[] = [];
	if (needsTakeoff(req) && !takeoff) missing.push("a takeoff item");
	if (needsLanding(req) && !land) missing.push("a landing item");
	if (missing.length === 0) return null;

	return `PX4 requires ${missing.join(" and ")} (${tag}); this plan has ${missing.length > 1 ? "neither" : "none"}, so AUTO.MISSION will be refused even though the upload succeeds.`;
}

/**
 * Does this plan look runnable? A convenience for the command surface, which
 * wants to warn next to the MISSION button without repeating the reasoning.
 */
export function missionLooksRunnable(items: MissionItem[], req: number | undefined): boolean {
	return items.length > 0 && missionRejectionReason(items, req) === null;
}
