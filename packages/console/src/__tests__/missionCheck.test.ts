import { describe, it, expect } from "vitest";

import {
	LAND_ALT_TOLERANCE_M,
	LND_ANG_PARAM,
	TKO_LAND_REQ_PARAM,
	landingGeometry,
	lookupFrom,
	metresBetween,
	minLegalRunM,
	missionBlockers,
	missionLooksRunnable,
	needsEither,
	needsLanding,
	needsTakeoff,
	runNeededM,
	type ParamLookup,
} from "@/lib/missionCheck";
import type { MissionItem } from "@/types/app";

// Both failures here were measured against a live PX4, not imagined:
//
//   1. MIS_TKO_LAND_REQ = 2 with a plan of bare waypoints. Upload acked
//      "accepted"; AUTO.MISSION was refused; nothing on screen said why.
//   2. Adding a landing item did not fix it. FW_LND_ANG = 5 deg, and the plan
//      asked for 24.6 deg — 160 m of descent in 349 m.
//
// (2) is the reason these tests exist at all. "Add a landing" was correct advice
// that still left the mission unflyable, so a check that only counts item kinds
// would have cheerfully called the plan ready.

const wp = (seq: number, lat: number, lon: number, alt: number): MissionItem =>
	({ seq, kind: "waypoint", lat, lon, alt });
const takeoffItem: MissionItem = { seq: 0, kind: "takeoff", lat: 37.4, lon: -122.1, alt: 120 };

const BARE = [wp(0, 37.4, -122.1, 200), wp(1, 37.41, -122.1, 200), wp(2, 37.42, -122.1, 200)];

/** Only the named params are known; everything else is undefined. */
const params = (vals: Record<string, number>): ParamLookup => (n) => vals[n];
const NOTHING_KNOWN: ParamLookup = () => undefined;

// The plan exactly as it sat on the vehicle, pulled live.
const MEASURED: MissionItem[] = [
	wp(0, 37.397607, -122.135815, 207.2),
	wp(1, 37.389546, -122.117429, 209.318),
	wp(2, 37.386964, -122.119235, 195.0),
	wp(3, 37.389747, -122.135463, 209.551),
	{ seq: 4, kind: "land", lat: 37.392055, lon: -122.138130, alt: 50.0 },
];

describe("metresBetween", () => {
	it("measures a known short hop", () => {
		// ~1 km of latitude.
		expect(metresBetween(37.4, -122.1, 37.409, -122.1)).toBeCloseTo(1001, -1);
	});

	it("is symmetric and zero for the same point", () => {
		expect(metresBetween(37.4, -122.1, 37.4, -122.1)).toBe(0);
		expect(metresBetween(37.4, -122.1, 37.5, -122.2))
			.toBeCloseTo(metresBetween(37.5, -122.2, 37.4, -122.1), 6);
	});

	it("shrinks a degree of longitude with latitude, unlike a flat grid", () => {
		const equator = metresBetween(0, 0, 0, 1);
		const high = metresBetween(60, 0, 60, 1);
		expect(high).toBeLessThan(equator * 0.55);
	});
});

describe("the requirement table", () => {
	it("reads 1 as takeoff, 2 as landing, 3 as both, 4 as either", () => {
		expect(needsTakeoff(1)).toBe(true);
		expect(needsLanding(2)).toBe(true);
		expect(needsTakeoff(3) && needsLanding(3)).toBe(true);
		expect(needsEither(4)).toBe(true);
		expect(needsTakeoff(0) || needsLanding(0) || needsEither(0)).toBe(false);
	});
});

