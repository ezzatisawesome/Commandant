import { describe, it, expect } from "vitest";

import {
	isAlerting, dwellMs, selectAlerts, SEV_ERROR, SEV_WARNING,
} from "@/lib/alerts";
import type { StatusEntry } from "@/stores/statustext.store";
import { GROUP_STALE_MS, groupAgeMs, isNum } from "@/lib/flightGeometry";

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

describe("a health chip whose source has stopped must not read as healthy", () => {
	// HealthStrip is, in its own words, "the one readout that must never need a
	// click" — so it is the one most trusted at a glance. EKF, GPS and the
	// battery warning come from EKF_STATUS_REPORT, GPS_RAW_INT and SYS_STATUS on
	// their own schedules, and gs re-requests the extras after a vehicle reboot:
	// there is a window where the frame is fresh at 25 Hz and these are not
	// arriving at all. Drawn from the last value received, that window shows a
	// green "EKF OK" for an estimator that stopped reporting minutes ago.
	//
	// Tested as the decision, the way the strip computes it.
	const coldAfter = GROUP_STALE_MS;
	const isCold = (ages: Record<string, number> | undefined, group: string) => {
		const age = groupAgeMs(ages, group);
		return isNum(age) && age > coldAfter;
	};

	it("treats a stopped stream as cold, however fresh the frame is", () => {
		// dataAgeMs would be ~40 here: the aircraft is talking.
		const ages = { position: 40, ekf: 240_000, gps: 180_000 };
		expect(isCold(ages, "ekf")).toBe(true);
		expect(isCold(ages, "gps")).toBe(true);
		expect(isCold(ages, "position")).toBe(false);
	});

	it("does not call a live stream cold", () => {
		expect(isCold({ ekf: 200, gps: 400 }, "ekf")).toBe(false);
	});

	it("says nothing about a group that has never been seen", () => {
		// Absent is not 0: "no EKF report yet" and "one from four minutes ago"
		// are different, and neither is "healthy".
		expect(isCold({ position: 40 }, "ekf")).toBe(false);
		expect(groupAgeMs({ position: 40 }, "ekf")).toBeNull();
	});

	it("says nothing when the daemon reports no ages at all", () => {
		// An older gs. The chips then behave exactly as they did before, which is
		// the right fallback: no ages means no basis to call anything stale.
		expect(isCold(undefined, "ekf")).toBe(false);
	});
});
