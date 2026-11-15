import { describe, it, expect } from "vitest";

import { distanceM, preflightChecks, preflightVerdict, type PreflightInput } from "@/lib/preflight";
import type { TelemetryFrame } from "@/types/app";

// Pre-arm is advisory, but an advisory that says GO wrongly is worse than none:
// the operator stops looking. So the rule pinned hardest is that "unknown" and
// "stale" never read as go.

const READY: TelemetryFrame = {
	t: 0, connected: true, linkState: "alive",
	lat: 37.4, lon: -122.1, ekfOk: true, gpsFix: 3, gpsSats: 14,
	homeLat: 37.4, homeLon: -122.1, homeAlt: 30, sysHealthy: true,
	failsafe: false, batteryRemaining: 92, batteryWarning: null, landedState: "on_ground",
	ages: { ekf: 100, gps: 100, health: 100, battery: 100, landed: 100 },
};

const input = (over: Partial<PreflightInput> = {}, frame: Partial<TelemetryFrame> = {}): PreflightInput => ({
	frame: { ...READY, ...frame }, linkState: "alive",
	paramCount: 1100, paramsReading: false, paramsStale: false,
	missionItems: 5, missionOnVehicle: true, ...over,
});

const state = (i: PreflightInput, key: string) =>
	preflightChecks(i).find((c) => c.key === key)?.state;

describe("pre-arm", () => {
	it("is GO only when everything is known good", () => {
		const v = preflightVerdict(preflightChecks(input()));
		expect(v).toMatchObject({ state: "go", nogo: 0, unknown: 0, summary: "GO" });
	});

	it("a dead link is no-go and checks nothing else, since nothing else is current", () => {
		const checks = preflightChecks(input({ linkState: "stale" }));
		expect(checks.map((c) => c.key)).toEqual(["link"]);
		expect(preflightVerdict(checks).state).toBe("nogo");
	});

	it("bad values are no-go", () => {
		expect(state(input({}, { ekfOk: false }), "ekf")).toBe("nogo");
		expect(state(input({}, { gpsFix: 2 }), "gps")).toBe("nogo");
		expect(state(input({}, { failsafe: true }), "failsafe")).toBe("nogo");
		expect(state(input({}, { batteryWarning: "LOW" }), "battery")).toBe("nogo");
		expect(state(input({}, { sysHealthy: false }), "sensors")).toBe("nogo");
		expect(state(input({}, { landedState: "in_air" }), "landed")).toBe("nogo");
	});

	it("no home is not go: RTL would have nowhere to return to", () => {
		expect(state(input({}, { homeLat: undefined, homeLon: undefined }), "home")).toBe("unknown");
	});

	it("a stopped stream is unknown, not its last value", () => {
		// EKF said OK, then stopped reporting: the post-reboot window.
		const i = input({}, { ages: { ...READY.ages, ekf: 60_000 } });
		expect(state(i, "ekf")).toBe("unknown");
		expect(preflightVerdict(preflightChecks(i)).state).toBe("unknown");
	});

	it("home and failsafe have no staleness of their own", () => {
		// HOME_POSITION is a setting re-sent rarely; failsafe rides the heartbeat.
		const i = input({}, { ages: { ...READY.ages, home: 120_000 } });
		expect(state(i, "home")).toBe("go");
		expect(state(i, "failsafe")).toBe("go");
	});

	it("an older gs that reports no ages is taken at its word", () => {
		expect(preflightVerdict(preflightChecks(input({}, { ages: undefined }))).state).toBe("go");
	});

	it("parameters must have been read from this vehicle, completely, since the last gap", () => {
		expect(state(input({ paramCount: 0 }), "params")).toBe("unknown");
		expect(state(input({ paramsReading: true }), "params")).toBe("unknown");
		expect(state(input({ paramsStale: true }), "params")).toBe("unknown");
	});

	it("the plan on screen must be the one on the vehicle", () => {
		expect(state(input({ missionOnVehicle: false }), "mission")).toBe("nogo");
		expect(state(input({ missionItems: 0, missionOnVehicle: false }), "mission")).toBe("unknown");
	});

	it("summarises no-go before unknown", () => {
		const v = preflightVerdict(preflightChecks(input({ paramCount: 0 }, { ekfOk: false })));
		expect(v).toMatchObject({ state: "nogo", nogo: 1, unknown: 1, summary: "1 NO-GO · 1 ?" });
	});

	it("without a landed state (older gs) the check is simply absent", () => {
		expect(state(input({}, { landedState: undefined }), "landed")).toBeUndefined();
	});
});

describe("distanceM", () => {
	it("measures a known distance", () => {
		// One degree of latitude is ~111.2 km.
		expect(distanceM(0, 0, 1, 0)).toBeCloseTo(111_195, -2);
		expect(distanceM(37.4, -122.1, 37.4, -122.1)).toBe(0);
	});
});
