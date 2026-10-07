"use client";

import { useStore } from "@nanostores/react";

import { $derived } from "@/stores/derived.store";
import type { ClearanceBand } from "@/lib/flightGeometry";

// The four derived readouts, in the rail next to the raw telemetry: terrain
// clearance, wind, sun, and geofence proximity. These are the numbers an
// operator makes a decision from, and none of them are on the MAVLink wire —
// they are computed in stores/derived.store.ts from what is.
//
// Deliberately NOT charts. Trends live in Guppi; this panel answers "what is my
// situation right now".

const CLEARANCE_STYLE: Record<ClearanceBand, string> = {
	critical: "text-red-400",
	low: "text-amber-400",
	ok: "text-emerald-400",
	unknown: "text-white/40",
};

const M_TO_FT = 3.28084;

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
	return (
		<div className="flex items-center justify-between gap-2" title={title}>
			<span className="text-[10px] uppercase tracking-wide text-white/50">{label}</span>
			<span className="font-mono text-sm text-white">{children}</span>
		</div>
	);
}

/** Compass point for a bearing, which reads faster than three digits. */
function compass(deg: number): string {
	const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
		"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
	return pts[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function FlightState() {
	const d = useStore($derived);

	return (
		<div className="mt-2 border-t border-white/10 pt-2">
			<div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Situation</div>
			<div className="grid gap-1">
				{/* Terrain clearance. MAVLink gives MSL only, so holding "400 ft AGL"
				    over an 111 m hill otherwise means doing arithmetic mid-flight. */}
				<Row label="AGL" title={d.terrainM !== null
					? `terrain ${d.terrainM.toFixed(0)} m MSL`
					: "waiting for terrain tiles under the aircraft"}>
					<span className={CLEARANCE_STYLE[d.clearance]}>
						{d.aglM === null ? "—" : `${(d.aglM * M_TO_FT).toFixed(0)} ft`}
					</span>
					{d.aglM !== null && (
						<span className="ml-1 text-[10px] text-white/40">{d.aglM.toFixed(0)} m</span>
					)}
				</Row>

				{/* Wind, solved from the airspeed/groundspeed and heading/track pair. */}
				<Row label="Wind" title={d.wind
					? `from ${d.wind.fromDeg.toFixed(0)}°, drift ${d.wind.driftDeg.toFixed(0)}°`
					: "needs airspeed, groundspeed and two fixes"}>
					{d.wind === null ? "—" : (
						<>
							{d.wind.speedMps.toFixed(1)}
							<span className="ml-0.5 text-[10px] text-white/50">m/s</span>
							<span className="ml-1 text-white/70">{compass(d.wind.fromDeg)}</span>
						</>
					)}
				</Row>

				{/* Drift is the part that matters when holding an orbit. */}
				{d.wind && Math.abs(d.wind.driftDeg) >= 1 ? (
					<Row label="Drift" title="track minus heading; positive = pushed right">
						<span className={Math.abs(d.wind.driftDeg) > 20 ? "text-amber-400" : ""}>
							{d.wind.driftDeg > 0 ? "+" : ""}{d.wind.driftDeg.toFixed(0)}°
						</span>
					</Row>
				) : null}

				{/* Sun geometry: for a solar aircraft this is a navigation input. */}
				<Row label="Sun" title={d.sun
					? `azimuth ${d.sun.azimuthDeg.toFixed(0)}°, elevation ${d.sun.elevationDeg.toFixed(1)}°`
					: "needs the sim's time-of-day clock"}>
					{d.sun === null ? "—" : d.sun.elevationDeg < 0 ? (
						<span className="text-sky-300/60">night</span>
					) : (
						<>
							{d.sun.elevationDeg.toFixed(0)}°
							<span className="ml-1 text-white/70">{compass(d.sun.azimuthDeg)}</span>
						</>
					)}
				</Row>

				{/* Fence proximity. The fence is drawn on the globe but says nothing
				    numeric, so 50 m and 500 m look identical. */}
				{d.fence ? (
					<Row label="Fence" title={`${d.fence.kind}${d.fence.violated ? " — BREACHED" : ""}`}>
						<span className={d.fence.violated ? "text-red-400"
							: d.fence.distanceM < 100 ? "text-amber-400" : "text-emerald-400"}>
							{d.fence.violated ? "OUT " : ""}{d.fence.distanceM.toFixed(0)}
						</span>
						<span className="ml-0.5 text-[10px] text-white/50">m</span>
					</Row>
				) : null}
			</div>
		</div>
	);
}
