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