describe("required items", () => {
	it("reports the exact failure measured on this vehicle", () => {
		const found = missionBlockers(BARE, params({ [TKO_LAND_REQ_PARAM]: 2 }));
		expect(found).toHaveLength(1);
		expect(found[0].code).toBe("needs-landing");
		// Two words for the chip, the parameter named in the detail so it can be
		// verified rather than believed.
		expect(found[0].short).toBe("needs a landing");
		expect(found[0].detail).toContain(TKO_LAND_REQ_PARAM);
		expect(found[0].detail).toContain("= 2");
		// It is about the plan, not about one item, so it carries no row.
		expect(found[0].seq).toBeNull();
	});

	it("clears once a landing is added at ground level", () => {
		const land: MissionItem = { seq: 3, kind: "land", lat: 37.43, lon: -122.1, alt: 0 };
		expect(missionBlockers([...BARE, land], params({ [TKO_LAND_REQ_PARAM]: 2 }))).toEqual([]);
	});

	it("reports takeoff and landing separately when both are required", () => {
		const codes = missionBlockers(BARE, params({ [TKO_LAND_REQ_PARAM]: 3 })).map((b) => b.code);
		expect(codes).toEqual(["needs-takeoff", "needs-landing"]);
		// Half-satisfied reports only the missing half.
		const half = missionBlockers([takeoffItem, ...BARE], params({ [TKO_LAND_REQ_PARAM]: 3 }));
		expect(half.map((b) => b.code)).toEqual(["needs-landing"]);
	});

	it("accepts either one when the requirement is either-one", () => {
		expect(missionBlockers(BARE, params({ [TKO_LAND_REQ_PARAM]: 4 }))[0].code).toBe("needs-either");
		expect(missionBlockers([takeoffItem, ...BARE], params({ [TKO_LAND_REQ_PARAM]: 4 }))).toEqual([]);
	});

	it("says nothing when PX4 imposes no requirement", () => {
		expect(missionBlockers(BARE, params({ [TKO_LAND_REQ_PARAM]: 0 }))).toEqual([]);
	});

	it("stays silent rather than guessing when the params are unknown", () => {
		// A warning that is confidently wrong sends the operator to fix the wrong
		// thing, so an unread parameter list produces no claims at all.
		expect(missionBlockers(BARE, NOTHING_KNOWN)).toEqual([]);
	});

	it("stays silent on a requirement value it does not recognise", () => {
		expect(missionBlockers(BARE, params({ [TKO_LAND_REQ_PARAM]: 7 }))).toEqual([]);
	});

	it("says nothing at all about an empty plan", () => {
		expect(missionBlockers([], params({ [TKO_LAND_REQ_PARAM]: 3 }))).toEqual([]);
	});
});

describe("landing geometry", () => {
	it("measures the approach from the last positioned item before the landing", () => {
		const g = landingGeometry(MEASURED)!;
		expect(g.landSeq).toBe(4);
		expect(g.fromSeq).toBe(3);
		expect(g.runM).toBeCloseTo(349, -1);
		expect(g.dropM).toBeCloseTo(159.55, 1);
		expect(g.slopeDeg).toBeCloseTo(24.6, 0);
		expect(g.landAltM).toBe(50);
	});

	it("skips over a positionless item to find the real approach", () => {
		const withRtl: MissionItem[] = [
			wp(0, 37.4, -122.1, 200),
			{ seq: 1, kind: "rtl" },
			{ seq: 2, kind: "land", lat: 37.41, lon: -122.1, alt: 0 },
		];
		expect(landingGeometry(withRtl)!.fromSeq).toBe(0);
	});

	it("is null when there is no landing, or nothing to descend from", () => {
		expect(landingGeometry(BARE)).toBeNull();
		expect(landingGeometry([{ seq: 0, kind: "land", lat: 37.4, lon: -122.1, alt: 0 }])).toBeNull();
	});

	it("reports no slope for a level or climbing approach", () => {
		const level: MissionItem[] = [
			wp(0, 37.4, -122.1, 50),
			{ seq: 1, kind: "land", lat: 37.41, lon: -122.1, alt: 50 },
		];
		expect(landingGeometry(level)!.slopeDeg).toBe(0);
	});
});

describe("runNeededM", () => {
	it("inverts the slope: 160 m at 5 degrees needs ~1830 m", () => {
		expect(runNeededM(159.55, 5)).toBeCloseTo(1824, -1);
	});

	it("is zero when there is nothing to lose", () => {
		expect(runNeededM(0, 5)).toBe(0);
		expect(runNeededM(-20, 5)).toBe(0);
		expect(runNeededM(100, 0)).toBe(0);
	});
});

