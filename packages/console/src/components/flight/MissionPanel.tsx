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
import { $linkState, $commander } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import { Button } from "@/components/ui/button";
import { radiusParamKey } from "@/lib/grabbers";
import { $params } from "@/stores/params.store";
import { TKO_LAND_REQ_PARAM, missionRejectionReason } from "@/lib/missionCheck";
import type { MissionKind } from "@/types/app";

const KINDS: MissionKind[] = [
	"takeoff", "waypoint", "loiter_unlim", "loiter_time", "loiter_turns", "rtl", "land",
];

// Which extra param each kind exposes in the table (beyond lat/lon/alt). The
// radius column mirrors exactly what the globe's radial grabber edits, so the
// number and the ring are always the same quantity.
function extraParam(kind: MissionKind): { key: string; label: string } | null {
	if (kind === "loiter_time") return { key: "seconds", label: "s" };
	if (kind === "loiter_turns") return { key: "turns", label: "turns" };
	const radius = radiusParamKey(kind);
	if (radius) return { key: radius, label: "r(m)" };
	return null;
}

/**
 * Why Upload cannot be attempted right now, or null when it can.
 *
 * Pulled out as a pure function because a disabled button with no explanation is
 * indistinguishable from a broken one — which is how this panel read when gs
 * silently refused every upload from a non-commander. Each case names the thing
 * the operator has to change.
 */
export function uploadBlockedReason(
	opts: { live: boolean; commander: boolean | null; count: number },
): string | null {
	if (opts.count === 0) return "nothing to upload — add waypoints first";
	if (!opts.live) return "no link to the vehicle";
	// null = an older gs that never answered the claim; treat it optimistically
	// and let the ack be the authority, as the rest of the UI does.
	if (opts.commander === false) return "another console holds command";
	return null;
}

// Phase-4 mission planner: author a route (globe clicks in edit mode, or the table
// here), upload it to PX4, read the active one back, and watch execution. Upload is
// the MISSION_COUNT/REQUEST/ITEM/ACK handshake handled in gs; this just sends the
// item list and surfaces the ack. Re-uploading mid-flight is just another upload.
//
// The panel lives in the dock, which owns opening and closing it, so it draws its
// contents directly. It used to carry its own show/hide button — a leftover from
// the right-hand rail it predates — which meant reaching the mission table took
// two clicks and the first one looked like it had done nothing.
export default function MissionPanel() {
	const items = useStore($missionItems);
	const current = useStore($missionCurrent);
	const progress = useStore($missionProgress);
	const edit = useStore($missionEdit);
	const linkState = useStore($linkState);
	const commander = useStore($commander);
	const live = linkState === "alive";

	const params = useStore($params);
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	const blocked = uploadBlockedReason({ live, commander, count: items.length });
	// Will PX4 actually fly this once uploaded? It validates at the mode change,
	// not the upload, so without this the operator gets a green tick here and a
	// silent refusal later. Quiet until the param list has been downloaded.
	const wontRun = missionRejectionReason(items, params[TKO_LAND_REQ_PARAM]?.value);

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

	// Ask gs for authority again. gs grants it to the first claimer and holds it
	// until that socket drops, so a second tab (or a reload that raced the old
	// socket) leaves this client unable to upload with no way out but hunting
	// down the other window.
	async function takeCommand() {
		setStatus(null);
		try {
			const ok = await telemetryClient.takeCommand();
			setStatus({ ok, text: ok ? "command taken" : "another console still holds command" });
		} catch (err) {
			setStatus({ ok: false, text: err instanceof Error ? err.message : "failed" });
		}
	}

	return (
		<div className="flex max-h-[70vh] w-[30rem] max-w-[calc(100vw-5rem)] flex-col">
			<div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
				<span className="text-xs font-semibold text-white">
					Mission{items.length ? ` (${items.length})` : ""}
				</span>
				<div className="flex items-center gap-2">
					<Button size="sm" variant={edit ? "default" : "outline"}
						onClick={() => $missionEdit.set(!edit)} className="h-6 px-2 text-[10px]"
						title="Click the globe to add waypoints; drag ▲ to set altitude and the ring to set radius">
						{edit ? "Editing map" : "Edit map"}
					</Button>
					<Button size="sm" variant="outline" disabled={!live || busy}
						onClick={() => telemetryClient.pullMission()} className="h-6 px-2 text-[10px]">
						Download
					</Button>
					<Button size="sm" variant="outline" disabled={blocked !== null || busy}
						onClick={upload} className="h-6 px-2 text-[10px]"
						title={blocked ?? "Upload this plan to the vehicle"}>
						{busy ? "Uploading…" : "Upload"}
					</Button>
				</div>
			</div>

			{/* Why Upload is greyed out, and what to do about it. A disabled control
			    that explains nothing is the hardest kind of bug to report. */}
			{blocked ? (
				<div className="flex items-center justify-between gap-2 pt-2 text-[10px] text-amber-300/80">
					<span>{blocked}</span>
					{commander === false ? (
						<Button size="sm" variant="outline" onClick={takeCommand}
							className="h-5 shrink-0 px-2 text-[9px]"
							title="Ask gs to hand command authority to this console">
							Take command
						</Button>
					) : null}
				</div>
			) : null}

			{/* PX4 will take this plan and then decline to fly it. Said here,
			    before the upload, rather than left to a STATUSTEXT line that
			    scrolls past at the moment the mode change is refused. */}
			{wontRun ? (
				<div className="pt-2 text-[10px] leading-relaxed text-amber-300/80">
					⚠ {wontRun}
				</div>
			) : null}

			{/* The check above can only speak once the parameter list has been
			    read, and nothing otherwise gives the operator a reason to read it.
			    So when a plan exists and PX4's requirement is still unknown, say
			    so and offer the download, rather than staying silent and letting
			    the mode change fail later for an unexplained reason. */}
			{!wontRun && items.length > 0 && params[TKO_LAND_REQ_PARAM] === undefined ? (
				<div className="flex items-center justify-between gap-2 pt-2 text-[9px] text-white/40">
					<span>
						Whether PX4 requires a takeoff or landing item in a plan is
						unknown until its parameters are read.
					</span>
					<Button size="sm" variant="outline"
						onClick={() => telemetryClient.refreshParams()}
						disabled={!live}
						className="h-5 shrink-0 px-2 text-[9px]"
						title="Download PX4's parameters so the plan can be checked against them">
						Check
					</Button>
				</div>
			) : null}

			{/* Upload/download progress. */}
			{progress ? (
				<div className="pt-2">
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
				<div className={`pt-2 text-[10px] ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
					{status.ok ? "✓" : "✗"} {status.text}
				</div>
			) : null}

			{edit ? (
				<div className="pt-2 text-[9px] leading-relaxed text-white/40">
					Click the globe to add a waypoint. Drag the marker to move it, the
					▲ above it to set altitude, and the ring to set its radius.
				</div>
			) : null}

			<div className="mt-2 overflow-auto font-mono text-[11px]">
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
										title="alt (m) — or drag the ▲ handle on the globe"
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
				<div className="flex items-center justify-between border-t border-white/10 pt-1.5">
					<span className="text-[9px] text-white/40">
						{current !== null ? `flying item ${current}` : "not flying this plan"}
					</span>
					<Button size="sm" variant="ghost" onClick={() => clearMission()} className="h-6 px-2 text-[10px] text-white/50">
						Clear
					</Button>
				</div>
			) : null}
		</div>
	);
}
