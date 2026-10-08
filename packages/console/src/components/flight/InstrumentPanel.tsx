"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";
import { ArrowUp, ArrowDown } from "lucide-react";

import { $linkState } from "@/stores/link.store";
import {
	$visibleFields, $chartedFields, FIELD_CATALOG,
	toggleVisible, toggleCharted, moveField,
} from "@/stores/displayConfig.store";
import { telemetryClient } from "@/services/telemetry";
import { IS_VIEW } from "@/lib/envs";
import { CommandBar } from "./CommandBar";
import { HealthStrip } from "./HealthStrip";

// Vehicle health, the command surface, and the configuration for the bottom
// strip. Popover content for the dock, so it owns no position and no chrome.
//
// A side panel competes with the map for the widest part of the screen, and the
// map IS the instrument. So numeric telemetry lives along the bottom edge
// (TelemetryStrip), attitude and heading stay bare on the globe
// (HeadsUpInstruments), and everything here is one click away rather than always
// in the way.

const STREAMS: Array<{ id: number; label: string }> = [
	{ id: 30, label: "ATTITUDE" },
	{ id: 33, label: "GLOBAL_POSITION_INT" },
	{ id: 74, label: "VFR_HUD" },
	{ id: 87, label: "POSITION_TARGET" },
	{ id: 147, label: "BATTERY_STATUS" },
	{ id: 375, label: "ACTUATOR_OUTPUT" },
];

export default function InstrumentPanel() {
	const linkState = useStore($linkState);
	const visible = useStore($visibleFields);
	const charted = useStore($chartedFields);
	const [configOpen, setConfigOpen] = useState(false);
	const [streamId, setStreamId] = useState(STREAMS[0].id);
	const [streamHz, setStreamHz] = useState(10);

	const chartedSet = new Set(charted);

	return (
		<div className="w-64 text-xs text-white">
			<div className="mb-2 flex items-center justify-between">
				<span className="text-[10px] uppercase tracking-wide text-white/50">Instruments</span>
				<button
					onClick={() => setConfigOpen((c) => !c)}
					className={`${configOpen ? "text-white" : "text-white/40"} text-[10px] uppercase tracking-wide hover:text-white`}
					title="Choose which fields show in the bottom strip"
				>
					Fields
				</button>
			</div>

			{/* Field selection drives the bottom strip, not this panel. */}
			{configOpen ? (
				<div className="mb-2 max-h-72 overflow-auto rounded border border-white/10 bg-black/50 p-2 text-[10px]">
					<div className="mb-1 uppercase tracking-wide text-white/40">
						Strip fields
					</div>
					{FIELD_CATALOG.map((def) => {
						const key = def.key as string;
						const isVisible = visible.includes(key);
						return (
							<div key={key} className="flex items-center gap-1 py-0.5">
								<input type="checkbox" checked={isVisible} onChange={() => toggleVisible(key)} />
								<span className="flex-1 truncate text-white/70">{def.label}</span>
								{def.kind === "num" ? (
									<button
										onClick={() => toggleCharted(key)}
										className={chartedSet.has(key) ? "text-sky-400" : "text-white/25"}
										title="Toggle sparkline"
									>
										chart
									</button>
								) : null}
								<button disabled={!isVisible} onClick={() => moveField(key, -1)} className="text-white/40 disabled:opacity-20" title="Left">
									<ArrowUp className="h-3 w-3" />
								</button>
								<button disabled={!isVisible} onClick={() => moveField(key, 1)} className="text-white/40 disabled:opacity-20" title="Right">
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

			<HealthStrip />
			{IS_VIEW ? null : <CommandBar />}
		</div>
	);
}
