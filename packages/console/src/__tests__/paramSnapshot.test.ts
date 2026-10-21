import { describe, it, expect } from "vitest";

import {
	SNAPSHOT_KIND, diffSnapshot, makeSnapshot, parseSnapshot, snapshotFilename,
} from "@/lib/paramSnapshot";
import type { ParamEntry } from "@/stores/params.store";

const live = (vals: Record<string, number>): Record<string, ParamEntry> =>
	Object.fromEntries(Object.entries(vals).map(([name, value], i) =>
		[name, { name, value, ptype: 9, index: i }]));

describe("taking a snapshot", () => {
	it("records values, sorted, with a wall-clock stamp a human will read later", () => {
		const snap = makeSnapshot(live({ Z_LAST: 2, A_FIRST: 1 }),
			{ label: "pre-flight", vehicle: [1, 1], now: new Date("2026-10-18T12:00:00Z") });
		expect(snap.kind).toBe(SNAPSHOT_KIND);
		expect(Object.keys(snap.params)).toEqual(["A_FIRST", "Z_LAST"]);
		expect(snap.takenAt).toBe("2026-10-18T12:00:00.000Z");
		expect(snap.vehicle).toEqual([1, 1]);
	});

	it("stores no types — PX4 owns those", () => {
		// A snapshot that disagreed with the vehicle about a parameter's type
		// would be worse than one that says nothing about types at all.
		const snap = makeSnapshot(live({ FW_AIRSPD_TRIM: 15 }));
		expect(JSON.stringify(snap)).not.toMatch(/ptype/);
	});

	it("round-trips through JSON, which is the only thing a file can do", () => {
		const snap = makeSnapshot(live({ FW_AIRSPD_TRIM: 15.5, MIS_TKO_LAND_REQ: 2 }));
		const back = parseSnapshot(JSON.stringify(snap));
		expect("snapshot" in back && back.snapshot.params).toEqual(snap.params);
	});
});

describe("reading a file back", () => {
	// A snapshot is read after an incident, by someone who needs it to be
	// exactly what it says. Every rejection names the reason.
	it("rejects something that is not JSON", () => {
		expect(parseSnapshot("<html>nope")).toEqual({ error: expect.stringMatching(/not JSON/) });
	});

	it("rejects another tool's JSON rather than guessing", () => {
		const r = parseSnapshot(JSON.stringify({ params: { A: 1 } }));
		expect("error" in r && r.error).toMatch(/not a Commandant param snapshot/);
	});

	it("rejects a newer format instead of reading it wrong", () => {
		const r = parseSnapshot(JSON.stringify({ kind: SNAPSHOT_KIND, version: 2, params: {} }));
		expect("error" in r && r.error).toMatch(/version 2/);
	});

	it("rejects the whole file for one bad value, never half of it", () => {
		// Half a parameter set loaded silently is how a diff comes to be trusted
		// while describing something other than the file.
		const r = parseSnapshot(JSON.stringify({
			kind: SNAPSHOT_KIND, version: 1,
			params: { GOOD: 1, BAD: "twelve" },
		}));
		expect("error" in r && r.error).toMatch(/BAD is not a finite number/);
	});

	it("rejects NaN, which JSON.parse accepts via null-ish tricks", () => {
		const r = parseSnapshot('{"kind":"commandant.params","version":1,"params":{"A":1e999}}');
		expect("error" in r).toBe(true);
	});

	it("tolerates a missing label and vehicle — they are notes, not data", () => {
		const r = parseSnapshot(JSON.stringify({
			kind: SNAPSHOT_KIND, version: 1, params: { A: 1 },
		}));
		expect("snapshot" in r && r.snapshot.label).toBe("");
		expect("snapshot" in r && r.snapshot.vehicle).toBeNull();
	});
});

describe("diffing against the live table", () => {
	it("reports a changed value with both sides", () => {
		const snap = makeSnapshot(live({ FW_AIRSPD_TRIM: 15 }));
		const d = diffSnapshot(snap, live({ FW_AIRSPD_TRIM: 18 }));
		expect(d).toEqual([{ name: "FW_AIRSPD_TRIM", kind: "changed", snapshot: 15, vehicle: 18 }]);
	});

	it("is silent when nothing moved", () => {
		const snap = makeSnapshot(live({ A: 1, B: 2 }));
		expect(diffSnapshot(snap, live({ A: 1, B: 2 }))).toEqual([]);
	});

	it("reports BOTH one-sided cases, rather than intersecting them away", () => {
		// A parameter in one and not the other usually means a firmware version
		// change, which is a more important thing to learn from a diff than a
		// changed number. Quietly intersecting would hide the finding worth
		// having.
		const snap = makeSnapshot(live({ KEPT: 1, GONE: 2 }));
		const d = diffSnapshot(snap, live({ KEPT: 1, NEW: 3 }));
		expect(d).toEqual([
			{ name: "GONE", kind: "only-in-snapshot", snapshot: 2 },
			{ name: "NEW", kind: "only-on-vehicle", vehicle: 3 },
		]);
	});

	it("does not report a float that merely round-tripped", () => {
		// These have been through a MAVLink float32 and back. An exact compare
		// reports them as changed, which is noise that trains the operator to
		// ignore the list.
		const snap = makeSnapshot(live({ FW_AIRSPD_TRIM: 15.000000001 }));
		expect(diffSnapshot(snap, live({ FW_AIRSPD_TRIM: 15 }))).toEqual([]);
	});

	it("still reports a small but real change on a small value", () => {
		// The tolerance is relative, so it does not swallow a genuine edit to a
		// parameter whose values are near zero.
		const snap = makeSnapshot(live({ TRIM_ROLL: 0.0 }));
		expect(diffSnapshot(snap, live({ TRIM_ROLL: 0.05 }))).toHaveLength(1);
	});

	it("is sorted, so two runs of the same diff read the same", () => {
		const snap = makeSnapshot(live({ Z: 1, A: 1, M: 1 }));
		const d = diffSnapshot(snap, live({ Z: 2, A: 2, M: 2 }));
		expect(d.map((x) => x.name)).toEqual(["A", "M", "Z"]);
	});
});

describe("the filename", () => {
	it("sorts chronologically and says what it is", () => {
		const snap = makeSnapshot({}, { label: "Pre-flight #2", now: new Date("2026-10-18T12:34:56Z") });
		const f = snapshotFilename(snap);
		expect(f).toMatch(/^commandant-params-2026-10-18T12-34-56-000/);
		expect(f).toMatch(/pre-flight-2\.json$/);
	});

	it("survives a label that is all punctuation", () => {
		const snap = makeSnapshot({}, { label: "!!!", now: new Date("2026-10-18T12:00:00Z") });
		expect(snapshotFilename(snap)).toMatch(/\.json$/);
		expect(snapshotFilename(snap)).not.toMatch(/--\./);
	});
});
