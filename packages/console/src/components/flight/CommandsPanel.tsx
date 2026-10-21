"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import { $linkState, $commander } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import { IS_VIEW } from "@/lib/envs";
import { CommandBar } from "./CommandBar";

// The command surface: arm/disarm, mode changes, takeoff and RTL, plus the
// stream rates those commands depend on.
//
// This was "Instruments", and it held three unrelated things. The health chips
// moved to the telemetry strip, where they are always visible — a dock panel
// costs a click, and "is it safe to fly" is not a question you should have to
// click to answer. The field show/hide/reorder list is gone outright: the strip
// is edited in place now (the pencil), so that list was a second, worse editor
// for the same state, and two editors for one setting is how they drift apart.
//
// What remains is commanding, which is why the icon says so.

const STREAMS: Array<{ id: number; label: string }> = [
	{ id: 30, label: "ATTITUDE" },
	{ id: 33, label: "GLOBAL_POSITION_INT" },
	{ id: 74, label: "VFR_HUD" },
	{ id: 87, label: "POSITION_TARGET" },
	{ id: 147, label: "BATTERY_STATUS" },
	{ id: 375, label: "ACTUATOR_OUTPUT" },
];

export default function CommandsPanel() {
	const linkState = useStore($linkState);
	const commander = useStore($commander);
	const [streamId, setStreamId] = useState(STREAMS[0].id);
	const [streamHz, setStreamHz] = useState(10);
	const [streamNote, setStreamNote] = useState<{ ok: boolean; text: string } | null>(null);

	// A stream request changes what the VEHICLE sends, for everyone, out of a
	// finite link budget — so gs gates it on command authority and may clamp the
	// rate. `null` is an older gs that never answered the claim; treat it
	// optimistically and let the ack be the authority, as the rest of the UI does.
	const streamBlocked = linkState !== "alive" ? "no link to the vehicle"
		: commander === false ? "another console holds command"
		: null;

	async function applyStream() {
		setStreamNote(null);
		try {
			const ack = await telemetryClient.setStream(streamId, streamHz);
			setStreamNote({ ok: ack.ok, text: ack.text || (ack.ok ? "applied" : "refused") });
		} catch (e) {
			setStreamNote({ ok: false, text: e instanceof Error ? e.message : "failed" });
		}
	}

	return (
		<div className="w-64 text-xs text-white">
			<div className="mb-2 text-[10px] uppercase tracking-wide text-white/50">
				Commands
			</div>

			{IS_VIEW ? (
				<div className="text-[10px] text-white/40">
					Read-only view. Commanding happens on the ground-station hub.
				</div>
			) : (
				<>
					<CommandBar />

					{/* Stream rates are a command too: they decide what the strip and the
					    HUD are even able to show. */}
					<div className="mt-3 border-t border-white/10 pt-2 text-[10px]">
						<div className="mb-1 uppercase tracking-wide text-white/40">Stream control</div>
						<div className="flex items-center gap-1">
							<select
								value={streamId}
								onChange={(e) => setStreamId(Number(e.target.value))}
								className="h-6 min-w-0 flex-1 rounded border border-white/15 bg-black/60 px-1 text-[10px] text-white"
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
								onClick={applyStream}
								disabled={streamBlocked !== null}
								title={streamBlocked ?? "Ask the vehicle for this message at this rate"}
								className="h-6 rounded border border-white/15 px-2 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-30"
							>
								Apply
							</button>
						</div>
						{streamBlocked ? (
							<div className="pt-1 text-[9px] text-amber-300/80">{streamBlocked}</div>
						) : null}
						{streamNote ? (
							<div className={`pt-1 text-[9px] ${streamNote.ok ? "text-emerald-400" : "text-red-400"}`}>
								{streamNote.ok ? "✓" : "✗"} {streamNote.text}
							</div>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}
