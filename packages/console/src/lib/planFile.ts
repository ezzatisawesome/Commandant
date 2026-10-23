// Mission files in PX4's own format: the QGroundControl `.plan`.
//
// A `.plan` is what QGC saves and what PX4 missions are authored and shared in,
// so a plan opened here can be flown by QGC, uploaded to a real aircraft, or
// flown by AircraftSim (which reads the same file from its missions/ dir) — one
// file, every tool. Commandant keeps its own item shape internally (see
// types/app.d.ts and docs/ws-contract.md); this module is the ONE place that
// shape is translated to and from the file.
//
// Like the param snapshot (lib/paramSnapshot.ts), a deliberate on-disk exception
// to Commandant's statelessness: a plan is authored before the flight and kept
// after it, and the file is the artefact that crosses tools.
//
// Strict on the way in. What this console cannot represent is REFUSED with a
// reason, never dropped: a plan that loads with a survey or a terrain-relative
// leg silently missing is a different mission that looks like the right one.

import type { FenceItem, MissionItem, MissionKind, RallyItem } from "@/types/app";

// MAV_CMD ids (common.xml) for the kinds the console authors.
const CMD: Record<MissionKind, number> = {
	waypoint: 16,       // MAV_CMD_NAV_WAYPOINT
	loiter_unlim: 17,   // MAV_CMD_NAV_LOITER_UNLIM
	loiter_turns: 18,   // MAV_CMD_NAV_LOITER_TURNS
	loiter_time: 19,    // MAV_CMD_NAV_LOITER_TIME
	rtl: 20,            // MAV_CMD_NAV_RETURN_TO_LAUNCH
	land: 21,           // MAV_CMD_NAV_LAND
	takeoff: 22,        // MAV_CMD_NAV_TAKEOFF
};
const KIND: Record<number, MissionKind> = Object.fromEntries(
	Object.entries(CMD).map(([k, v]) => [v, k as MissionKind]));

// MAV_FRAME: the console's altitudes are above HOME, which a plan writes as
// GLOBAL_RELATIVE_ALT (3; QGC AltitudeMode 1). The _INT twin (6) is the same frame.
// RTL carries no position and goes as MAV_FRAME_MISSION (2) — PX4 NAKs the whole
// upload otherwise (the same rule gs applies, bridge.py mission_item_fields).
const FRAME_GLOBAL = 0, FRAME_MISSION = 2, FRAME_RELATIVE = 3, FRAME_RELATIVE_INT = 6;
const QGC_ALT_MODE_RELATIVE = 1;
const PX4_FIRMWARE = 12;            // MAV_AUTOPILOT_PX4
const FIXED_WING = 1;               // MAV_TYPE_FIXED_WING

/** QGC's on-disk shape (the parts this module reads or writes). */
export interface QgcPlan {
	fileType: "Plan";
	version: 1;
	groundStation: string;
	mission: {
		version: 2;
		firmwareType: number;
		vehicleType: number;
		cruiseSpeed: number;
		hoverSpeed: number;
		globalPlanAltitudeMode?: number;
		plannedHomePosition: [number, number, number];
		items: QgcSimpleItem[];
	};
	geoFence: {
		version: 2;
		polygons: { inclusion: boolean; polygon: [number, number][]; version: 1 }[];
		circles: { inclusion: boolean; circle: { center: [number, number]; radius: number }; version: 1 }[];
	};
	rallyPoints: { version: 2; points: [number, number, number][] };
}
export interface QgcSimpleItem {
	type: "SimpleItem";
	command: number;
	frame: number;
	params: (number | null)[];   // param1..param7; null = "autopilot default"
	autoContinue: boolean;
	doJumpId: number;
	Altitude?: number;
	AltitudeMode?: number;
	AMSLAltAboveTerrain?: number | null;
}

