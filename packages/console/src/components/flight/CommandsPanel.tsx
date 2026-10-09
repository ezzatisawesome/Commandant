"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import { $linkState, $commander } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import { pushStatus } from "@/stores/statustext.store";
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
	const [streamBusy, setStreamBusy] = useState(false);
	const [streamStatus, setStreamStatus] = useState<{ ok: boolean; text: string } | null>(null);

	// A rate change is a command now, so it can be refused — by PX4, or by gs
	// when another GCS holds authority. Same gate as the verbs above it.
	const live = linkState === "alive" && commander !== false;

	async function applyStream() {
		const label = STREAMS.find((s) => s.id === streamId)?.label ?? `msg ${streamId}`;
		const asked = streamHz > 0 ? `${streamHz} Hz` : "off";
		setStreamBusy(true);
		setStreamStatus(null);
		try {
			const ack = await telemetryClient.setStream(streamId, streamHz);
			const text = ack.text || (ack.ok ? "accepted" : "rejected");
			setStreamStatus({ ok: ack.ok, text });
			// Into the log, beside the autopilot's own words: a rate change is
			// something you want to find later when the strip looks wrong, and
			// severity carries whether it took (6 = info, 4 = warning).
			pushStatus(ack.ok ? 6 : 4, `stream ${label} → ${asked}: ${text}`);
		} catch (err) {
			const text = err instanceof Error ? err.message : "failed";
			setStreamStatus({ ok: false, text });
			pushStatus(4, `stream ${label} → ${asked}: ${text}`);
		} finally {
			setStreamBusy(false);
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
								disabled={!live || streamBusy}
								className="h-6 rounded border border-white/15 px-2 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-30"
								title="Ask PX4 for this rate; the result is reported below and in the log"
							>
								{streamBusy ? "…" : "Apply"}
							</button>
						</div>

						{/* What the autopilot said, not what we asked for. */}
						{streamStatus ? (
							<div
								className={`mt-1 truncate text-[10px] ${streamStatus.ok ? "text-emerald-400" : "text-red-400"}`}
								title={streamStatus.text}
							>
								{streamStatus.ok ? "✓" : "✗"} {streamStatus.text}
							</div>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}
