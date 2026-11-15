"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import { $hudFrame } from "@/stores/aircraft.store";
import { $linkState } from "@/stores/link.store";
import { $params, $paramProgress, $paramsStale } from "@/stores/params.store";
import { $missionItems, $vehicleMission, missionMatchesVehicle } from "@/stores/mission.store";
import { GROUP_STALE_MS, groupAgeMs, isNum } from "@/lib/flightGeometry";
import { LANDED_LABEL, distanceM, preflightChecks, preflightVerdict } from "@/lib/preflight";

// GPS fix-type labels (GPS_RAW_INT.fix_type).
const GPS_FIX = ["NO GPS", "NO FIX", "2D", "3D", "DGPS", "RTK→", "RTK"];

function Chip({ label, ok, warn, text, title }: {
	label: string; ok?: boolean; warn?: boolean; text: string; title?: string;
}) {
	// Green = healthy, amber = warn/unknown-ish, red = bad. `ok` wins; otherwise
	// `warn` picks amber; else red.
	const color = ok ? "text-emerald-400 border-emerald-400/30"
		: warn ? "text-amber-400 border-amber-400/30"
		: "text-red-400 border-red-400/30";
	return (
		<div title={title}
			className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${color}`}>
			<span className="text-[9px] uppercase tracking-wide text-white/40">{label}</span>
			<span className="font-mono text-[10px]">{text}</span>
		</div>
	);
}

// Compact vehicle-health row: EKF, GPS (fix + sats), failsafe, and any battery
// warning — the at-a-glance "is it safe to fly" strip. Fields come from gs
// (SYS_STATUS / GPS_RAW_INT / EKF_STATUS_REPORT), merged into the telemetry frame.
//
// It lives pinned to the telemetry strip rather than inside a dock panel: "is it
// safe to fly" is the one readout that must never need a click, and a click is
// exactly what a dock panel costs. Layout-neutral on purpose — no margins or
// rules of its own — so the host decides where the chips sit.
export function HealthStrip() {
	const f = useStore($hudFrame);

	// A health chip whose source has STOPPED arriving must not read as healthy.
	//
	// These come from EKF_STATUS_REPORT, GPS_RAW_INT and SYS_STATUS, on their own
	// schedules — and gs re-requests the extras after a vehicle reboot, so there
	// is a window where the frame is fresh at 25 Hz and these are not arriving at
	// all. The chips were drawn from whatever was last received, which means a
	// green "EKF OK" for an estimator that stopped reporting minutes ago, on the
	// one readout this file describes as never needing a click. Unknown is the
	// honest answer there, and it is also the useful one: it says go and look.
	const cold = (group: string): boolean => {
		const age = groupAgeMs(f?.ages, group);
		return isNum(age) && age > GROUP_STALE_MS;
	};
	const ekfCold = cold("ekf");
	const gpsCold = cold("gps");
	const healthCold = cold("health");

	const ekfKnown = f?.ekfOk !== undefined && !ekfCold;
	const fix = gpsCold ? undefined : f?.gpsFix;
	const sats = gpsCold ? undefined : f?.gpsSats;
	const fsActive = f?.failsafe === true;
	// A battery warning is a latched bad state, so a stale one still warrants
	// attention — but say that it is stale rather than presenting it as current.
	const batt = f?.batteryWarning ?? null;
	const staleTitle = (secs: number) =>
		`this stream stopped ${secs.toFixed(0)} s ago — the autopilot is not `
		+ `reporting it, so this is not a current reading`;

	return (
		<div className="flex flex-wrap items-center gap-1">
			<Chip
				label="EKF"
				ok={f?.ekfOk === true && !ekfCold}
				warn={!ekfKnown}
				text={ekfCold ? "stale" : ekfKnown ? (f?.ekfOk ? "OK" : "BAD") : "—"}
				title={ekfCold ? staleTitle(groupAgeMs(f?.ages, "ekf")! / 1000) : undefined}
			/>
			<Chip
				label="GPS"
				ok={typeof fix === "number" && fix >= 3}
				warn={typeof fix !== "number" || (fix >= 2 && fix < 3)}
				text={gpsCold ? "stale"
					: typeof fix !== "number" ? "—"
					: `${GPS_FIX[fix] ?? fix}${typeof sats === "number" ? ` ${sats}` : ""}`}
				title={gpsCold ? staleTitle(groupAgeMs(f?.ages, "gps")! / 1000) : undefined}
			/>
			<Chip label="FS" ok={f?.failsafe === false} warn={f?.failsafe === undefined} text={fsActive ? "ACTIVE" : f?.failsafe === undefined ? "—" : "clear"} />
			{f?.landedState ? (
				// PX4's own answer to "is it flying", not one guessed from altitude.
				<Chip label="STATE" ok={!cold("landed")} warn
					text={cold("landed") ? "stale" : LANDED_LABEL[f.landedState]}
					title={cold("landed") ? staleTitle(groupAgeMs(f?.ages, "landed")! / 1000)
						: "PX4's landed state (EXTENDED_SYS_STATE)"} />
			) : null}
			<HomeChip />
			{batt ? (
				<Chip label="BATT" ok={false} text={healthCold ? `${batt} (stale)` : batt}
					title={healthCold
						? staleTitle(groupAgeMs(f?.ages, "health")! / 1000)
						: undefined} />
			) : null}
			{f?.armed ? null : <PreArm />}
		</div>
	);
}

// Where RTL goes, and how far that is. Red when PX4 has none: an RTL then has
// nowhere to return to, which is worth knowing before arming, not after.
function HomeChip() {
	const f = useStore($hudFrame);
	if (!f) return null;
	const home = isNum(f.homeLat) && isNum(f.homeLon);
	const here = isNum(f.lat) && isNum(f.lon);
	const d = home && here ? distanceM(f.lat!, f.lon!, f.homeLat!, f.homeLon!) : null;
	const text = !home ? "none"
		: d === null ? "set"
		: d < 1000 ? `${d.toFixed(0)} m` : `${(d / 1000).toFixed(1)} km`;
	return (
		<Chip label="HOME" ok={home} text={text}
			title={home
				? `RTL returns to ${f.homeLat!.toFixed(6)}, ${f.homeLon!.toFixed(6)}`
					+ (isNum(f.homeAlt) ? ` (${f.homeAlt!.toFixed(0)} m MSL)` : "")
				: "PX4 has not set a home position: RTL has nowhere to return to"} />
	);
}

// Pre-arm go/no-go (lib/preflight.ts). Advisory: PX4's arming checks decide.
// Shown only while disarmed -- once armed the question has been answered.
function PreArm() {
	const [open, setOpen] = useState(false);
	const frame = useStore($hudFrame);
	const linkState = useStore($linkState);
	const params = useStore($params);
	const progress = useStore($paramProgress);
	const paramsStale = useStore($paramsStale);
	const items = useStore($missionItems);
	const vehicle = useStore($vehicleMission);
	const checks = preflightChecks({
		frame, linkState,
		paramCount: Object.keys(params).length,
		paramsReading: progress !== null,
		paramsStale,
		missionItems: items.length,
		missionOnVehicle: missionMatchesVehicle(items, vehicle),
	});
	const v = preflightVerdict(checks);
	const mark = { go: "●", nogo: "▲", unknown: "○" } as const;
	const tone = { go: "text-emerald-400", nogo: "text-red-400", unknown: "text-amber-300" } as const;
	return (
		<div className="relative">
			<button onClick={() => setOpen((o) => !o)}
				title={checks.map((c) => `${mark[c.state]} ${c.label}: ${c.detail}`).join("\n")}>
				<Chip label="PRE-ARM" ok={v.state === "go"} warn={v.state === "unknown"} text={v.summary} />
			</button>
			{open ? (
				<ul className="absolute bottom-full left-0 z-20 mb-1 w-72 space-y-0.5 rounded border
					border-white/15 bg-black/90 p-2 text-[10px] leading-snug backdrop-blur">
					{checks.map((c) => (
						<li key={c.key} className="flex gap-1.5">
							<span aria-hidden className={tone[c.state]}>{mark[c.state]}</span>
							<span className="w-16 shrink-0 text-white/60">{c.label}</span>
							<span className="text-white/80">{c.detail}</span>
						</li>
					))}
					<li className="pt-1 text-white/35">Advisory: PX4&apos;s own checks decide whether it arms.</li>
				</ul>
			) : null}
		</div>
	);
}