export interface Plan {
	mission: MissionItem[];
	fence: FenceItem[];
	rally: RallyItem[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ── console -> file ──────────────────────────────────────────────────────────

/** The seven MAVLink params for one console item, as QGC writes them. */
function itemParams(it: MissionItem): (number | null)[] {
	const p = it.params ?? {};
	const lat = it.lat ?? 0, lon = it.lon ?? 0, alt = it.alt ?? 0;
	switch (it.kind) {
		case "takeoff":      return [p.pitch ?? 0, 0, 0, null, lat, lon, alt];
		case "waypoint":     return [0, p.acceptRadius ?? p.radius ?? 0, 0, null, lat, lon, alt];
		case "loiter_unlim": return [0, 0, p.radius ?? 0, null, lat, lon, alt];
		case "loiter_time":  return [p.seconds ?? 0, 0, p.radius ?? 0, null, lat, lon, alt];
		case "loiter_turns": return [p.turns ?? 0, 0, p.radius ?? 0, null, lat, lon, alt];
		case "land":         return [0, 0, 0, null, lat, lon, 0];
		case "rtl":          return [0, 0, 0, 0, 0, 0, 0];
	}
}

/**
 * Build a `.plan` from the console's draft.
 *
 * `home` is the vehicle's home [lat, lon, alt MSL] — QGC's plannedHomePosition,
 * which the file needs and other tools use to place the above-home altitudes.
 * The caller passes what the vehicle reported; see `plannedHome` for the fallback.
 */
export function toPlan(plan: Plan, home: [number, number, number],
	opts: { cruiseSpeed?: number } = {}): QgcPlan {
	const items: QgcSimpleItem[] = plan.mission.map((it, i) => {
		const rtl = it.kind === "rtl";
		const alt = rtl ? 0 : (it.kind === "land" ? 0 : it.alt ?? 0);
		return {
			type: "SimpleItem",
			command: CMD[it.kind],
			frame: rtl ? FRAME_MISSION : FRAME_RELATIVE,
			params: itemParams(it),
			autoContinue: true,
			doJumpId: i + 1,
			...(rtl ? {} : { Altitude: alt, AltitudeMode: QGC_ALT_MODE_RELATIVE, AMSLAltAboveTerrain: null }),
		};
	});

	// Fence: consecutive same-kind polygon vertices are one polygon (the same
	// grouping gs and PX4 use); circles are single items.
	const polygons: QgcPlan["geoFence"]["polygons"] = [];
	const circles: QgcPlan["geoFence"]["circles"] = [];
	let run: FenceItem[] = [];
	const flush = () => {
		if (run.length) polygons.push({
			inclusion: run[0].kind === "fence_inclusion",
			polygon: run.map((v) => [v.lat, v.lon] as [number, number]),
			version: 1,
		});
		run = [];
	};
	for (const f of plan.fence) {
		if (f.kind === "fence_inclusion" || f.kind === "fence_exclusion") {
			if (run.length && run[0].kind !== f.kind) flush();
			run.push(f);
		} else {
			flush();
			circles.push({
				inclusion: f.kind === "fence_circle_inclusion",
				circle: { center: [f.lat, f.lon], radius: f.params?.radius ?? 0 },
				version: 1,
			});
		}
	}
	flush();

	return {
		fileType: "Plan",
		version: 1,
		groundStation: "Commandant",
		mission: {
			version: 2,
			firmwareType: PX4_FIRMWARE,
			vehicleType: FIXED_WING,
			cruiseSpeed: opts.cruiseSpeed ?? 15,
			hoverSpeed: 5,
			globalPlanAltitudeMode: QGC_ALT_MODE_RELATIVE,
			plannedHomePosition: home,
			items,
		},
		geoFence: { version: 2, polygons, circles },
		rallyPoints: { version: 2, points: plan.rally.map((r) => [r.lat, r.lon, r.alt ?? 0]) },
	};
}

/**
 * The plannedHomePosition to write. The console is not sent PX4's home position,
 * only the aircraft's, and those agree only while it is PARKED at home (within
 * `PARKED_M` of home's height) — mid-flight the aircraft is wherever it is. So:
 * the parked aircraft; else the first positioned item (a takeoff sits at the
 * runway); else 0,0. Elevation is home's (alt - relativeAlt) when known, else 0 —
 * QGC requires a number, and the items' above-home altitudes do not depend on it.
 */
export const PARKED_M = 2;
export function plannedHome(
	vehicle: { lat?: number; lon?: number; homeAltM?: number | null; relativeAlt?: number } | null,
	mission: MissionItem[]): [number, number, number] {
	const alt = finite(vehicle?.homeAltM) ? vehicle!.homeAltM! : 0;
	const parked = finite(vehicle?.relativeAlt) && Math.abs(vehicle!.relativeAlt!) < PARKED_M;
	if (parked && finite(vehicle?.lat) && finite(vehicle?.lon)
		&& (Math.abs(vehicle!.lat!) > 1e-4 || Math.abs(vehicle!.lon!) > 1e-4))
		return [vehicle!.lat!, vehicle!.lon!, alt];
	const first = mission.find((m) => finite(m.lat) && finite(m.lon) && (m.lat !== 0 || m.lon !== 0));
	return first ? [first.lat!, first.lon!, alt] : [0, 0, alt];
}

// ── file -> console ──────────────────────────────────────────────────────────

/** Parse a `.plan`, or explain why the console cannot load it. Never partial. */
export function fromPlan(text: string): { plan: Plan; home: [number, number, number] } | { error: string } {
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: "not JSON — a .plan is a QGroundControl JSON file" };
	}
	if (!raw || raw.fileType !== "Plan") return { error: "not a QGroundControl plan (fileType is not \"Plan\")" };
	const m = raw.mission;
	if (!m || !Array.isArray(m.items)) return { error: "the plan has no mission" };
	if (m.firmwareType !== undefined && m.firmwareType !== PX4_FIRMWARE)
		return { error: `firmwareType ${m.firmwareType} is not PX4 (${PX4_FIRMWARE}) — this plan was made for another autopilot` };
	const home = m.plannedHomePosition;
	if (!Array.isArray(home) || home.length !== 3 || !home.every(finite))
		return { error: "plannedHomePosition must be [lat, lon, alt]" };

