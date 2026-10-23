import { describe, it, expect } from "vitest";

import { cellHoverText, isClipped } from "@/lib/strip";

describe("what a clipped telemetry cell reveals on hover", () => {
	it("names the channel as well as the value, since the label is clipped too", () => {
		// The case that motivated this: the label is what gets cut, so a tooltip
		// of the value alone leaves you guessing which channel you are reading.
		expect(cellHoverText({ label: "GLOBAL_POSITION_INT", value: "123.4", unit: "m" }))
			.toBe("GLOBAL_POSITION_INT: 123.4 m");
	});

	it("omits the unit cleanly when a channel has none", () => {
		expect(cellHoverText({ label: "MODE", value: "AUTO.MISSION" }))
			.toBe("MODE: AUTO.MISSION");
	});

	it("keeps the cell's own explanation when it has one", () => {
		expect(cellHoverText({
			label: "AGL", value: "12", unit: "m",
			title: "Above ground level, from terrain under the aircraft",
		})).toBe("AGL: 12 m — Above ground level, from terrain under the aircraft");
	});

	it("reveals an em dash placeholder rather than claiming a reading", () => {
		// A missing value is shown as an em dash in the strip; the hover text must
		// not dress that up into something that looks like data.
		expect(cellHoverText({ label: "WIND", value: "—", unit: "m/s" }))
			.toBe("WIND: — m/s");
	});
});

describe("deciding whether a cell is actually cut off", () => {
	it("is true when the text overflows its slice of the row", () => {
		expect(isClipped({ scrollWidth: 180, clientWidth: 96 })).toBe(true);
	});

	it("is false when the text fits", () => {
		expect(isClipped({ scrollWidth: 72, clientWidth: 96 })).toBe(false);
	});

	it("tolerates a sub-pixel overflow, which is not clipping", () => {
		// Text metrics routinely report a fraction more than the box on text that
		// is entirely visible. Without the tolerance the bubble appears over
		// readable cells, and this row is hovered constantly.
		expect(isClipped({ scrollWidth: 97, clientWidth: 96 })).toBe(false);
		expect(isClipped({ scrollWidth: 98, clientWidth: 96 })).toBe(true);
	});

	it("is false for a cell that has not mounted yet", () => {
		expect(isClipped(null)).toBe(false);
		expect(isClipped(undefined)).toBe(false);
	});
});
