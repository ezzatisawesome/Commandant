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
	const shown = (
		entries: StatusEntry[], dismissed: ReadonlySet<number> = new Set(), limit?: number,
	) => selectAlerts(entries, dismissed, limit).visible;

	it("shows nothing when the log is quiet", () => {
		expect(shown([])).toEqual([]);
	});

	it("ignores everything below warning", () => {
		const log = [entry(6, "info"), entry(5, "notice"), entry(7, "debug")];
		const out = selectAlerts(log, new Set());
		expect(out.visible).toEqual([]);
		expect(out.overflow).toEqual([]);   // not a backlog either
	});

	it("shows the newest first, because that explains the current state", () => {
		const a = entry(4, "first"), b = entry(4, "second"), c = entry(4, "third");
		expect(shown([a, b, c]).map((x) => x.text)).toEqual(["third", "second", "first"]);
	});

	it("caps the stack so a cascade cannot cover the globe", () => {
		const log = Array.from({ length: 20 }, () => entry(2, "critical"));
		expect(shown(log)).toHaveLength(3);
		expect(shown(log, new Set(), 1)).toHaveLength(1);
	});

	it("reports the older ones as overflow rather than hiding that they exist", () => {
		const log = Array.from({ length: 10 }, (_, i) => entry(4, `w${i}`));
		const { visible, overflow } = selectAlerts(log, new Set());
		expect(visible.map((x) => x.text)).toEqual(["w9", "w8", "w7"]);
		// Newest-first ordering continues through the overflow.
		expect(overflow.map((x) => x.text)).toEqual(["w6", "w5", "w4", "w3", "w2", "w1", "w0"]);
		expect(visible.length + overflow.length).toBe(10);
	});

	it("honours dismissals and keeps showing the rest", () => {
		const a = entry(4, "a"), b = entry(3, "b");
		expect(shown([a, b], new Set([b.id])).map((x) => x.text)).toEqual(["a"]);
	});

	it("marks errors sticky and warnings not", () => {
		const out = shown([entry(4, "warn"), entry(2, "crit")]);
		const byText = new Map(out.map((x) => [x.text, x.sticky]));
		expect(byText.get("crit")).toBe(true);
		expect(byText.get("warn")).toBe(false);
	});

	it("carries the original entry through untouched", () => {
		const e = entry(1, "failsafe: geofence breach");
		const [out] = shown([e]);
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
		const out = shown(log);
		expect(out).toHaveLength(1);
		expect(out[0].text).toContain("Geofence invalid");
	});
});

describe("a backlog must not be replayed in reverse", () => {
	// This is the bug this block exists for, traced before it was fixed: the
	// selection returned the newest three and the component armed dwell timers
	// only for those three, so each timeout promoted the next three OLDER entries
	// as fresh toasts. Ten severity-4 warnings with a 12 s dwell produced
	// t=0 w9,w8,w7; t=12 w6,w5,w4; t=24 w3,w2,w1; t=36 w0 — forty-eight seconds
	// of toasts ending with the OLDEST warning alone on screen as though it had
	// just happened. During a failsafe cascade the operator was shown the
	// situation backwards.
	//
	// The component's policy, simulated here because it is the policy and not the
	// JSX that must hold: retire everything behind the visible window on sight,
	// count it, and let the visible ones time out without ever being replaced
	// from the backlog.
	function run(entries: StatusEntry[]) {
		let dismissed = new Set<number>();
		let suppressed = 0;
		const armed = new Set<number>();
		const frames: string[][] = [];
		// Each pass is "React re-rendered, then every armed dwell expired".
		for (let pass = 0; pass < 6; pass++) {
			const { visible, overflow } = selectAlerts(entries, dismissed);
			if (overflow.length) {
				for (const a of overflow) dismissed.add(a.id);
				suppressed += overflow.length;
				continue;                     // retiring re-renders; nothing shown yet
			}
			frames.push(visible.map((a) => a.text));
			if (visible.length === 0) break;
			const timing = visible.filter((a) => !a.sticky && !armed.has(a.id));
			if (timing.length === 0) break;   // sticky: stays until clicked
			for (const a of timing) armed.add(a.id);
			dismissed = new Set([...dismissed, ...timing.map((a) => a.id)]);
		}
		return { frames, suppressed };
	}

	it("shows the newest three once and then nothing, not the flight in reverse", () => {
		const log = Array.from({ length: 10 }, (_, i) => entry(4, `w${i}`));
		const { frames, suppressed } = run(log);
		expect(frames).toEqual([["w9", "w8", "w7"], []]);
		expect(suppressed).toBe(7);
	});

	it("never promotes an older warning after a newer one times out", () => {
		const log = Array.from({ length: 10 }, (_, i) => entry(4, `w${i}`));
		const shownEver = run(log).frames.flat();
		for (const old of ["w0", "w1", "w2", "w3", "w4", "w5", "w6"]) {
			expect(shownEver).not.toContain(old);
		}
	});

	it("does not queue a cascade of sticky errors behind each other for ever", () => {
		// Severity 2 never auto-dismisses, so before the fix an eight-deep
		// cascade was an eight-deep queue: three on screen until clicked, then
		// three more, with the first message of the failsafe arriving last.
		const log = Array.from({ length: 8 }, (_, i) => entry(2, `e${i}`));
		const { frames, suppressed } = run(log);
		expect(frames).toEqual([["e7", "e6", "e5"]]);
		expect(suppressed).toBe(5);
	});

	it("keeps the newest alert visible when a trickle arrives behind it", () => {
		// The dwell belongs to the alert, armed once. A new arrival used to clear
		// every timer and re-arm each visible alert with a full dwell, so under a
		// trickle a toast from the start of the flight stayed up all flight.
		const a = entry(4, "first");
		const armedAt = new Map<number, number>();
		for (let tick = 0; tick < 3; tick++) {
			const log = [a, ...Array.from({ length: tick }, (_, i) => entry(4, `later${i}`))];
			for (const v of selectAlerts(log, new Set()).visible) {
				if (!v.sticky && !armedAt.has(v.id)) armedAt.set(v.id, tick);
			}
		}
		expect(armedAt.get(a.id)).toBe(0);    // armed on its first appearance only
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
