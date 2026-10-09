import { describe, it, expect } from "vitest";

import {
	isAlerting, dwellMs, selectAlerts, SEV_ERROR, SEV_WARNING,
} from "@/lib/alerts";
import type { StatusEntry } from "@/stores/statustext.store";

// The alert surface exists because the status log moved behind the dock. If this
// policy is wrong in either direction the hole is still open: too strict and a
// failsafe goes unseen, too loose and the operator learns to ignore the banner.

let seq = 0;
const entry = (severity: number, text = "msg"): StatusEntry =>
	({ id: seq++, severity, text, t: 1_700_000_000_000 });

describe("which messages interrupt", () => {
	it("interrupts for warning and worse", () => {
		for (const sev of [0, 1, 2, 3, 4]) expect(isAlerting(sev)).toBe(true);
	});

	it("leaves notice, info and debug in the log only", () => {
		// PX4 is chatty at these levels: every mode change and mission item. An
		// alert that fires on routine chatter trains the operator to dismiss it.
		for (const sev of [5, 6, 7]) expect(isAlerting(sev)).toBe(false);
	});

	it("draws the line exactly at warning", () => {
		expect(isAlerting(SEV_WARNING)).toBe(true);
		expect(isAlerting(SEV_WARNING + 1)).toBe(false);
	});
});

describe("how long an alert stays", () => {
	it("never auto-dismisses an error or worse", () => {
		for (const sev of [0, 1, 2, 3]) expect(dwellMs(sev)).toBeNull();
	});

	it("times out a warning", () => {
		expect(dwellMs(SEV_WARNING)).toBeGreaterThan(0);
	});

	it("puts the boundary at error, not at warning", () => {
		expect(dwellMs(SEV_ERROR)).toBeNull();
		expect(dwellMs(SEV_ERROR + 1)).not.toBeNull();
	});
});

describe("selecting what to show", () => {
	it("shows nothing when the log is quiet", () => {
		expect(selectAlerts([], new Set())).toEqual([]);
	});

	it("ignores everything below warning", () => {
		const log = [entry(6, "info"), entry(5, "notice"), entry(7, "debug")];
		expect(selectAlerts(log, new Set())).toEqual([]);
	});

	it("shows the newest first, because that explains the current state", () => {
		const a = entry(4, "first"), b = entry(4, "second"), c = entry(4, "third");
		const out = selectAlerts([a, b, c], new Set());
		expect(out.map((x) => x.text)).toEqual(["third", "second", "first"]);
	});

	it("caps the stack so a cascade cannot cover the globe", () => {
		const log = Array.from({ length: 20 }, () => entry(2, "critical"));
		expect(selectAlerts(log, new Set())).toHaveLength(3);
		expect(selectAlerts(log, new Set(), 1)).toHaveLength(1);
	});

	it("honours dismissals and keeps showing the rest", () => {
		const a = entry(4, "a"), b = entry(3, "b");
		const out = selectAlerts([a, b], new Set([b.id]));
		expect(out.map((x) => x.text)).toEqual(["a"]);
	});

	it("marks errors sticky and warnings not", () => {
		const out = selectAlerts([entry(4, "warn"), entry(2, "crit")], new Set());
		const byText = new Map(out.map((x) => [x.text, x.sticky]));
		expect(byText.get("crit")).toBe(true);
		expect(byText.get("warn")).toBe(false);
	});

	it("carries the original entry through untouched", () => {
		const e = entry(1, "failsafe: geofence breach");
		const [out] = selectAlerts([e], new Set());
		expect(out.id).toBe(e.id);
		expect(out.text).toBe(e.text);
		expect(out.severity).toBe(e.severity);
		expect(out.t).toBe(e.t);
	});

	it("surfaces a real PX4 failsafe rather than filtering it out", () => {
		// Measured string from this project's own flight: the mode refusal that an
		// accepted ack hid. Severity 4 on PX4.
		const log = [entry(6, "Mission accepted"),
			entry(4, "Geofence invalid, doesn't contain current vehicle")];
		const out = selectAlerts(log, new Set());
		expect(out).toHaveLength(1);
		expect(out[0].text).toContain("Geofence invalid");
	});
});
