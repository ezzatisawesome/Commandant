import { describe, it, expect, beforeEach } from "vitest";

import {
	$visibleFields, $extraRows, stripRows, setCell, addCell, addRow, removeRow,
	moveCell, isDerivedKey, allFieldOptions, CHANNEL_GROUPS,
} from "@/stores/displayConfig.store";

// The strip is edited in place, so its layout model is what the operator is
// actually manipulating. These pin the grid semantics.

beforeEach(() => {
	$visibleFields.set(["airspeed", "alt", "mode"]);
	$extraRows.set([["aglFt", "wind"]]);
});

describe("strip grid", () => {
	it("presents row 0 plus the extra rows", () => {
		expect(stripRows()).toEqual([["airspeed", "alt", "mode"], ["aglFt", "wind"]]);
	});

	it("swaps a cell in place, in either row", () => {
		setCell(0, 1, "voltage");
		expect($visibleFields.get()).toEqual(["airspeed", "voltage", "mode"]);
		setCell(1, 0, "sunEl");
		expect($extraRows.get()).toEqual([["sunEl", "wind"]]);
	});

	it("removes a cell when given an empty key", () => {
		setCell(0, 1, "");
		expect($visibleFields.get()).toEqual(["airspeed", "mode"]);
		setCell(1, 1, "");
		expect($extraRows.get()).toEqual([["aglFt"]]);
	});

	it("appends to the row the operator clicked + on", () => {
		addCell(0, "throttle");
		addCell(1, "fenceDist");
		expect($visibleFields.get()).toEqual(["airspeed", "alt", "mode", "throttle"]);
		expect($extraRows.get()).toEqual([["aglFt", "wind", "fenceDist"]]);
	});

	it("adds and removes whole rows, never removing row 0", () => {
		addRow();
		expect(stripRows()).toHaveLength(3);
		expect(stripRows()[2]).toEqual([]);
		removeRow(2);
		expect(stripRows()).toHaveLength(2);
		// Row 0 is emptied rather than deleted, so the strip always has a row.
		removeRow(0);
		expect(stripRows()).toHaveLength(2);
		expect(stripRows()[0]).toEqual([]);
	});

	it("moves a cell within its row and no-ops at the edges", () => {
		moveCell(0, 0, 1);
		expect($visibleFields.get()).toEqual(["alt", "airspeed", "mode"]);
		moveCell(0, 0, -1);                                    // already leftmost
		expect($visibleFields.get()).toEqual(["alt", "airspeed", "mode"]);
		moveCell(0, 2, 1);                                     // already rightmost
		expect($visibleFields.get()).toEqual(["alt", "airspeed", "mode"]);
	});

	it("ignores edits to a row that does not exist", () => {
		expect(() => { setCell(9, 0, "alt"); addCell(9, "alt"); moveCell(9, 0, 1); }).not.toThrow();
		expect(stripRows()).toHaveLength(2);
	});
});

describe("field catalog", () => {
	it("offers telemetry and derived fields from one list", () => {
		const opts = allFieldOptions();
		expect(opts.some((o) => o.key === "airspeed")).toBe(true);
		expect(opts.some((o) => o.key === "aglFt")).toBe(true);
	});

	it("names every option as a dotted channel under a known subsystem", () => {
		const known = new Set(CHANNEL_GROUPS.map((g) => g.ns));
		for (const o of allFieldOptions()) {
			expect(o.channel, o.key).toMatch(/^[a-z]+\.[a-z_]+$/);
			expect(o.channel.startsWith(`${o.group}.`), o.channel).toBe(true);
			expect(known, o.channel).toContain(o.group);
		}
		const byKey = new Map(allFieldOptions().map((o) => [o.key, o.channel]));
		expect(byKey.get("voltage")).toBe("bus.voltage");
		expect(byKey.get("alt")).toBe("nav.alt");
		expect(byKey.get("wind")).toBe("derived.wind");
	});

	it("gives every channel a distinct id", () => {
		const chans = allFieldOptions().map((o) => o.channel);
		expect(new Set(chans).size).toBe(chans.length);
	});

	it("lists channels in subsystem order, so the picker groups contiguously", () => {
		const order = CHANNEL_GROUPS.map((g) => g.ns);
		const seen = allFieldOptions().map((o) => order.indexOf(o.group));
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		// Derived values are marked as computed rather than read off the wire.
		expect(allFieldOptions().filter((o) => o.derived).map((o) => o.key))
			.toEqual(["aglFt", "drift", "fenceDist", "sunEl", "targetDist", "wind"]);
	});

	it("distinguishes derived keys, which are computed rather than on the wire", () => {
		expect(isDerivedKey("aglFt")).toBe(true);
		expect(isDerivedKey("wind")).toBe(true);
		expect(isDerivedKey("airspeed")).toBe(false);
	});
});
