import { describe, it, expect } from "vitest";

import { fromPlan, plannedHome, planFilename, toPlan, type Plan } from "@/lib/planFile";
import type { MissionItem } from "@/types/app";

// A QGC-written plan, verbatim: AircraftSim's missions/loiter_200m.plan — runway
// takeoff toward the loiter, then loiter-unlimited 200 m at 400 ft above home.
const SIM_PLAN = JSON.stringify({
	fileType: "Plan",
	geoFence: { circles: [], polygons: [], version: 2 },
	groundStation: "QGroundControl",
	mission: {
		cruiseSpeed: 9.7, firmwareType: 12, globalPlanAltitudeMode: 1, hoverSpeed: 5,
		items: [
			{ AMSLAltAboveTerrain: null, Altitude: 121.92, AltitudeMode: 1, autoContinue: true,
			  command: 22, doJumpId: 1, frame: 3,
			  params: [0, 0, 0, null, 37.399417, -122.15025, 121.92], type: "SimpleItem" },
			{ AMSLAltAboveTerrain: null, Altitude: 121.92, AltitudeMode: 1, autoContinue: true,
			  command: 17, doJumpId: 2, frame: 3,
			  params: [0, 0, 200, null, 37.399417, -122.15025, 121.92], type: "SimpleItem" },
		],
		plannedHomePosition: [37.398928, -122.175, 1200],
		vehicleType: 1, version: 2,
	},
	rallyPoints: { points: [], version: 2 },
	version: 1,
});

const ok = (text: string) => {
	const r = fromPlan(text);
	if ("error" in r) throw new Error(r.error);
	return r;
};

describe("opening a .plan", () => {
	it("reads the plan AircraftSim flies: takeoff, then a 200 m loiter at 400 ft", () => {
		const { plan, home } = ok(SIM_PLAN);
		expect(home).toEqual([37.398928, -122.175, 1200]);
		expect(plan.mission.map((m) => m.kind)).toEqual(["takeoff", "loiter_unlim"]);
		const loiter = plan.mission[1];
		expect(loiter).toMatchObject({ seq: 1, lat: 37.399417, lon: -122.15025, alt: 121.92 });
		expect(loiter.params).toEqual({ radius: 200 });
		expect(plan.fence).toEqual([]);
		expect(plan.rally).toEqual([]);
	});

	it("converts an AMSL leg to above-home using the plan's home elevation", () => {
		const p = JSON.parse(SIM_PLAN);
		p.mission.items[1].frame = 0;                       // MAV_FRAME_GLOBAL (AMSL)
		p.mission.items[1].params[6] = 1321.92;
		expect(ok(JSON.stringify(p)).plan.mission[1].alt).toBeCloseTo(121.92, 6);
	});

	it("refuses what the console cannot represent, with a reason, never partially", () => {
		const cases: [string, (p: any) => void, RegExp][] = [
			["a survey", (p) => p.mission.items.push({ type: "ComplexItem", complexItemType: "survey" }), /survey/],
			["an ArduPilot plan", (p) => { p.mission.firmwareType = 3; }, /not PX4/],
			["a terrain-relative leg", (p) => { p.mission.items[1].frame = 10; }, /frame 10/],
			["an unknown command", (p) => { p.mission.items[1].command = 201; }, /MAV_CMD 201/],
			["a non-plan", (p) => { p.fileType = "Mission"; }, /not a QGroundControl plan/],
		];
		for (const [, mutate, why] of cases) {
			const p = JSON.parse(SIM_PLAN);
			mutate(p);
			const r = fromPlan(JSON.stringify(p));
			expect("error" in r && r.error).toMatch(why);
		}
		expect(fromPlan("{not json")).toHaveProperty("error");
	});
});

describe("saving a .plan", () => {
	const plan: Plan = {
		mission: [
			{ seq: 0, kind: "takeoff", lat: 37.40, lon: -122.17, alt: 40 },
			{ seq: 1, kind: "waypoint", lat: 37.41, lon: -122.16, alt: 80, params: { acceptRadius: 15 } },
			{ seq: 2, kind: "loiter_time", lat: 37.42, lon: -122.15, alt: 90, params: { seconds: 60, radius: 120 } },
			{ seq: 3, kind: "loiter_turns", lat: 37.42, lon: -122.14, alt: 90, params: { turns: 3, radius: 100 } },
			{ seq: 4, kind: "loiter_unlim", lat: 37.43, lon: -122.13, alt: 100, params: { radius: 200 } },
			{ seq: 5, kind: "rtl" },
		],
		fence: [
			{ seq: 0, kind: "fence_inclusion", lat: 37.39, lon: -122.18 },
			{ seq: 1, kind: "fence_inclusion", lat: 37.39, lon: -122.12 },
			{ seq: 2, kind: "fence_inclusion", lat: 37.44, lon: -122.15 },
			{ seq: 3, kind: "fence_circle_exclusion", lat: 37.41, lon: -122.15, params: { radius: 50 } },
		],
		rally: [{ seq: 0, kind: "rally", lat: 37.40, lon: -122.16, alt: 30 }],
	};

	it("writes MAVLink commands, frames and params as QGC does", () => {
		const q = toPlan(plan, [37.398928, -122.175, 1200]);
		expect(q.fileType).toBe("Plan");
		expect(q.mission.firmwareType).toBe(12);
		expect(q.mission.items.map((i) => i.command)).toEqual([22, 16, 19, 18, 17, 20]);
		expect(q.mission.items[1].params).toEqual([0, 15, 0, null, 37.41, -122.16, 80]);
		expect(q.mission.items[4].params[2]).toBe(200);              // loiter radius = param3
		expect(q.mission.items[0].frame).toBe(3);                    // above home
		expect(q.mission.items[5].frame).toBe(2);                    // RTL: MAV_FRAME_MISSION
		expect(q.geoFence.polygons).toHaveLength(1);
		expect(q.geoFence.polygons[0].polygon).toHaveLength(3);
		expect(q.geoFence.circles[0]).toMatchObject({ inclusion: false, circle: { radius: 50 } });
		expect(q.rallyPoints.points).toEqual([[37.40, -122.16, 30]]);
	});

	it("round-trips: what is saved opens back as the same plan", () => {
		const back = ok(JSON.stringify(toPlan(plan, [37.398928, -122.175, 1200]))).plan;
		expect(back.mission).toEqual(plan.mission);
		expect(back.fence).toEqual(plan.fence);
		expect(back.rally).toEqual(plan.rally);
	});

	it("takes home from the aircraft only while it is parked at home", () => {
		const items: MissionItem[] = [{ seq: 0, kind: "rtl" }, { seq: 1, kind: "waypoint", lat: 37.5, lon: -122.2, alt: 50 }];
		expect(plannedHome({ lat: 37.4, lon: -122.17, homeAltM: 1200, relativeAlt: 0.3 }, items))
			.toEqual([37.4, -122.17, 1200]);
		// airborne: the aircraft is not at home — fall back to the plan, keep home's elevation
		expect(plannedHome({ lat: 37.45, lon: -122.1, homeAltM: 1200, relativeAlt: 120 }, items))
			.toEqual([37.5, -122.2, 1200]);
		expect(plannedHome(null, items)).toEqual([37.5, -122.2, 0]);
		expect(plannedHome({ lat: 0, lon: 0, homeAltM: null, relativeAlt: 0 }, items)).toEqual([37.5, -122.2, 0]);
	});

	it("names the file for a human", () => {
		expect(planFilename(new Date(2026, 9, 22, 14, 5), "loiter 200m"))
			.toBe("loiter_200m-20261022-1405.plan");
	});
});
