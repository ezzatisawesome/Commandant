"use client";

import { useRef, useState } from "react";
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
	setMissionItems,
} from "@/stores/mission.store";
import { $fenceItems, $rallyItems,
	setFenceItems, setPlacingTarget, setRallyItems,
} from "@/stores/geo.store";
import { $aircraftStore } from "@/stores/aircraft.store";
import { homeAltM } from "@/lib/altFrames";
import { fromPlan, planFilename, plannedHome, toPlan } from "@/lib/planFile";
import { $planRead, $vehicleMission, missionMatchesVehicle } from "@/stores/mission.store";
import { $linkState, $commander } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import { Button } from "@/components/ui/button";
import { radiusParamKey } from "@/lib/grabbers";
import { $params } from "@/stores/params.store";
import { TKO_LAND_REQ_PARAM, blockersForSeq, lookupFrom, missionBlockers } from "@/lib/missionCheck";
import { MissionReadiness, RowFlag } from "@/components/flight/MissionReadiness";
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
	// silent refusal later. Returns structured findings, so the chip can be two
	// words, the offending row can carry a flag, and the globe can draw the
	// constraint — rather than all three being one paragraph of amber text.
	const planRead = useStore($planRead);
	const vehicleMission = useStore($vehicleMission);
	// Does the draft still describe what the aircraft is flying? Recomputed from
	// both stores so a drag or a reorder updates it immediately.
	const matches = missionMatchesVehicle(items, vehicleMission);
	const fence = useStore($fenceItems);
	const blockers = missionBlockers(items, lookupFrom(params), fence);
	// Whether the takeoff/landing rule could be checked at all. Unread is not
	// the same as "no rule", and the chip must not say "ready" for it.
	const ruleKnown = lookupFrom(params)(TKO_LAND_REQ_PARAM) !== undefined;

	// .plan files (PX4 / QGroundControl's mission format): the plan as a file that
	// QGC, a real aircraft and AircraftSim all read. See lib/planFile.ts.
	const planRef = useRef<HTMLInputElement>(null);
	const rally = useStore($rallyItems);
	function savePlan() {
		const f = $aircraftStore.get();
		const home = plannedHome(f ? { lat: f.lat, lon: f.lon, homeAltM: homeAltM(f), relativeAlt: f.relativeAlt } : null, items);
		const q = toPlan({ mission: items, fence, rally }, home);
		const blob = new Blob([JSON.stringify(q, null, 4)], { type: "application/json" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = planFilename();
		a.click();
		URL.revokeObjectURL(a.href);
	}
	async function openPlan(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		e.target.value = "";                         // so the same file can be re-picked
		if (!file) return;
		const r = fromPlan(await file.text());
		if ("error" in r) {
			setStatus({ ok: false, text: `${file.name}: ${r.error}` });
			return;
		}
		setMissionItems(r.plan.mission);
		setFenceItems(r.plan.fence);
		setRallyItems(r.plan.rally);
		setStatus({ ok: true, text: `opened ${file.name}: ${r.plan.mission.length} items` +
			(r.plan.fence.length ? `, ${r.plan.fence.length} fence` : "") +
			(r.plan.rally.length ? `, ${r.plan.rally.length} rally` : "") + " (not uploaded)" });
	}

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
						onClick={() => setPlacingTarget(edit ? null : "mission")} className="h-6 px-2 text-[10px]"
						title="Click the globe to add waypoints; drag ▲ to set altitude and the ring to set radius">
						{edit ? "Editing map" : "Edit map"}
					</Button>
					<Button size="sm" variant="outline" onClick={() => planRef.current?.click()}
						className="h-6 px-2 text-[10px]" title="Open a PX4 / QGroundControl .plan file into the draft">
						Open
					</Button>
					<Button size="sm" variant="outline" disabled={items.length === 0} onClick={savePlan}
						className="h-6 px-2 text-[10px]" title="Save the draft (mission, fence, rally) as a PX4 / QGroundControl .plan">
						Save
					</Button>
					<input ref={planRef} type="file" accept=".plan,application/json" className="hidden" onChange={openPlan} />
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

			{/* Readiness, in two words. The detail is in the tooltip and behind
			    one click; the offending row carries a flag; and the globe draws
			    the approach. Three short signals beat one long one. */}
			<MissionReadiness blockers={blockers} count={items.length} ruleKnown={ruleKnown} />

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
				{/* The draft has diverged from the vehicle, so the route drawn on
				    the globe is not what the aircraft will fly and its execution
				    highlight has been dropped (it indexes the vehicle's mission,
				    which is a different list now). */}
				{/* The draft is on screen and what the vehicle holds is UNKNOWN —
				    nothing read back or uploaded this session, or a reconnect
				    since. The empty-state message below cannot say it, because
				    there is a plan to show; without this the operator sees their
				    waypoints and nothing hints that the aircraft may hold
				    something else entirely. */}
				{items.length > 0 && vehicleMission === null ? (
					<div className="px-1 pb-1 text-[10px] text-white/45">
						▲ the vehicle's plan is not known — this is your draft. Download to
						see what it is flying, or Upload to make them the same.
					</div>
				) : null}
				{items.length > 0 && vehicleMission !== null && !matches ? (
					<div className="px-1 pb-1 text-[10px] text-amber-300">
						▲ edited since the vehicle last took it — the globe is showing your
						draft, not what it is flying. Upload to make them the same.
					</div>
				) : null}
				{items.length === 0 ? (
					<div className="py-4 text-center text-white/30">
						{planRead.mission
							? "no mission on the vehicle — turn on “Edit map” and click the globe"
							: "not read from the vehicle yet — Download to see what it is flying, or turn on “Edit map” to author one"}
					</div>
				) : (<>
					{/* Header row. Four unlabelled numeric columns is a guessing
					    game: the altitude and radius boxes are indistinguishable
					    once the kind column changes width. */}
					<div className="flex items-center gap-1 border-b border-white/10 pb-1 text-[9px] uppercase tracking-wide text-white/40">
						<span className="w-4" title="Sequence — the order PX4 flies them">#</span>
						<span className="w-[7.5rem]">Type</span>
						<span className="w-14 text-right"
						title="Altitude in metres ABOVE HOME — the frame mission items upload in (GLOBAL_RELATIVE_ALT_INT), not height above sea level. The HUD's altitude tape reads MSL, so the two differ by home's elevation.">
						Alt ▲home
					</span>
						<span className="w-12 text-right" title="Radius, seconds or turns, depending on the type">Radius</span>
						<span className="flex-1" />
						<span className="w-3" title="Warnings about this item" />
						<span className="w-[5.5rem] text-right">Actions</span>
					</div>
					{items.map((it) => {
						const extra = extraParam(it.kind);
						const isCurrent = current === it.seq;
						return (
							<div key={it.seq}
								className={`flex items-center gap-1 border-b border-white/5 py-1 ${isCurrent ? "bg-yellow-400/10" : ""}`}>
								<span className="w-4 text-white/40">{it.seq}</span>
								<select
									value={it.kind}
									onChange={(e) => {
										const kind = e.target.value as MissionKind;
										// A landing is where the aircraft touches DOWN, so it
										// belongs at ground level. Inheriting the cruise
										// altitude of the waypoint it was converted from is
										// what put a "landing" 50 m in the air and made PX4
										// reject the approach as impossibly steep.
										updateItem(it.seq, kind === "land" && (it.alt ?? 0) > 0
											? { kind, alt: 0 }
											: { kind });
									}}
									className="h-6 w-[7.5rem] rounded border border-white/15 bg-transparent px-1 text-white"
								>
									{KINDS.map((k) => <option key={k} value={k} className="bg-black">{k}</option>)}
								</select>
								{kindHasPosition(it.kind) ? (
									<input
										type="number"
										value={it.alt ?? 0}
										onChange={(e) => updateItem(it.seq, { alt: Number(e.target.value) })}
										className="h-6 w-14 rounded border border-white/15 bg-transparent px-1 text-right text-white"
										title="Altitude in metres above HOME (the upload frame) — or drag the ▲ handle on the globe"
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
								{/* The flag puts the problem ON the item, so "approach too
								    steep" points at the landing rather than at the plan. */}
								<RowFlag blockers={blockersForSeq(blockers, it.seq)} />
								<button onClick={() => reorderItem(it.seq, -1)} className="px-1 text-white/50 hover:text-white" title="up">↑</button>
								<button onClick={() => reorderItem(it.seq, 1)} className="px-1 text-white/50 hover:text-white" title="down">↓</button>
								<button onClick={() => live && telemetryClient.setCurrentMissionItem(it.seq)}
									disabled={!live} className="px-1 text-white/50 hover:text-white disabled:opacity-30" title="set current">◎</button>
								<button onClick={() => removeItem(it.seq)} className="px-1 text-red-400/70 hover:text-red-400" title="delete">✕</button>
							</div>
						);
					})}
				</>)}
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
