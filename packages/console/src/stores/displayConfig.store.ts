import { persistentAtom } from "@nanostores/persistent";

import type { TelemetryFrame } from "@/types/app";

// Phase 5 — configurable display. The HUD's numeric readout is driven by this
// catalog + per-viewer config (which fields show, in what order, and which are
// charted), persisted in localStorage so a viewer's layout survives reloads.
// `kind` controls how the value renders: a number, a text string, or a
// bidirectional control-surface bar.
export type FieldKind = "num" | "text" | "control";

export interface FieldDef {
	key: keyof TelemetryFrame;
	label: string;
	unit?: string;
	digits?: number;
	kind: FieldKind;
	sparkClassName?: string;
}

// Every telemetry field a viewer can choose to show / chart. Numeric fields are
// chartable; text (mode/armed) and control bars are not.
export const FIELD_CATALOG: FieldDef[] = [
	{ key: "mode", label: "Mode", kind: "text" },
	{ key: "armed", label: "Armed", kind: "text" },
	{ key: "airspeed", label: "Airspeed", unit: "m/s", digits: 1, kind: "num", sparkClassName: "text-emerald-400/80" },
	{ key: "groundspeed", label: "Groundspeed", unit: "m/s", digits: 1, kind: "num", sparkClassName: "text-emerald-400/60" },
	{ key: "alt", label: "Altitude", unit: "m", digits: 0, kind: "num", sparkClassName: "text-sky-400/80" },
	{ key: "heading", label: "Heading", unit: "°", digits: 0, kind: "num" },
	{ key: "throttle", label: "Throttle", unit: "%", digits: 0, kind: "num", sparkClassName: "text-amber-400/80" },
	{ key: "roll", label: "Roll", unit: "rad", digits: 2, kind: "num" },
	{ key: "pitch", label: "Pitch", unit: "rad", digits: 2, kind: "num" },
	{ key: "yaw", label: "Yaw", unit: "rad", digits: 2, kind: "num" },
	{ key: "elevator", label: "Elevator", unit: "%", digits: 0, kind: "control" },
	{ key: "aileron", label: "Aileron", unit: "%", digits: 0, kind: "control" },
	{ key: "rudder", label: "Rudder", unit: "%", digits: 0, kind: "control" },
	{ key: "batteryRemaining", label: "Battery", unit: "%", digits: 0, kind: "num", sparkClassName: "text-emerald-400/80" },
	{ key: "voltage", label: "Voltage", unit: "V", digits: 2, kind: "num", sparkClassName: "text-violet-400/80" },
	{ key: "current", label: "Net Current", unit: "A", digits: 1, kind: "num", sparkClassName: "text-rose-400/80" },
	{ key: "genW", label: "Solar Gen", unit: "W", digits: 0, kind: "num", sparkClassName: "text-yellow-400/80" },
	{ key: "loadW", label: "Load", unit: "W", digits: 0, kind: "num", sparkClassName: "text-orange-400/80" },
	{ key: "propW", label: "Propulsion", unit: "W", digits: 0, kind: "num", sparkClassName: "text-orange-300/80" },
	{ key: "motorCurrent", label: "Motor", unit: "A", digits: 1, kind: "num", sparkClassName: "text-rose-400/80" },
	{ key: "irradiance", label: "Irradiance", unit: "W/m²", digits: 0, kind: "num", sparkClassName: "text-yellow-300/80" },
];

// Derived fields are not on the MAVLink wire; they are computed in
// stores/derived.store.ts (terrain clearance, wind, sun, geofence). They are in
// the same catalog so the strip is configured from ONE list rather than having a
// hardcoded "situation" section the operator cannot rearrange.
export const DERIVED_KEYS = ["aglFt", "wind", "drift", "sunEl", "fenceDist", "targetDist"] as const;
export type DerivedKey = (typeof DERIVED_KEYS)[number];

export const DERIVED_CATALOG: Array<{ key: DerivedKey; label: string; unit?: string }> = [
	{ key: "aglFt", label: "AGL", unit: "ft" },
	{ key: "wind", label: "Wind", unit: "m/s" },
	{ key: "drift", label: "Drift", unit: "°" },
	{ key: "sunEl", label: "Sun", unit: "°" },
	{ key: "fenceDist", label: "Fence", unit: "m" },
	{ key: "targetDist", label: "To setpoint", unit: "m" },
];

export const DERIVED_BY_KEY = Object.fromEntries(
	DERIVED_CATALOG.map((d) => [d.key as string, d]),
) as Record<string, { key: DerivedKey; label: string; unit?: string }>;

export function isDerivedKey(key: string): key is DerivedKey {
	return (DERIVED_KEYS as readonly string[]).includes(key);
}

/** Every selectable cell, telemetry and derived alike. */
export function allFieldOptions(): Array<{ key: string; label: string; group: string }> {
	return [
		...FIELD_CATALOG.map((d) => ({
			key: d.key as string, label: d.label, group: "Telemetry",
		})),
		...DERIVED_CATALOG.map((d) => ({ key: d.key, label: d.label, group: "Derived" })),
	];
}

