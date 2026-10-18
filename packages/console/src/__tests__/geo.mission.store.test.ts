import { describe, it, expect, beforeEach } from "vitest";

import {
	$fenceItems, addFencePoint, fenceItemsForPush, clearFence, removeFenceItem,
	setFenceItems, fenceGeometryProblem,
} from "@/stores/geo.store";
import {
	$missionItems, addWaypoint, removeItem, reorderItem, clearMission, updateItem,
	$planRead, markPlanRead, clearPlanRead,
} from "@/stores/mission.store";

describe("fence push shaping", () => {
	beforeEach(() => clearFence());
	it("stamps vertexCount per contiguous polygon run; circles keep radius", () => {
		addFencePoint("fence_inclusion", 1, 1);
		addFencePoint("fence_inclusion", 1, 2);
		addFencePoint("fence_inclusion", 2, 2);
		addFencePoint("fence_circle_exclusion", 5, 5);
		addFencePoint("fence_exclusion", 3, 3);
		addFencePoint("fence_exclusion", 3, 4);
		const out = fenceItemsForPush();
		expect(out.slice(0, 3).map((i) => i.params?.vertexCount)).toEqual([3, 3, 3]);
		expect(out[3].params?.radius).toBe(100);
		expect(out[3].params?.vertexCount).toBeUndefined();
		expect(out.slice(4).map((i) => i.params?.vertexCount)).toEqual([2, 2]);
		expect(out.map((i) => i.seq)).toEqual([0, 1, 2, 3, 4, 5]);
	});
	it("resequences after a delete", () => {
		addFencePoint("fence_inclusion", 1, 1);
		addFencePoint("fence_inclusion", 1, 2);
		removeFenceItem(0);
		expect($fenceItems.get().map((i) => i.seq)).toEqual([0]);
	});
});

describe("mission store", () => {
	beforeEach(() => clearMission());
	it("keeps seq == list order through add/remove/reorder", () => {
		addWaypoint(1, 1, 50);
		addWaypoint(2, 2, 50);
		addWaypoint(3, 3, 50);
		reorderItem(2, -1);
		expect($missionItems.get().map((i) => [i.seq, i.lat])).toEqual([[0, 1], [1, 3], [2, 2]]);
		reorderItem(0, -1); // no-op at the top
		expect($missionItems.get()[0].lat).toBe(1);
		removeItem(1);
		expect($missionItems.get().map((i) => i.seq)).toEqual([0, 1]);
	});
	it("updateItem patches in place", () => {
		addWaypoint(1, 1, 50);
		updateItem(0, { alt: 80 });
		expect($missionItems.get()[0].alt).toBe(80);
	});
});

describe("a fence that is not a fence is refused at authoring time (gs fault H13)", () => {
	it("a polygon with fewer than 3 vertices is named, with its seq", () => {
		setFenceItems([]);
		addFencePoint("fence_inclusion", 37.4, -122.2);
		expect(fenceGeometryProblem()).toMatch(/1 vertex .*needs 3/);
		addFencePoint("fence_inclusion", 37.41, -122.2);
		expect(fenceGeometryProblem()).toMatch(/2 vertexes .*needs 3/);
		addFencePoint("fence_inclusion", 37.41, -122.1);
		expect(fenceGeometryProblem()).toBeNull();
	});

	it("says which polygon, when there are several", () => {
		setFenceItems([]);
		for (const [la, lo] of [[1, 1], [1, 2], [2, 2]]) addFencePoint("fence_inclusion", la, lo);
		addFencePoint("fence_exclusion", 5, 5);
		addFencePoint("fence_exclusion", 5, 6);
		const problem = fenceGeometryProblem();
		expect(problem).toMatch(/exclusion/);
		expect(problem).toMatch(/#3/);        // the run starts at seq 3
	});

	it("a circle with no radius is refused", () => {
		setFenceItems([{ seq: 0, kind: "fence_circle_inclusion", lat: 1, lon: 1, params: { radius: 0 } }]);
		expect(fenceGeometryProblem()).toMatch(/no radius/);
		setFenceItems([{ seq: 0, kind: "fence_circle_inclusion", lat: 1, lon: 1, params: { radius: 150 } }]);
		expect(fenceGeometryProblem()).toBeNull();
	});

	it("an empty fence is not a geometry problem (there is nothing to upload)", () => {
		setFenceItems([]);
		expect(fenceGeometryProblem()).toBeNull();
	});

	it("circles and polygons mix without confusing the run detection", () => {
		setFenceItems([]);
		addFencePoint("fence_circle_exclusion", 9, 9);   // defaults to radius 100
		for (const [la, lo] of [[1, 1], [1, 2], [2, 2]]) addFencePoint("fence_inclusion", la, lo);
		expect(fenceGeometryProblem()).toBeNull();
	});
});

describe("an empty plan panel must not claim the vehicle has no plan", () => {
	// It meant two different things and said neither: "the aircraft has no
	// mission" and "nobody has asked the aircraft". On a fresh page load, or
	// after a reconnect where the daemon may have restarted, it is always the
	// second — and the panel read as the first.
	beforeEach(() => clearPlanRead());

	it("starts as not-read, because nothing has been asked yet", () => {
		expect($planRead.get()).toEqual({ mission: false, fence: false, rally: false });
	});

	it("a readback is what makes an empty plan mean 'the vehicle has none'", () => {
		markPlanRead("mission");
		expect($planRead.get().mission).toBe(true);
		expect($planRead.get().fence).toBe(false);   // asked about one plane only
	});

	it("each plane is tracked separately, since each is pulled separately", () => {
		markPlanRead("fence");
		markPlanRead("rally");
		expect($planRead.get()).toEqual({ mission: false, fence: true, rally: true });
	});

	it("a reconnect takes the claim back", () => {
		// What the vehicle holds may have changed while nobody was listening.
		markPlanRead("mission");
		markPlanRead("fence");
		clearPlanRead();
		expect($planRead.get()).toEqual({ mission: false, fence: false, rally: false });
	});
});
