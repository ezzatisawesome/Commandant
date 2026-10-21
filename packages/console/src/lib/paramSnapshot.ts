// Param snapshots: save the vehicle's parameter set, load one back, and see
// what differs. The last unbuilt Phase 2 item.
//
// This is the one place Commandant deliberately keeps state on disk. Everywhere
// else it is stateless on purpose — the vehicle owns its params, Guppi owns
// flight history — and the exception is justified by the question a snapshot
// answers, which nothing else can: *what changed since the configuration that
// flew?* A param set is ~1000 values that a week of tuning moves a handful of,
// and after an incident "which handful" is the whole question.
//
// A file, not a server: the console is a static app served by the hub, so a
// download and a file picker need no backend and work on a phone in a field
// with the hub's WiFi and nothing else. The file is plain JSON so it can be
// read, diffed and committed by anything.

import type { ParamEntry } from "@/stores/params.store";

/** The on-disk shape. Versioned, because a format that is read back after an
 *  incident is one that must still be readable then. */
export interface ParamSnapshot {
	kind: "commandant.params";
	version: 1;
	/** Wall-clock ISO 8601 — a snapshot is read by a human, later. */
	takenAt: string;
	/** Free text: which airframe, which session. The operator's own note. */
	label: string;
	/** The locked MAVLink sysid/compid, when known, so a snapshot taken from
	 *  one aircraft is recognisable as not belonging to another. */
	vehicle?: [number, number] | null;
	/** name -> value. Types are not stored: PX4 owns them, and a snapshot that
	 *  disagreed with the vehicle about a type would be worse than one that
	 *  says nothing. */
	params: Record<string, number>;
}

export const SNAPSHOT_KIND = "commandant.params";

export function makeSnapshot(
	params: Record<string, ParamEntry>,
	opts: { label?: string; vehicle?: [number, number] | null; now?: Date } = {},
): ParamSnapshot {
	const out: Record<string, number> = {};
	for (const name of Object.keys(params).sort()) out[name] = params[name].value;
	return {
		kind: SNAPSHOT_KIND,
		version: 1,
		takenAt: (opts.now ?? new Date()).toISOString(),
		label: opts.label ?? "",
		vehicle: opts.vehicle ?? null,
		params: out,
	};
}

/** Parse a snapshot file, or explain why it is not one.
 *
 *  Returns a reason rather than throwing, and never a partial snapshot: half a
 *  parameter set loaded silently is how a diff comes to be trusted while
 *  describing something other than the file. */
export function parseSnapshot(text: string): { snapshot: ParamSnapshot } | { error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: "not JSON — is this the right file?" };
	}
	if (!raw || typeof raw !== "object") return { error: "not an object" };
	const o = raw as Record<string, unknown>;
	if (o.kind !== SNAPSHOT_KIND) {
		return { error: `not a Commandant param snapshot (kind: ${String(o.kind ?? "absent")})` };
	}
	if (o.version !== 1) {
		return { error: `snapshot version ${String(o.version)} — this build reads version 1` };
	}
	if (!o.params || typeof o.params !== "object") return { error: "no params in the file" };
	const params: Record<string, number> = {};
	for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
		if (typeof v !== "number" || !Number.isFinite(v)) {
			return { error: `parameter ${k} is not a finite number` };
		}
		params[k] = v;
	}
	return {
		snapshot: {
			kind: SNAPSHOT_KIND, version: 1,
			takenAt: typeof o.takenAt === "string" ? o.takenAt : "",
			label: typeof o.label === "string" ? o.label : "",
			vehicle: Array.isArray(o.vehicle) && o.vehicle.length === 2
				? [Number(o.vehicle[0]), Number(o.vehicle[1])] : null,
			params,
		},
	};
}

export type DiffKind = "changed" | "only-in-snapshot" | "only-on-vehicle";

export interface ParamDiff {
	name: string;
	kind: DiffKind;
	/** The value in the snapshot, when it has one. */
	snapshot?: number;
	/** The value on the vehicle now, when it has one. */
	vehicle?: number;
}

/** What differs between a snapshot and the live table.
 *
 *  Both one-sided cases are reported rather than skipped. A parameter present
 *  in one and not the other usually means a firmware version change, and that
 *  is a more important thing to learn from a diff than a changed number —
 *  quietly intersecting the two would hide exactly the finding worth having.
 *
 *  Compared with a tolerance, because these are floats that have been through
 *  a MAVLink float32 and back: an exact comparison reports a parameter as
 *  changed because it round-tripped, which is noise that trains the operator to
 *  ignore the list. */
export function diffSnapshot(
	snapshot: ParamSnapshot,
	live: Record<string, ParamEntry>,
	eps = 1e-6,
): ParamDiff[] {
	const out: ParamDiff[] = [];
	const names = new Set([...Object.keys(snapshot.params), ...Object.keys(live)]);
	for (const name of [...names].sort()) {
		const s = snapshot.params[name];
		const v = live[name]?.value;
		if (s === undefined) {
			out.push({ name, kind: "only-on-vehicle", vehicle: v });
		} else if (v === undefined) {
			out.push({ name, kind: "only-in-snapshot", snapshot: s });
		} else if (Math.abs(s - v) > Math.max(eps, Math.abs(s) * eps)) {
			out.push({ name, kind: "changed", snapshot: s, vehicle: v });
		}
	}
	return out;
}

/** A filename that sorts chronologically and says what it is. */
export function snapshotFilename(snap: ParamSnapshot): string {
	const stamp = (snap.takenAt || new Date().toISOString())
		.replace(/[:.]/g, "-").replace(/Z$/, "");
	const label = snap.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return `commandant-params-${stamp}${label ? `-${label}` : ""}.json`;
}
