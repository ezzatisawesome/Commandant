"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";
import { ChevronUp, ChevronDown } from "lucide-react";

import { $aircraftStore, $historyStore } from "@/stores/aircraft.store";
import { Sparkline } from "./Sparkline";
import { ControlBar } from "./ControlBar";
import { AttitudeIndicator } from "./AttitudeIndicator";
import { Compass } from "./Compass";

function Field({
	label,
	value,
	unit,
	spark,
	sparkClassName,
	graphic,
}: {
	label: string;
	value: string;
	unit?: string;
	spark?: Array<number | undefined>;
	sparkClassName?: string;
	graphic?: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-[10px] uppercase tracking-wide text-white/50">{label}</span>
			<div className="flex items-center gap-2">
				{graphic ?? (spark ? <Sparkline values={spark} className={sparkClassName} /> : null)}
				<span className="min-w-[3.5rem] text-right font-mono text-sm text-white">
					{value}
					{unit ? <span className="ml-0.5 text-[10px] text-white/50">{unit}</span> : null}
				</span>
			</div>
		</div>
	);
}

const fmt = (v: number | undefined, digits = 1) =>
	v === undefined ? "—" : v.toFixed(digits);

export default function FlightHUD() {
	const f = useStore($aircraftStore);
	const history = useStore($historyStore);
	const [collapsed, setCollapsed] = useState(false);

	// Extract per-field series from the downsampled history for the sparklines.
	const series = (key: keyof (typeof history)[number]) =>
		history.map((frame) => frame[key] as number | undefined);

	const connected = f?.connected ?? false;

	return (
		<div className="w-64 rounded-md border border-white/10 bg-black/60 p-3 backdrop-blur">
			<div className={`flex items-center justify-between ${collapsed ? "" : "mb-2"}`}>
				<button
					onClick={() => setCollapsed((c) => !c)}
					className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-white/50 hover:text-white"
					title={collapsed ? "Expand telemetry" : "Collapse telemetry"}
				>
					{collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
					Telemetry
				</button>
				<span
					className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-500"}`}
					title={connected ? "MAVLink connected" : "No telemetry"}
				/>
			</div>
			{collapsed ? null : (
			<>
			<div className="mb-3 flex items-center justify-center gap-3 py-2">
				<AttitudeIndicator roll={f?.roll ?? 0} pitch={f?.pitch ?? 0} size={80} />
				<Compass heading={f?.heading ?? 0} size={80} />
			</div>
			<div className="grid gap-1">
				<Field label="Mode" value={f?.mode ?? "—"} />
				<Field label="Armed" value={f?.armed === undefined ? "—" : f.armed ? "ARMED" : "DISARMED"} />
				<Field label="Airspeed" value={fmt(f?.airspeed)} unit="m/s" spark={series("airspeed")} />
				<Field label="Altitude" value={fmt(f?.alt, 0)} unit="m" spark={series("alt")} sparkClassName="text-sky-400/80" />
				<Field label="Heading" value={fmt(f?.heading, 0)} unit="°" />
				<Field label="Throttle" value={fmt(f?.throttle, 0)} unit="%" spark={series("throttle")} sparkClassName="text-amber-400/80" />
				<Field label="Elevator" value={fmt(f?.elevator, 0)} unit="%" graphic={<ControlBar value={f?.elevator} />} />
				<Field label="Aileron" value={fmt(f?.aileron, 0)} unit="%" graphic={<ControlBar value={f?.aileron} />} />
				<Field label="Rudder" value={fmt(f?.rudder, 0)} unit="%" graphic={<ControlBar value={f?.rudder} />} />
				<Field label="Battery" value={fmt(f?.batteryRemaining, 0)} unit="%" spark={series("batteryRemaining")} sparkClassName="text-emerald-400/80" />
				<Field label="Voltage" value={fmt(f?.voltage, 2)} unit="V" spark={series("voltage")} sparkClassName="text-violet-400/80" />
				<Field label="Net Current" value={fmt(f?.current, 1)} unit="A" spark={series("current")} sparkClassName="text-rose-400/80" />
			</div>
			{/* Power balance: solar generation vs. total load, why the net pack
			    current is what it is. Only present on the sim's JSON telemetry path. */}
			<div className="mt-2 border-t border-white/10 pt-2 text-[10px] uppercase tracking-wide text-white/40">
				Power · Solar
			</div>
			<div className="mt-1 grid gap-1">
				<Field label="Solar Gen" value={fmt(f?.genW, 0)} unit="W" spark={series("genW")} sparkClassName="text-yellow-400/80" />
				<Field label="Load" value={fmt(f?.loadW, 0)} unit="W" spark={series("loadW")} sparkClassName="text-orange-400/80" />
				<Field label="Motor" value={fmt(f?.motorCurrent, 1)} unit="A" spark={series("motorCurrent")} sparkClassName="text-rose-400/80" />
				<Field label="Irradiance" value={fmt(f?.irradiance, 0)} unit="W/m²" spark={series("irradiance")} sparkClassName="text-yellow-300/80" />
			</div>
			</>
			)}
		</div>
	);
}
