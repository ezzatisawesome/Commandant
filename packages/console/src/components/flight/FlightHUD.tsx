"use client";

import { memo, useMemo, useState } from "react";
import { useStore } from "@nanostores/react";
import { ChevronUp, ChevronDown, Settings, ArrowUp, ArrowDown } from "lucide-react";

import { $hudFrame, $historyStore, isNum } from "@/stores/aircraft.store";
import { $linkState } from "@/stores/link.store";
import {
	$visibleFields, $chartedFields, FIELD_CATALOG, FIELD_BY_KEY,
	toggleVisible, toggleCharted, moveField,
} from "@/stores/displayConfig.store";
import type { FieldDef } from "@/stores/displayConfig.store";
import type { LinkState, TelemetryFrame } from "@/types/app";
import { telemetryClient } from "@/services/telemetry";
import { IS_VIEW } from "@/lib/envs";
import { Sparkline } from "./Sparkline";
import { ControlBar } from "./ControlBar";
import { AttitudeIndicator } from "./AttitudeIndicator";
import { Compass } from "./Compass";
import { CommandBar } from "./CommandBar";
import { HealthStrip } from "./HealthStrip";

// Connection-indicator styling per link state: amber pulse while connecting,
// green alive, amber stale, red lost.
const LINK_DOT: Record<LinkState, { className: string; title: string }> = {
	connecting: { className: "bg-amber-400 animate-pulse", title: "Connecting…" },
	alive: { className: "bg-emerald-400", title: "MAVLink alive" },
	stale: { className: "bg-amber-400", title: "Link stale — no recent telemetry" },
	lost: { className: "bg-red-500", title: "Link lost" },
};

// Stream-control presets (Phase 5): common PX4 messages the operator can turn on
// /off and re-rate from the UI.
const STREAMS: Array<{ id: number; label: string }> = [
	{ id: 30, label: "ATTITUDE" },
	{ id: 33, label: "GLOBAL_POSITION_INT" },
	{ id: 74, label: "VFR_HUD" },
	{ id: 87, label: "POSITION_TARGET" },
	{ id: 147, label: "BATTERY_STATUS" },
	{ id: 375, label: "ACTUATOR_OUTPUT" },
];

// Anything that isn't a finite number renders as a dash: fields are optional and
// gs sends `null` for a non-finite float, and `null.toFixed` would take the page
// down with it.
const fmt = (v: unknown, digits = 1) => (isNum(v) ? v.toFixed(digits) : "—");

const Row = memo(function Row({
	def, raw, spark,
}: { def: FieldDef; raw: number | boolean | string | undefined; spark?: Array<number | undefined> }) {

	let value: string;
	let graphic: React.ReactNode = null;
	if (def.kind === "text") {
		value = def.key === "armed"
			? (raw === undefined ? "—" : raw ? "ARMED" : "DISARMED")
			: (raw as string | undefined) ?? "—";
	} else if (def.kind === "control") {
		value = fmt(raw, def.digits ?? 0);
		graphic = <ControlBar value={isNum(raw) ? raw : undefined} />;
	} else {
		value = fmt(raw, def.digits ?? 1);
		if (spark) graphic = <Sparkline values={spark} className={def.sparkClassName} />;
	}

	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-[10px] uppercase tracking-wide text-white/50">{def.label}</span>
			<div className="flex items-center gap-2">
				{graphic}
				<span className="min-w-[3.5rem] text-right font-mono text-sm text-white">
					{value}
					{def.unit ? <span className="ml-0.5 text-[10px] text-white/50">{def.unit}</span> : null}
				</span>
			</div>
		</div>
	);
});

