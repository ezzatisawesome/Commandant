import { describe, it, expect } from "vitest";

import {
	TKO_LAND_REQ_PARAM,
	missionLooksRunnable,
	missionRejectionReason,
	needsEither,
	needsLanding,
	needsTakeoff,
} from "@/lib/missionCheck";
import type { MissionItem } from "@/types/app";

// Measured against the live vehicle: MIS_TKO_LAND_REQ = 2, a plan of bare
// waypoints, an upload that acked "accepted", and a mode change that reported
// success while PX4 stayed in AUTO.LOITER. The console had no way to say why.
// These tests pin the sentence that replaces that silence.

const wp = (seq: number): MissionItem => ({ seq, kind: "waypoint", lat: 37.4, lon: -122.1, alt: 200 });
const takeoff: MissionItem = { seq: 0, kind: "takeoff", lat: 37.4, lon: -122.1, alt: 120 };
const land: MissionItem = { seq: 9, kind: "land", lat: 37.4, lon: -122.1, alt: 0 };

const BARE = [wp(0), wp(1), wp(2)];

describe("the requirement table", () => {
	it("reads 1 as takeoff, 2 as landing, 3 as both", () => {
		expect(needsTakeoff(1)).toBe(true);
		expect(needsLanding(1)).toBe(false);

		expect(needsLanding(2)).toBe(true);
		expect(needsTakeoff(2)).toBe(false);

		expect(needsTakeoff(3)).toBe(true);
		expect(needsLanding(3)).toBe(true);
	});

	it("reads 0 as no requirement and 4 as either-one", () => {
		expect(needsTakeoff(0)).toBe(false);
		expect(needsLanding(0)).toBe(false);
		expect(needsEither(0)).toBe(false);
		expect(needsEither(4)).toBe(true);
	});
});

describe("missionRejectionReason", () => {
	it("explains the exact failure seen on this vehicle", () => {
		// MIS_TKO_LAND_REQ = 2 with no landing item: upload succeeds, MISSION is
		// refused, and before this the operator got a green tick and silence.
		const reason = missionRejectionReason(BARE, 2);
		expect(reason).not.toBeNull();
		expect(reason).toContain("landing item");
		expect(reason).toContain("AUTO.MISSION will be refused");
		// Names the parameter and value, so it can be checked rather than believed.
		expect(reason).toContain(TKO_LAND_REQ_PARAM);
		expect(reason).toContain("= 2");
	});

	it("is satisfied once a landing item is added", () => {
		expect(missionRejectionReason([...BARE, land], 2)).toBeNull();
	});

	it("asks for a takeoff when that is what is required", () => {
		const reason = missionRejectionReason(BARE, 1);
		expect(reason).toContain("takeoff item");
		expect(reason).not.toContain("landing item");
		expect(missionRejectionReason([takeoff, ...BARE], 1)).toBeNull();
	});

	it("asks for both when both are required, and names both", () => {
		const reason = missionRejectionReason(BARE, 3)!;
		expect(reason).toContain("takeoff item");
		expect(reason).toContain("landing item");
		expect(reason).toContain("neither");
		// Half-satisfying it still warns, about the half that is missing.
		expect(missionRejectionReason([takeoff, ...BARE], 3)).toContain("landing item");
		expect(missionRejectionReason([...BARE, land], 3)).toContain("takeoff item");
		expect(missionRejectionReason([takeoff, ...BARE, land], 3)).toBeNull();
	});

	it("accepts either one when the requirement is either-one", () => {
		expect(missionRejectionReason(BARE, 4)).toContain("takeoff or a landing");
		expect(missionRejectionReason([takeoff, ...BARE], 4)).toBeNull();
		expect(missionRejectionReason([...BARE, land], 4)).toBeNull();
	});

	it("says nothing when PX4 imposes no requirement", () => {
		expect(missionRejectionReason(BARE, 0)).toBeNull();
	});

	it("stays quiet rather than guessing when the params are not downloaded", () => {
		// A warning that is confidently wrong sends the operator to fix the wrong
		// thing, so an unknown configuration produces no claim at all.
		expect(missionRejectionReason(BARE, undefined)).toBeNull();
		expect(missionRejectionReason(BARE, NaN)).toBeNull();
	});

	it("stays quiet on a value it does not recognise", () => {
		// A future or vendor-specific value must not be reported as a known rule.
		expect(missionRejectionReason(BARE, 7)).toBeNull();
		expect(missionRejectionReason(BARE, -1)).toBeNull();
	});

	it("says nothing about an empty plan — that is the Upload button's job", () => {
		expect(missionRejectionReason([], 2)).toBeNull();
		expect(missionRejectionReason([], 3)).toBeNull();
	});

	it("does not care where the landing item sits in the list", () => {
		// PX4's requirement here is presence, and this check does not claim more
		// than that; ordering rules are PX4's to enforce and to announce.
		expect(missionRejectionReason([land, ...BARE], 2)).toBeNull();
	});
});

describe("missionLooksRunnable", () => {
	it("is false for a plan PX4 will refuse", () => {
		expect(missionLooksRunnable(BARE, 2)).toBe(false);
	});

	it("is true once the plan satisfies the requirement", () => {
		expect(missionLooksRunnable([...BARE, land], 2)).toBe(true);
	});

	it("is false for an empty plan: there is nothing to run", () => {
		expect(missionLooksRunnable([], 0)).toBe(false);
	});

	it("is true when nothing is known against it", () => {
		expect(missionLooksRunnable(BARE, undefined)).toBe(true);
	});
});
