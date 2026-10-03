"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import {
	$fenceItems,
	$rallyItems,
	$geoEdit,
	$geoPlaceKind,
	fenceItemsForPush,
	isCircleKind,
	updateFenceItem,
	removeFenceItem,
	removeRallyItem,
	updateRallyItem,
	clearFence,
	clearRally,
} from "@/stores/geo.store";
import { $linkState } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import { Button } from "@/components/ui/button";
import type { FenceKind } from "@/types/app";

// What a globe click places while "Edit map" is on.
const PLACE_KINDS: Array<{ value: FenceKind | "rally"; label: string }> = [
	{ value: "fence_inclusion", label: "incl poly" },
	{ value: "fence_exclusion", label: "excl poly" },
	{ value: "fence_circle_inclusion", label: "incl circle" },
	{ value: "fence_circle_exclusion", label: "excl circle" },
	{ value: "rally", label: "rally" },
];

// Phase-4 extension: author geofences (inclusion/exclusion polygons + circles) and
// rally points, upload/download them (fence/rally share the mission handshake in gs,
// keyed by mission_type), and surface the ack. Mirrors MissionPanel.
export default function GeoPanel() {
	const [open, setOpen] = useState(false);
	const fence = useStore($fenceItems);
	const rally = useStore($rallyItems);
	const edit = useStore($geoEdit);
	const placeKind = useStore($geoPlaceKind);
	const linkState = useStore($linkState);
	const live = linkState === "alive";

	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);

	async function run(kind: "fence" | "rally", action: () => Promise<{ ok: boolean; text: string }>) {
		setBusy(true);
		setStatus(null);
		try {
			const ack = await action();
			setStatus({ ok: ack.ok, text: `${kind}: ${ack.text || (ack.ok ? "uploaded" : "rejected")}` });
		} catch (err) {
			setStatus({ ok: false, text: `${kind}: ${err instanceof Error ? err.message : "failed"}` });
		} finally {
			setBusy(false);
		}
	}

	const count = fence.length + rally.length;

	return (
		<>
			<Button
				onClick={() => setOpen((o) => !o)}
				variant="ghost"
				className="h-7 w-64 border border-white/10 bg-black/60 text-xs backdrop-blur"
			>
				{open ? "Hide fence/rally" : `Fence / rally${count ? ` (${count})` : ""}`}
			</Button>

			{open && (
				<div className="flex max-h-[80vh] w-[30rem] max-w-[calc(100vw-2rem)] flex-col rounded-md border border-white/10 bg-black/80 backdrop-blur">
					<div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
						<span className="text-xs font-semibold text-white">Geofence & rally</span>
						<Button size="sm" variant={edit ? "default" : "outline"}
							onClick={() => $geoEdit.set(!edit)} className="h-6 px-2 text-[10px]"
							title="Click the globe to place the selected kind">
							{edit ? "Editing map" : "Edit map"}
						</Button>
					</div>

					{/* Place-kind selector (what a globe click drops). */}
					{edit ? (
						<div className="flex flex-wrap gap-1 border-b border-white/10 px-3 py-2">
							{PLACE_KINDS.map((k) => (
								<Button key={k.value} size="sm" variant={placeKind === k.value ? "default" : "outline"}
									onClick={() => $geoPlaceKind.set(k.value)} className="h-6 px-2 text-[10px]">
									{k.label}
								</Button>
							))}
						</div>
					) : null}

					{status ? (
						<div className={`px-3 pt-2 text-[10px] ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
							{status.ok ? "✓" : "✗"} {status.text}
						</div>
					) : null}

					<div className="overflow-auto px-3 py-2 font-mono text-[11px]">
						{/* FENCE */}
						<div className="mb-1 flex items-center justify-between">
							<span className="text-[10px] uppercase tracking-wide text-white/40">Fence ({fence.length})</span>
							<div className="flex gap-1">
								<Button size="sm" variant="outline" disabled={!live || busy}
									onClick={() => telemetryClient.pullFence()} className="h-5 px-2 text-[9px]">Download</Button>
								<Button size="sm" variant="outline" disabled={!live || busy || fence.length === 0}
									onClick={() => run("fence", () => telemetryClient.pushFence(fenceItemsForPush()))}
									className="h-5 px-2 text-[9px]">Upload</Button>
							</div>
						</div>
						{fence.length === 0 ? (
							<div className="py-2 text-center text-white/30">no fence — edit map & place vertices/circles</div>
						) : fence.map((it) => (
							<div key={it.seq} className="flex items-center gap-1 border-b border-white/5 py-1">
								<span className="w-4 text-white/40">{it.seq}</span>
								<span className={`flex-1 truncate ${it.kind.includes("exclusion") ? "text-red-300" : "text-lime-300"}`}>
									{it.kind.replace("fence_", "")}
								</span>
								{isCircleKind(it.kind) ? (
									<input type="number" value={it.params?.radius ?? 100}
										onChange={(e) => updateFenceItem(it.seq, { params: { ...it.params, radius: Number(e.target.value) } })}
										className="h-6 w-14 rounded border border-white/15 bg-transparent px-1 text-right text-white" title="radius (m)" />
								) : <span className="w-14 text-right text-white/30">{it.lat.toFixed(4)}</span>}
								<button onClick={() => removeFenceItem(it.seq)} className="px-1 text-red-400/70 hover:text-red-400" title="delete">✕</button>
							</div>
						))}
						{fence.length > 0 ? (
							<div className="pt-1 text-right">
								<Button size="sm" variant="ghost" onClick={() => clearFence()} className="h-5 px-2 text-[9px] text-white/50">Clear fence</Button>
							</div>
						) : null}

						{/* RALLY */}
						<div className="mb-1 mt-3 flex items-center justify-between">
							<span className="text-[10px] uppercase tracking-wide text-white/40">Rally ({rally.length})</span>
							<div className="flex gap-1">
								<Button size="sm" variant="outline" disabled={!live || busy}
									onClick={() => telemetryClient.pullRally()} className="h-5 px-2 text-[9px]">Download</Button>
								<Button size="sm" variant="outline" disabled={!live || busy || rally.length === 0}
									onClick={() => run("rally", () => telemetryClient.pushRally(rally))}
									className="h-5 px-2 text-[9px]">Upload</Button>
							</div>
						</div>
						{rally.length === 0 ? (
							<div className="py-2 text-center text-white/30">no rally points</div>
						) : rally.map((it) => (
							<div key={it.seq} className="flex items-center gap-1 border-b border-white/5 py-1">
								<span className="w-4 text-cyan-300/70">R{it.seq}</span>
								<span className="flex-1 truncate text-cyan-300">{it.lat.toFixed(4)}, {it.lon.toFixed(4)}</span>
								<input type="number" value={it.alt ?? 0}
									onChange={(e) => updateRallyItem(it.seq, { alt: Number(e.target.value) })}
									className="h-6 w-14 rounded border border-white/15 bg-transparent px-1 text-right text-white" title="alt (m)" />
								<button onClick={() => removeRallyItem(it.seq)} className="px-1 text-red-400/70 hover:text-red-400" title="delete">✕</button>
							</div>
						))}
						{rally.length > 0 ? (
							<div className="pt-1 text-right">
								<Button size="sm" variant="ghost" onClick={() => clearRally()} className="h-5 px-2 text-[9px] text-white/50">Clear rally</Button>
							</div>
						) : null}
					</div>
				</div>
			)}
		</>
	);
}
