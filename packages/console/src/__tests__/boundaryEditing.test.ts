import { describe, it, expect, beforeEach } from "vitest";

import {
	$fenceItems,
	clearFence,
	fenceItemsForPush,
	insertFencePointAfter,
	setFenceItems,
	updateFenceItem,
} from "@/stores/geo.store";
import type { FenceItem } from "@/types/app";

// Reshaping a boundary, not merely nudging its existing corners. Dragging a
// corner can only move the corners you already have; adding one used to mean
// appending, which lands the new vertex at the END of the ring and puts a spur
// across the polygon instead of a bend in the edge you grabbed.

const poly = (kind: FenceItem["kind"], pts: Array<[number, number]>): FenceItem[] =>
	pts.map(([lat, lon], seq) => ({ seq, kind, lat, lon }));

describe("insertFencePointAfter", () => {
	beforeEach(() => clearFence());

	it("inserts into the ring, not at the end", () => {
		setFenceItems(poly("fence_inclusion", [[0, 0], [0, 1], [1, 1], [1, 0]]));
		// Bend the edge between vertex 0 and vertex 1.
		insertFencePointAfter(0, 0, 0.5);
		const got = $fenceItems.get();
		expect(got).toHaveLength(5);
		expect(got[1].lat).toBe(0);
		expect(got[1].lon).toBe(0.5);
		// The winding order survives: the original corners stay in sequence.
		expect(got.map((p) => [p.lat, p.lon])).toEqual([
			[0, 0], [0, 0.5], [0, 1], [1, 1], [1, 0],
		]);
	});

	it("resequences so the run stays contiguous for the push", () => {
		setFenceItems(poly("fence_inclusion", [[0, 0], [0, 1], [1, 1]]));
		insertFencePointAfter(1, 0.5, 1);
		expect($fenceItems.get().map((p) => p.seq)).toEqual([0, 1, 2, 3]);
	});

	it("inherits the kind of the edge it splits", () => {
		setFenceItems(poly("fence_exclusion", [[0, 0], [0, 1], [1, 1]]));
		insertFencePointAfter(0, 0, 0.5);
		expect($fenceItems.get().every((p) => p.kind === "fence_exclusion")).toBe(true);
	});

	it("keeps two adjacent polygons separate rather than merging their runs", () => {
		// Two rings of different kinds back to back. Inserting into the first must
		// not bleed a vertex into the second, which would change both shapes.
		setFenceItems([
			...poly("fence_inclusion", [[0, 0], [0, 1], [1, 1]]),
			...poly("fence_exclusion", [[5, 5], [5, 6], [6, 6]]).map((p, i) => ({ ...p, seq: 3 + i })),
		]);
		insertFencePointAfter(0, 0, 0.5);
		const got = $fenceItems.get();
		expect(got.filter((p) => p.kind === "fence_inclusion")).toHaveLength(4);
		expect(got.filter((p) => p.kind === "fence_exclusion")).toHaveLength(3);
		// The exclusion run is still contiguous, which is what the push contract
		// (param1 = vertices in this polygon) depends on.
		const kinds = got.map((p) => p.kind);
		expect(kinds.slice(0, 4).every((k) => k === "fence_inclusion")).toBe(true);
		expect(kinds.slice(4).every((k) => k === "fence_exclusion")).toBe(true);
	});

	it("restamps vertexCount so the reshaped polygon uploads correctly", () => {
		setFenceItems(poly("fence_inclusion", [[0, 0], [0, 1], [1, 1]]));
		insertFencePointAfter(0, 0, 0.5);
		const pushed = fenceItemsForPush();
		// Four vertices now, and every one of them must say so.
		expect(pushed).toHaveLength(4);
		expect(pushed.every((p) => p.params?.vertexCount === 4)).toBe(true);
	});

	it("refuses to subdivide a circle, which has no vertex order", () => {
		setFenceItems([{ seq: 0, kind: "fence_circle_inclusion", lat: 0, lon: 0, params: { radius: 100 } }]);
		insertFencePointAfter(0, 0, 0.1);
		expect($fenceItems.get()).toHaveLength(1);
	});

	it("ignores an unknown seq rather than appending a stray vertex", () => {
		setFenceItems(poly("fence_inclusion", [[0, 0], [0, 1], [1, 1]]));
		insertFencePointAfter(42, 9, 9);
		expect($fenceItems.get()).toHaveLength(3);
	});
});

describe("a circle fence's radius is editable as a number and as a drag", () => {
	beforeEach(() => clearFence());

	it("round-trips a dragged radius into the push payload", () => {
		setFenceItems([{ seq: 0, kind: "fence_circle_exclusion", lat: 10, lon: 20, params: { radius: 100 } }]);
		// What the rim grabber does.
		updateFenceItem(0, { params: { radius: 450 } });
		const pushed = fenceItemsForPush();
		expect(pushed[0].params?.radius).toBe(450);
	});

	it("does not stamp a vertexCount onto a circle", () => {
		setFenceItems([{ seq: 0, kind: "fence_circle_inclusion", lat: 10, lon: 20, params: { radius: 250 } }]);
		expect(fenceItemsForPush()[0].params?.vertexCount).toBeUndefined();
	});
});
