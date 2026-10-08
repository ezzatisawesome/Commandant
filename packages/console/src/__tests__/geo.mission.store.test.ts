import { describe, it, expect, beforeEach } from "vitest";

import { $fenceItems, addFencePoint, fenceItemsForPush, clearFence, removeFenceItem } from "@/stores/geo.store";
import { $missionItems, addWaypoint, removeItem, reorderItem, clearMission, updateItem } from "@/stores/mission.store";

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