export default function FlightHUD() {
	const f = useStore($hudFrame);
	const history = useStore($historyStore);
	const linkState = useStore($linkState);
	const visible = useStore($visibleFields);
	const charted = useStore($chartedFields);
	const [collapsed, setCollapsed] = useState(false);
	const [configOpen, setConfigOpen] = useState(false);
	const [streamId, setStreamId] = useState(STREAMS[0].id);
	const [streamHz, setStreamHz] = useState(10);

	// Sparkline series only change when the (4 Hz) history does, not per HUD
	// frame; memoize per charted key so each Row gets a stable array reference.
	const chartedSet = useMemo(() => new Set(charted), [charted]);
	const seriesByKey = useMemo(() => {
		const out: Partial<Record<keyof TelemetryFrame, Array<number | undefined>>> = {};
		for (const key of charted) {
			const k = key as keyof TelemetryFrame;
			out[k] = history.map((frame) => frame[k] as number | undefined);
		}
		return out;
	}, [history, charted]);

	const dot = LINK_DOT[linkState];

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
				<div className="flex items-center gap-2">
					<button
						onClick={() => setConfigOpen((c) => !c)}
						className={`${configOpen ? "text-white" : "text-white/40"} hover:text-white`}
						title="Configure display"
					>
						<Settings className="h-3.5 w-3.5" />
					</button>
					<span className={`h-2 w-2 rounded-full ${dot.className}`} title={dot.title} />
				</div>
			</div>

			{/* Phase 5 — display config: show/hide, reorder, chart-any-field, streams. */}
			{configOpen ? (
				<div className="mb-2 max-h-72 overflow-auto rounded border border-white/10 bg-black/50 p-2 text-[10px]">
					<div className="mb-1 uppercase tracking-wide text-white/40">Fields</div>
					{FIELD_CATALOG.map((def) => {
						const key = def.key as string;
						const isVisible = visible.includes(key);
						const canChart = def.kind === "num";
						return (
							<div key={key} className="flex items-center gap-1 py-0.5">
								<input type="checkbox" checked={isVisible} onChange={() => toggleVisible(key)} />
								<span className="flex-1 truncate text-white/70">{def.label}</span>
								{canChart ? (
									<button
										onClick={() => toggleCharted(key)}
										className={chartedSet.has(key) ? "text-sky-400" : "text-white/25"}
										title="Toggle chart"
									>
										chart
									</button>
								) : null}
								<button disabled={!isVisible} onClick={() => moveField(key, -1)} className="text-white/40 disabled:opacity-20" title="Up">
									<ArrowUp className="h-3 w-3" />
								</button>
								<button disabled={!isVisible} onClick={() => moveField(key, 1)} className="text-white/40 disabled:opacity-20" title="Down">
									<ArrowDown className="h-3 w-3" />
								</button>
							</div>
						);
					})}
					{IS_VIEW ? null : <>
					<div className="mt-2 mb-1 uppercase tracking-wide text-white/40">Stream control</div>
					<div className="flex items-center gap-1">
						<select
							value={streamId}
							onChange={(e) => setStreamId(Number(e.target.value))}
							className="h-6 flex-1 rounded border border-white/15 bg-black/60 px-1 text-[10px] text-white"
						>
							{STREAMS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
						</select>
						<input
							type="number" value={streamHz} min={0} max={100}
							onChange={(e) => setStreamHz(Number(e.target.value) || 0)}
							className="h-6 w-12 rounded border border-white/15 bg-transparent px-1 text-right text-[10px] text-white"
							title="Rate (Hz); 0 disables"
						/>
						<button
							onClick={() => telemetryClient.setStream(streamId, streamHz)}
							disabled={linkState !== "alive"}
							className="h-6 rounded border border-white/15 px-2 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-30"
						>
							Apply
						</button>
					</div>
					</>}
				</div>
			) : null}

			{collapsed ? null : (
			<>
			<div className="mb-3 flex items-center justify-center gap-3 py-2">
				<AttitudeIndicator roll={f?.roll ?? 0} pitch={f?.pitch ?? 0} size={80} />
				<Compass heading={f?.heading ?? 0} size={80} />
			</div>
			<div className="grid gap-1">
				{visible.map((key) => {
					const def = FIELD_BY_KEY[key];
					if (!def) return null;
					const spark = def.kind === "num" && chartedSet.has(key) ? seriesByKey[def.key] : undefined;
					const raw = f ? (f[def.key] as number | boolean | string | undefined) : undefined;
					return <Row key={key} def={def} raw={raw} spark={spark} />;
				})}
			</div>
			<HealthStrip />
			{/* Commanding exists only in the cockpit build. The hosted viewer has
			    no command surface at all, and its client refuses to transmit. */}
			{IS_VIEW ? null : <CommandBar />}
			</>
			)}
		</div>
	);
}
