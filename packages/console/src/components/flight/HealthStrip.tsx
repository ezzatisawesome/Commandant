"use client";

import { useStore } from "@nanostores/react";

import { $hudFrame } from "@/stores/aircraft.store";

// GPS fix-type labels (GPS_RAW_INT.fix_type).
const GPS_FIX = ["NO GPS", "NO FIX", "2D", "3D", "DGPS", "RTK→", "RTK"];

function Chip({ label, ok, warn, text }: { label: string; ok?: boolean; warn?: boolean; text: string }) {
	// Green = healthy, amber = warn/unknown-ish, red = bad. `ok` wins; otherwise
	// `warn` picks amber; else red.
	const color = ok ? "text-emerald-400 border-emerald-400/30"
		: warn ? "text-amber-400 border-amber-400/30"
		: "text-red-400 border-red-400/30";
	return (
		<div className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${color}`}>
			<span className="text-[9px] uppercase tracking-wide text-white/40">{label}</span>
			<span className="font-mono text-[10px]">{text}</span>
		</div>
	);
}

// Compact vehicle-health row: EKF, GPS (fix + sats), failsafe, and any battery
// warning — the at-a-glance "is it safe to fly" strip. Fields come from gs
// (SYS_STATUS / GPS_RAW_INT / EKF_STATUS_REPORT), merged into the telemetry frame.
export function HealthStrip() {
	const f = useStore($hudFrame);

	const ekfKnown = f?.ekfOk !== undefined;
	const fix = f?.gpsFix;
	const sats = f?.gpsSats;
	const fsActive = f?.failsafe === true;
	const batt = f?.batteryWarning ?? null;

	return (
		<div className="mt-2 flex flex-wrap gap-1 border-t border-white/10 pt-2">
			<Chip
				label="EKF"
				ok={f?.ekfOk === true}
				warn={!ekfKnown}
				text={ekfKnown ? (f?.ekfOk ? "OK" : "BAD") : "—"}
			/>
			<Chip
				label="GPS"
				ok={typeof fix === "number" && fix >= 3}
				warn={typeof fix !== "number" || (fix >= 2 && fix < 3)}
				text={typeof fix !== "number" ? "—" : `${GPS_FIX[fix] ?? fix}${typeof sats === "number" ? ` ${sats}` : ""}`}
			/>
			<Chip label="FS" ok={f?.failsafe === false} warn={f?.failsafe === undefined} text={fsActive ? "ACTIVE" : f?.failsafe === undefined ? "—" : "clear"} />
			{batt ? <Chip label="BATT" ok={false} text={batt} /> : null}
		</div>
	);
}