	const mission: MissionItem[] = [];
	for (let i = 0; i < m.items.length; i++) {
		const it = m.items[i];
		const where = `mission item ${i + 1}`;
		if (it?.type !== "SimpleItem")
			return { error: `${where}: ${it?.complexItemType ?? it?.type ?? "unknown"} items are not supported here — only simple items (no surveys or corridor scans)` };
		const kind = KIND[it.command];
		if (!kind) return { error: `${where}: MAV_CMD ${it.command} is not a command this console authors` };
		if (!Array.isArray(it.params) || it.params.length !== 7)
			return { error: `${where}: expected 7 params` };
		const p = it.params.map((v: number | null) => (v === null ? NaN : v));
		let alt = p[6];
		if (kind !== "rtl") {
			if (it.frame === FRAME_GLOBAL) alt = p[6] - home[2];     // AMSL -> above home
			else if (it.frame !== FRAME_RELATIVE && it.frame !== FRAME_RELATIVE_INT)
				return { error: `${where}: frame ${it.frame} is not supported (terrain-relative legs cannot be shown above home)` };
		}
		const out: MissionItem = { seq: i, kind };
		if (kind !== "rtl") {
			out.lat = p[4]; out.lon = p[5];
			if (kind !== "land") out.alt = alt;
		}
		const params: Record<string, number> = {};
		const put = (k: string, v: number) => { if (finite(v) && v !== 0) params[k] = v; };
		if (kind === "takeoff") put("pitch", p[0]);
		if (kind === "waypoint") put("acceptRadius", p[1]);
		if (kind === "loiter_unlim" || kind === "loiter_time" || kind === "loiter_turns") put("radius", p[2]);
		if (kind === "loiter_time") put("seconds", p[0]);
		if (kind === "loiter_turns") put("turns", p[0]);
		if (Object.keys(params).length) out.params = params;
		mission.push(out);
	}

	const fence: FenceItem[] = [];
	for (const poly of raw.geoFence?.polygons ?? []) {
		const kind = poly.inclusion ? "fence_inclusion" : "fence_exclusion";
		for (const [lat, lon] of poly.polygon ?? []) fence.push({ seq: fence.length, kind, lat, lon });
	}
	for (const c of raw.geoFence?.circles ?? []) {
		const kind = c.inclusion ? "fence_circle_inclusion" : "fence_circle_exclusion";
		const [lat, lon] = c.circle?.center ?? [];
		if (!finite(lat) || !finite(lon) || !finite(c.circle?.radius))
			return { error: "a geofence circle needs a centre and a radius" };
		fence.push({ seq: fence.length, kind, lat, lon, params: { radius: c.circle.radius } });
	}
	const rally: RallyItem[] = (raw.rallyPoints?.points ?? []).map(
		(pt: number[], i: number) => ({ seq: i, kind: "rally" as const, lat: pt[0], lon: pt[1], alt: pt[2] }));

	return { plan: { mission, fence, rally }, home: home as [number, number, number] };
}

/** `<label or "mission">-<YYYYMMDD-HHMM>.plan` */
export function planFilename(now: Date = new Date(), label = "mission"): string {
	const z = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${z(now.getMonth() + 1)}${z(now.getDate())}-${z(now.getHours())}${z(now.getMinutes())}`;
	return `${label.replace(/[^\w.-]+/g, "_")}-${stamp}.plan`;
}
