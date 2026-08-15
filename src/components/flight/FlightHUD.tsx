"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";
import { Cartesian3 } from "cesium";

import { $aircraftStore, $aircraftEntityStore, $historyStore } from "@/stores/aircraft.store";
import { $viewerStore } from "@/stores/cesium.store";
import { Button } from "@/ui/button";
import { Sparkline } from "./Sparkline";
import { AttitudeIndicator } from "./AttitudeIndicator";
import { Compass } from "./Compass";

function Field({
	label,
	value,
	unit,
	spark,
	sparkClassName,
}: {
	label: string;
	value: string;
	unit?: string;
	spark?: Array<number | undefined>;
	sparkClassName?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-[10px] uppercase tracking-wide text-white/50">{label}</span>
			<div className="flex items-center gap-2">
				{spark ? <Sparkline values={spark} className={sparkClassName} /> : null}
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
	const viewer = useStore($viewerStore);
	const entity = useStore($aircraftEntityStore);
	const [following, setFollowing] = useState(false);

	// Extract per-field series from the downsampled history for the sparklines.
	const series = (key: keyof (typeof history)[number]) =>
		history.map((frame) => frame[key] as number | undefined);

	const connected = f?.connected ?? false;
	const hasFix = f?.lat !== undefined;

	const handleTrack = () => {
		if (!viewer) return;

		if (following) {
			// Release the camera.
			viewer.trackedEntity = undefined;
			setFollowing(false);
			return;
		}

		// Guaranteed move: fly the camera to the current position (no dependency on
		// the model/bounding sphere). Then attach the chase-follow via viewFrom.
		const frame = $aircraftStore.get();
		if (frame?.lat !== undefined && frame.lon !== undefined && frame.alt !== undefined) {
			viewer.camera.flyTo({
				destination: Cartesian3.fromDegrees(frame.lon, frame.lat, frame.alt + 1200),
				duration: 1.2,
				complete: () => {
					if (entity) viewer.trackedEntity = entity;
				},
			});
			setFollowing(true);
		}
	};

	return (
		<div className="w-64 rounded-md border border-white/10 bg-black/60 p-3 backdrop-blur">
			<div className="mb-2 flex items-center justify-end">
				<span
					className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-500"}`}
					title={connected ? "MAVLink connected" : "No telemetry"}
				/>
			</div>
			<div className="mb-3 flex items-center justify-center gap-4 px-2 py-2">
				<AttitudeIndicator roll={f?.roll ?? 0} pitch={f?.pitch ?? 0} />
				<Compass heading={f?.heading ?? 0} />
			</div>
			<div className="grid gap-1">
				<Field label="Mode" value={f?.mode ?? "—"} />
				<Field label="Armed" value={f?.armed === undefined ? "—" : f.armed ? "ARMED" : "DISARMED"} />
				<Field label="Airspeed" value={fmt(f?.airspeed)} unit="m/s" spark={series("airspeed")} />
				<Field label="Altitude" value={fmt(f?.alt, 0)} unit="m" spark={series("alt")} sparkClassName="text-sky-400/80" />
				<Field label="Heading" value={fmt(f?.heading, 0)} unit="°" />
				<Field label="Throttle" value={fmt(f?.throttle, 0)} unit="%" spark={series("throttle")} sparkClassName="text-amber-400/80" />
				<Field label="Battery" value={fmt(f?.batteryRemaining, 0)} unit="%" spark={series("batteryRemaining")} sparkClassName="text-emerald-400/80" />
				<Field label="Voltage" value={fmt(f?.voltage, 2)} unit="V" spark={series("voltage")} sparkClassName="text-violet-400/80" />
				<Field label="Current" value={fmt(f?.current, 1)} unit="A" spark={series("current")} sparkClassName="text-rose-400/80" />
			</div>
			<Button
				onClick={handleTrack}
				disabled={!hasFix}
				variant="ghost"
				className="mt-2 w-full text-xs h-7 border border-white/10"
			>
				{following ? "Stop following" : "Track aircraft"}
			</Button>
		</div>
	);
}