describe("the approach check — why 'add a landing' was not enough", () => {
	const live = params({ [TKO_LAND_REQ_PARAM]: 2, [LND_ANG_PARAM]: 5 });

	it("catches the too-steep approach that actually blocked the mission", () => {
		const found = missionBlockers(MEASURED, live);
		const codes = found.map((b) => b.code);
		// The landing EXISTS, so the presence check passes and a lesser check
		// would have called this plan ready.
		expect(codes).not.toContain("needs-landing");
		expect(codes).toContain("approach-too-steep");

		const steep = found.find((b) => b.code === "approach-too-steep")!;
		expect(steep.seq).toBe(4);                       // points at the landing row
		expect(steep.short).toContain("25");             // 24.6 rounds to 25
		expect(steep.short).toContain("5");
		expect(steep.detail).toContain(LND_ANG_PARAM);
		expect(steep.detail).toMatch(/1824|1823|1825/);  // the distance it needs
	});

	it("also notices the landing is not at ground level", () => {
		const found = missionBlockers(MEASURED, live);
		const alt = found.find((b) => b.code === "land-altitude")!;
		expect(alt.seq).toBe(4);
		expect(alt.short).toContain("50");
	});

	it("clears once the landing is at ground level and far enough out", () => {
		// 160 m of descent at 5 deg needs ~1824 m; 0.018 deg of latitude is ~2 km.
		const plan: MissionItem[] = [
			wp(0, 37.40, -122.10, 160),
			{ seq: 1, kind: "land", lat: 37.418, lon: -122.10, alt: 0 },
		];
		expect(metresBetween(37.40, -122.10, 37.418, -122.10)).toBeGreaterThan(1824);
		expect(missionBlockers(plan, live)).toEqual([]);
	});

	it("stays silent about the slope when FW_LND_ANG is unknown", () => {
		const codes = missionBlockers(MEASURED, params({ [TKO_LAND_REQ_PARAM]: 2 })).map((b) => b.code);
		expect(codes).not.toContain("approach-too-steep");
		// The altitude finding needs no parameter, so it still appears.
		expect(codes).toContain("land-altitude");
	});

	it("tolerates a landing a couple of metres off zero", () => {
		const plan: MissionItem[] = [
			wp(0, 37.40, -122.10, 10),
			{ seq: 1, kind: "land", lat: 37.418, lon: -122.10, alt: LAND_ALT_TOLERANCE_M },
		];
		expect(missionBlockers(plan, live).map((b) => b.code)).not.toContain("land-altitude");
	});
});

describe("minLegalRunM — the ring the globe draws", () => {
	it("is the distance the landing must be beyond", () => {
		const live = params({ [LND_ANG_PARAM]: 5 });
		expect(minLegalRunM(MEASURED, live)).toBeCloseTo(1824, -1);
	});

	it("is undefined when it cannot be computed, so nothing is drawn", () => {
		expect(minLegalRunM(MEASURED, NOTHING_KNOWN)).toBeUndefined();
		expect(minLegalRunM(BARE, params({ [LND_ANG_PARAM]: 5 }))).toBeUndefined();
	});
});

describe("missionLooksRunnable", () => {
	const live = params({ [TKO_LAND_REQ_PARAM]: 2, [LND_ANG_PARAM]: 5 });

	it("is false for the plan that would not run", () => {
		expect(missionLooksRunnable(MEASURED, live)).toBe(false);
	});

	it("is false for an empty plan: there is nothing to run", () => {
		expect(missionLooksRunnable([], live)).toBe(false);
	});

	it("is true when nothing is known against it", () => {
		expect(missionLooksRunnable(BARE, NOTHING_KNOWN)).toBe(true);
	});
});

describe("lookupFrom", () => {
	it("reads the console's param store shape", () => {
		const look = lookupFrom({ [LND_ANG_PARAM]: { value: 5 } });
		expect(look(LND_ANG_PARAM)).toBe(5);
		expect(look("MISSING")).toBeUndefined();
	});
});