export const FIELD_BY_KEY: Record<string, FieldDef> = Object.fromEntries(
	FIELD_CATALOG.map((d) => [d.key as string, d]),
);

// Defaults mirror the original hardcoded HUD so first-run looks unchanged.
const DEFAULT_VISIBLE: string[] = [
	"mode", "armed", "airspeed", "alt", "heading", "throttle",
	"elevator", "aileron", "rudder", "batteryRemaining", "voltage", "current",
	"genW", "loadW", "motorCurrent", "irradiance",
];
const DEFAULT_CHARTED: string[] = [
	"airspeed", "alt", "throttle", "batteryRemaining", "voltage", "current",
	"genW", "loadW", "motorCurrent", "irradiance",
];

const json = {
	encode: JSON.stringify,
	decode: (s: string): string[] => {
		try {
			const v = JSON.parse(s);
			return Array.isArray(v) ? (v as string[]) : [];
		} catch {
			return [];
		}
	},
};

// Visible fields, in render order; and which of them draw a sparkline. Persisted
// per viewer (localStorage); @nanostores/persistent no-ops safely without storage.
export const $visibleFields = persistentAtom<string[]>("cmdt:visibleFields", DEFAULT_VISIBLE, json);
export const $chartedFields = persistentAtom<string[]>("cmdt:chartedFields", DEFAULT_CHARTED, json);

// --- strip layout: rows of cells ---------------------------------------------
//
// The bottom strip is a GRID the operator edits in place: click a cell to swap
// or remove it, use the + to add one, and add or drop whole rows. Stored as rows
// of keys so the layout round-trips through localStorage exactly as arranged.
//
// $visibleFields stays as row 0 for backward compatibility with the saved config
// of anyone who used the old right-hand rail; extra rows live alongside it.
const DEFAULT_EXTRA_ROWS: string[][] = [
	["aglFt", "wind", "drift", "sunEl", "fenceDist", "targetDist"],
];

const jsonRows = {
	encode: JSON.stringify,
	decode: (s: string): string[][] => {
		try {
			const v = JSON.parse(s);
			return Array.isArray(v) ? (v as string[][]).filter(Array.isArray) : [];
		} catch {
			return [];
		}
	},
};

export const $extraRows = persistentAtom<string[][]>(
	"cmdt:stripRows", DEFAULT_EXTRA_ROWS, jsonRows,
);

/** Every row, row 0 being the legacy visible-fields list. */
export function stripRows(): string[][] {
	return [$visibleFields.get(), ...$extraRows.get()];
}

/** Replace the cell at (row, index). An empty key removes the cell. */
export function setCell(row: number, index: number, key: string) {
	if (row === 0) {
		const next = $visibleFields.get().slice();
		if (key) next[index] = key; else next.splice(index, 1);
		$visibleFields.set(next);
		return;
	}
	const rows = $extraRows.get().map((r) => r.slice());
	const r = rows[row - 1];
	if (!r) return;
	if (key) r[index] = key; else r.splice(index, 1);
	$extraRows.set(rows);
}

/** Append a cell to a row. */
export function addCell(row: number, key: string) {
	if (row === 0) {
		$visibleFields.set([...$visibleFields.get(), key]);
		return;
	}
	const rows = $extraRows.get().map((r) => r.slice());
	if (!rows[row - 1]) return;
	rows[row - 1].push(key);
	$extraRows.set(rows);
}

export function addRow() {
	$extraRows.set([...$extraRows.get(), []]);
}

/** Remove a row. Row 0 is never removed; it is emptied instead. */
export function removeRow(row: number) {
	if (row === 0) { $visibleFields.set([]); return; }
	const rows = $extraRows.get().slice();
	rows.splice(row - 1, 1);
	$extraRows.set(rows);
}

/** Move a cell within its row. */
export function moveCell(row: number, index: number, dir: -1 | 1) {
	const j = index + dir;
	if (row === 0) {
		const next = $visibleFields.get().slice();
		if (j < 0 || j >= next.length) return;
		[next[index], next[j]] = [next[j], next[index]];
		$visibleFields.set(next);
		return;
	}
	const rows = $extraRows.get().map((r) => r.slice());
	const r = rows[row - 1];
	if (!r || j < 0 || j >= r.length) return;
	[r[index], r[j]] = [r[j], r[index]];
	$extraRows.set(rows);
}

export function toggleVisible(key: string) {
	const cur = $visibleFields.get();
	$visibleFields.set(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
}

export function toggleCharted(key: string) {
	const cur = $chartedFields.get();
	$chartedFields.set(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
}

// Move a visible field up/down in render order.
export function moveField(key: string, dir: -1 | 1) {
	const cur = $visibleFields.get();
	const i = cur.indexOf(key);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= cur.length) return;
	const next = cur.slice();
	[next[i], next[j]] = [next[j], next[i]];
	$visibleFields.set(next);
}
