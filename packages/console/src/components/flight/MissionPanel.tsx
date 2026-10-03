"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import {
	$missionItems,
	$missionCurrent,
	$missionProgress,
	$missionEdit,
	kindHasPosition,
	removeItem,
	reorderItem,
	updateItem,
	clearMission,
} from "@/stores/mission.store";
import { $linkState } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import { Button } from "@/components/ui/button";
import type { MissionKind } from "@/types/app";

const KINDS: MissionKind[] = [
	"takeoff", "waypoint", "loiter_unlim", "loiter_time", "loiter_turns", "rtl", "land",
];

// Which extra param each kind exposes in the table (beyond lat/lon/alt).
function extraParam(kind: MissionKind): { key: string; label: string } | null {
	if (kind === "loiter_time") return { key: "seconds", label: "s" };
	if (kind === "loiter_turns") return { key: "turns", label: "turns" };
	if (kind === "loiter_unlim") return { key: "radius", label: "r(m)" };
	return null;
}

// Phase-4 mission planner: author a route (globe clicks in edit mode, or the table
// here), upload it to PX4, read the active one back, and watch execution. Upload is
// the MISSION_COUNT/REQUEST/ITEM/ACK handshake handled in gs; this just sends the
// item list and surfaces the ack. Re-uploading mid-flight is just another upload.
export default function MissionPanel() {
	const [open, setOpen] = useState(false);
	const items = useStore($missionItems);
	const current = useStore($missionCurrent);
	const progress = useStore($missionProgress);
	const edit = useStore($missionEdit);
	const linkState = useStore($linkState);
	const live = linkState === "alive";

	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	async function upload() {
		setBusy(true);
		setStatus(null);
		try {
			const ack = await telemetryClient.pushMission(items);
			setStatus({ ok: ack.ok, text: ack.text || (ack.ok ? "uploaded" : "rejected") });
		} catch (err) {
			setStatus({ ok: false, text: err instanceof Error ? err.message : "failed" });
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<Button
				onClick={() => setOpen((o) => !o)}
				variant="ghost"
				className="h-7 w-64 border border-white/10 bg-black/60 text-xs backdrop-blur"
			>
				{open ? "Hide mission" : `Mission${items.length ? ` (${items.length})` : ""}`}
			</Button>

			{open && (
				<div className="flex max-h-[80vh] w-[30rem] max-w-[calc(100vw-2rem)] flex-col rounded-md border border-white/10 bg-black/80 backdrop-blur">
					<div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
						<span className="text-xs font-semibold text-white">Mission</span>
						<div className="flex items-center gap-2">
							<Button size="sm" variant={edit ? "default" : "outline"}
								onClick={() => $missionEdit.set(!edit)} className="h-6 px-2 text-[10px]"
								title="Click the globe to add waypoints">
								{edit ? "Editing map" : "Edit map"}
							</Button>
							<Button size="sm" variant="outline" disabled={!live || busy}
								onClick={() => telemetryClient.pullMission()} className="h-6 px-2 text-[10px]">
								Download
							</Button>
							<Button size="sm" variant="outline" disabled={!live || busy || items.length === 0}
								onClick={upload} className="h-6 px-2 text-[10px]">
								{busy ? "Uploading…" : "Upload"}
							</Button>
						</div>
					</div>

					{/* Upload/download progress. */}
					{progress ? (
						<div className="px-3 pt-2">
							<div className="h-1 w-full overflow-hidden rounded bg-white/10">
								<div className="h-full bg-sky-400"
									style={{ width: `${Math.round(((progress.seq + 1) / Math.max(progress.count, 1)) * 100)}%` }} />
							</div>
							<div className="mt-0.5 text-[9px] text-white/40">
								{progress.phase} {progress.seq + 1}/{progress.count}
							</div>
						</div>
					) : null}

					{status ? (
						<div className={`px-3 pt-2 text-[10px] ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
							{status.ok ? "✓" : "✗"} {status.text}
						</div>
					) : null}

					<div className="mt-2 overflow-auto px-3 pb-3 font-mono text-[11px]">
						{items.length === 0 ? (
							<div className="py-4 text-center text-white/30">
								no items — turn on “Edit map” and click the globe, or Download
							</div>
						) : (
							items.map((it) => {
								const extra = extraParam(it.kind);
								const isCurrent = current === it.seq;
								return (
									<div key={it.seq}
										className={`flex items-center gap-1 border-b border-white/5 py-1 ${isCurrent ? "bg-yellow-400/10" : ""}`}>
										<span className="w-4 text-white/40">{it.seq}</span>
										<select
											value={it.kind}
											onChange={(e) => updateItem(it.seq, { kind: e.target.value as MissionKind })}
											className="h-6 rounded border border-white/15 bg-transparent px-1 text-white"
										>
											{KINDS.map((k) => <option key={k} value={k} className="bg-black">{k}</option>)}
										</select>
										{kindHasPosition(it.kind) ? (
											<input
												type="number"
												value={it.alt ?? 0}
												onChange={(e) => updateItem(it.seq, { alt: Number(e.target.value) })}
												className="h-6 w-14 rounded border border-white/15 bg-transparent px-1 text-right text-white"
												title="alt (m)"
											/>
										) : <span className="w-14" />}
										{extra ? (
											<input
												type="number"
												value={it.params?.[extra.key] ?? 0}
												onChange={(e) => updateItem(it.seq, { params: { ...it.params, [extra.key]: Number(e.target.value) } })}
												className="h-6 w-12 rounded border border-white/15 bg-transparent px-1 text-right text-white"
												title={extra.label}
											/>
										) : <span className="w-12" />}
										<span className="flex-1" />
										<button onClick={() => reorderItem(it.seq, -1)} className="px-1 text-white/50 hover:text-white" title="up">↑</button>
										<button onClick={() => reorderItem(it.seq, 1)} className="px-1 text-white/50 hover:text-white" title="down">↓</button>
										<button onClick={() => live && telemetryClient.setCurrentMissionItem(it.seq)}
											disabled={!live} className="px-1 text-white/50 hover:text-white disabled:opacity-30" title="set current">◎</button>
										<button onClick={() => removeItem(it.seq)} className="px-1 text-red-400/70 hover:text-red-400" title="delete">✕</button>
									</div>
								);
							})
						)}
					</div>

					{items.length > 0 ? (
						<div className="flex items-center justify-between border-t border-white/10 px-3 py-1.5">
							<span className="text-[9px] text-white/40">
								{current !== null ? `flying item ${current}` : "not flying this plan"}
							</span>
							<Button size="sm" variant="ghost" onClick={() => clearMission()} className="h-6 px-2 text-[10px] text-white/50">
								Clear
							</Button>
						</div>
					) : null}
				</div>
			)}
		</>
	);
}
