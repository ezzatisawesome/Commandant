import type { LandedState, LinkState, TelemetryFrame } from "@/types/app";
import { GROUP_STALE_MS, groupAgeMs, isNum } from "@/lib/flightGeometry";

// Pre-arm go/no-go: everything the console already knows that an operator
// should confirm before arming, in one place.
//
// ADVISORY. PX4's own arming checks are the authority and this never blocks a
// command: it reads the same telemetry the strip shows and says which of it is
// not yet right. Its value is the items PX4 does NOT check -- whether the plan
// on the vehicle is the one on this screen, whether the parameter table was
// actually read -- and saying the rest together rather than across five chips.
//
// "unknown" is not "go". A stream that stopped, or a value never received,
// counts against the verdict exactly as a bad one would, because the question
// is "do I know it is safe", not "do I know it is unsafe".

export type CheckState = "go" | "nogo" | "unknown";

export interface PreflightCheck {
	key: string;
	label: string;
	state: CheckState;
	detail: string;
}

export interface PreflightInput {
	frame: TelemetryFrame | null;
	linkState: LinkState;
	/** Parameters cached from this vehicle, and whether a read is in flight or stale. */
	paramCount: number;
	paramsReading: boolean;
	paramsStale: boolean;
	/** Items in the plan on this screen, and whether it matches a read of the vehicle. */
	missionItems: number;
	missionOnVehicle: boolean;
}

export const LANDED_LABEL: Record<LandedState, string> = {
	on_ground: "GROUND", in_air: "AIR", takeoff: "TAKEOFF", landing: "LANDING",
};

/** Is a message group's last value still current? Unknown ages count as fresh:
 *  an older gs does not report them, and that is not the vehicle's fault. */
function fresh(f: TelemetryFrame, group: string): boolean {
	const age = groupAgeMs(f.ages, group);
	return !isNum(age) || age <= GROUP_STALE_MS;
}

export function preflightChecks(i: PreflightInput): PreflightCheck[] {
	const f = i.frame;
	const out: PreflightCheck[] = [];
	const add = (key: string, label: string, state: CheckState, detail: string) =>
		out.push({ key, label, state, detail });

	add("link", "Link", i.linkState === "alive" ? "go" : "nogo",
		i.linkState === "alive" ? "telemetry is live"
			: `link is ${i.linkState}: nothing below is current`);
	if (!f || i.linkState !== "alive") return out;

	// `group` null: a value with no staleness of its own. HOME_POSITION is a
	// setting PX4 re-sends rarely, not a reading; failsafe rides the HEARTBEAT,
	// which a live link is by definition receiving.
	const stream = (group: string | null, key: string, label: string,
		known: boolean, ok: boolean, goText: string, badText: string, unknownText: string) => {
		if (group !== null && !fresh(f, group)) {
			add(key, label, "unknown", `${label} stopped reporting; its last value is not current`);
		} else if (!known) {
			add(key, label, "unknown", unknownText);
		} else {
			add(key, label, ok ? "go" : "nogo", ok ? goText : badText);
		}
	};

	stream("ekf", "ekf", "EKF", f.ekfOk !== undefined, f.ekfOk === true,
		"estimator healthy", "estimator reports a fault", "no estimator status yet");
	stream("gps", "gps", "GPS", isNum(f.gpsFix), isNum(f.gpsFix) && f.gpsFix >= 3,
		`3D fix${isNum(f.gpsSats) ? `, ${f.gpsSats} satellites` : ""}`,
		"no 3D fix", "no GPS report yet");
	stream(null, "home", "Home", isNum(f.homeLat) && isNum(f.homeLon), true,
		"set: RTL returns there", "", "no home position: RTL has nowhere to return to");
	stream("health", "sensors", "Sensors", f.sysHealthy !== undefined, f.sysHealthy === true,
		"all enabled sensors healthy", "a sensor reports unhealthy", "no sensor status yet");
	stream(null, "failsafe", "Failsafe", f.failsafe !== undefined, f.failsafe === false,
		"clear", "a failsafe is active", "no failsafe status yet");
	stream("battery", "battery", "Battery",
		isNum(f.batteryRemaining) || !!f.batteryWarning, !f.batteryWarning,
		isNum(f.batteryRemaining) ? `${f.batteryRemaining.toFixed(0)} %` : "no warning",
		`battery ${f.batteryWarning}`, "no battery report yet");
	if (f.landedState !== undefined) {
		stream("landed", "landed", "On ground", true, f.landedState === "on_ground",
			"PX4 says on the ground", `PX4 says ${LANDED_LABEL[f.landedState].toLowerCase()}`, "");
	}

	if (i.paramsReading) {
		add("params", "Parameters", "unknown", "still reading the parameter table");
	} else if (i.paramCount === 0) {
		add("params", "Parameters", "unknown", "not read from this vehicle");
	} else if (i.paramsStale) {
		add("params", "Parameters", "unknown",
			"cached from before a link gap; refresh to know they are this vehicle's");
	} else {
		add("params", "Parameters", "go", `${i.paramCount} read from the vehicle`);
	}

	if (i.missionItems === 0) {
		add("mission", "Mission", "unknown", "no plan on this screen");
	} else if (i.missionOnVehicle) {
		add("mission", "Mission", "go", "the vehicle holds the plan shown here");
	} else {
		add("mission", "Mission", "nogo",
			"the plan shown here is not confirmed on the vehicle: upload it, or read the vehicle's back");
	}
	return out;
}

export interface PreflightVerdict {
	state: CheckState;
	nogo: number;
	unknown: number;
	summary: string;
}

/** One answer from many: any no-go is no-go; else any unknown is unknown. */
export function preflightVerdict(checks: PreflightCheck[]): PreflightVerdict {
	const nogo = checks.filter((c) => c.state === "nogo").length;
	const unknown = checks.filter((c) => c.state === "unknown").length;
	const state: CheckState = nogo ? "nogo" : unknown ? "unknown" : "go";
	const summary = state === "go" ? "GO"
		: nogo ? `${nogo} NO-GO${unknown ? ` · ${unknown} ?` : ""}`
		: `${unknown} unknown`;
	return { state, nogo, unknown, summary };
}

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371008.8;
	const r = Math.PI / 180;
	const dLat = (lat2 - lat1) * r;
	const dLon = (lon2 - lon1) * r;
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
