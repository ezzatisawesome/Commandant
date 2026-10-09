"use client";

import { memo, useMemo, useState } from "react";
import { useStore } from "@nanostores/react";
import { Plus, X, ChevronLeft, ChevronRight, Rows3, Pencil, Search } from "lucide-react";

import { $hudFrame, $historyStore, isNum } from "@/stores/aircraft.store";
import { $linkState } from "@/stores/link.store";
import { $derived } from "@/stores/derived.store";
import {
	$visibleFields, $extraRows, $chartedFields, FIELD_BY_KEY, DERIVED_BY_KEY,
	CHANNEL_GROUPS, isDerivedKey, allFieldOptions, setCell, addCell, addRow,
	removeRow, moveCell, toggleCharted,
} from "@/stores/displayConfig.store";
import type { LinkState, TelemetryFrame } from "@/types/app";
import type { ClearanceBand } from "@/lib/flightGeometry";
import { Sparkline } from "./Sparkline";
import { ControlBar } from "./ControlBar";

// The telemetry strip: an EDITABLE grid overlaid on the bottom edge of the globe.
//
// Why the bottom edge rather than a side rail: the globe is the instrument, and a
// side panel competes with it for the widest part of the screen. A band along the
// bottom costs a dimension the map barely uses, keeps the aircraft centred, and
// reads left-to-right like an instrument row.
//
// Why editable in place: a configuration panel somewhere else means you change a
// field, look back, and discover you picked the wrong one. Here the thing you
// click IS the thing that changes. Edit mode is explicit (the pencil) so a normal
// click never rearranges an instrument mid-flight.
//
// Telemetry and derived values share one catalog, so "AGL" or "Wind" can sit
// anywhere a raw MAVLink field can.

const LINK_DOT: Record<LinkState, { className: string; title: string }> = {
	connecting: { className: "bg-amber-400 animate-pulse", title: "Connecting…" },
	alive: { className: "bg-emerald-400", title: "MAVLink alive" },
	stale: { className: "bg-amber-400", title: "Link stale — no recent telemetry" },
	lost: { className: "bg-red-500", title: "Link lost" },
};

const CLEARANCE_TEXT: Record<ClearanceBand, string> = {
	critical: "text-red-400", low: "text-amber-400",
	ok: "text-emerald-400", unknown: "text-white/40",
};

const M_TO_FT = 3.28084;
const STALE_DATA_MS = 3000;

const fmt = (v: unknown, digits = 1) => (isNum(v) ? v.toFixed(digits) : "—");

function compass(deg: number): string {
	const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
		"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
	return pts[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

interface CellView {
	label: string; value: string; unit?: string; tone: string; title?: string;
	control?: number;
}

const Cell = memo(function Cell({
	view, editing, onEdit, spark,
}: {
	view: CellView; editing: boolean; onEdit: () => void;
	spark?: Array<number | undefined>;
}) {
	return (
		<button
			type="button"
			onClick={editing ? onEdit : undefined}
			disabled={!editing}
			title={editing ? "Click to change or remove this field" : view.title}
			className={`flex shrink-0 flex-col items-start justify-center px-2.5 text-left
				${editing ? "cursor-pointer rounded ring-1 ring-sky-400/40 hover:bg-sky-400/10" : "cursor-default"}`}
		>
			<span className="text-[9px] uppercase leading-none tracking-wide text-white/45">
				{view.label}
			</span>
			<div className="flex items-baseline gap-1 leading-none">
				<span className={`font-mono text-[13px] ${view.tone}`}>{view.value}</span>
				{view.unit ? <span className="text-[9px] text-white/40">{view.unit}</span> : null}
				{view.control !== undefined ? <ControlBar value={view.control} /> : null}
			</div>
			{spark ? <Sparkline values={spark} width={44} height={10} /> : null}
		</button>
	);
});

const Divider = () => <div className="mx-0.5 h-7 w-px shrink-0 bg-white/10" />;

/** The link column, reserved on every row so the channels line up under it. */
const LINK_GUTTER = "w-[7.5rem] px-3";

export function TelemetryStrip() {
	const f = useStore($hudFrame);
	const history = useStore($historyStore);
	const linkState = useStore($linkState);
	const d = useStore($derived);
	const row0 = useStore($visibleFields);
	const extra = useStore($extraRows);
	const charted = useStore($chartedFields);

	const [editing, setEditing] = useState(false);
	// Which cell the picker is open for: [row, index], or index -1 to append.
	const [picking, setPicking] = useState<[number, number] | null>(null);
	const [query, setQuery] = useState("");

	const rows = useMemo(() => [row0, ...extra], [row0, extra]);
	const chartedSet = useMemo(() => new Set(charted), [charted]);
	const seriesByKey = useMemo(() => {
		const out: Partial<Record<keyof TelemetryFrame, Array<number | undefined>>> = {};
		for (const key of charted) {
			const k = key as keyof TelemetryFrame;
			out[k] = history.map((fr) => fr[k] as number | undefined);
		}
		return out;
	}, [history, charted]);

	const dot = LINK_DOT[linkState];
	const age = f?.dataAgeMs;
	const frozen = isNum(age) && age > STALE_DATA_MS;

	/** Render one key, whether it is a raw MAVLink field or a derived value. */
	function viewFor(key: string): CellView | null {
		if (isDerivedKey(key)) {
			const meta = DERIVED_BY_KEY[key];
			switch (key) {
				case "aglFt":
					return {
						label: meta.label, unit: d.aglM === null ? undefined : meta.unit,
						value: d.aglM === null ? "—" : (d.aglM * M_TO_FT).toFixed(0),
						tone: CLEARANCE_TEXT[d.clearance],
						title: d.terrainM !== null
							? `terrain ${d.terrainM.toFixed(0)} m MSL · ${d.aglM?.toFixed(0) ?? "—"} m AGL`
							: "waiting for terrain tiles under the aircraft",
					};
				case "wind":
					return {
						label: meta.label, unit: d.wind ? meta.unit : undefined,
						value: d.wind === null ? "—"
							: `${d.wind.speedMps.toFixed(1)} ${compass(d.wind.fromDeg)}`,
						tone: "text-white",
						title: d.wind ? `from ${d.wind.fromDeg.toFixed(0)}°` : "needs two fixes",
					};
				case "drift":
					return {
						label: meta.label,
						value: d.wind === null ? "—"
							: `${d.wind.driftDeg > 0 ? "+" : ""}${d.wind.driftDeg.toFixed(0)}°`,
						tone: d.wind && Math.abs(d.wind.driftDeg) > 20 ? "text-amber-400" : "text-white",
						title: "track minus heading; positive = pushed right of the nose",
					};
				case "sunEl":
					return {
						label: meta.label,
						value: d.sun === null ? "—" : d.sun.elevationDeg < 0 ? "night"
							: `${d.sun.elevationDeg.toFixed(0)}° ${compass(d.sun.azimuthDeg)}`,
						tone: d.sun && d.sun.elevationDeg < 0 ? "text-sky-300/60" : "text-white",
						title: d.sun ? `azimuth ${d.sun.azimuthDeg.toFixed(0)}°` : "needs the sim clock",
					};
				case "targetDist":
					return {
						label: meta.label, unit: d.targetDistM === null ? undefined : meta.unit,
						value: d.targetDistM === null ? "—" : d.targetDistM.toFixed(0),
						// On fixed-wing PX4 a loiter setpoint is the orbit CENTRE, so a
						// distance near the loiter radius is correct, not an error.
						tone: d.targetDistM === null ? "text-white/40"
							: d.targetDistM > 3000 ? "text-amber-400" : "text-white",
						title: "Distance to the commanded setpoint (orange path). "
							+ "For a loiter this should be about the orbit radius; "
							+ "kilometres means the setpoint is being mis-decoded.",
					};
				case "fenceDist":
					return {
						label: meta.label, unit: d.fence ? meta.unit : undefined,
						value: d.fence === null ? "—"
							: `${d.fence.violated ? "OUT " : ""}${d.fence.distanceM.toFixed(0)}`,
						tone: !d.fence ? "text-white/40" : d.fence.violated ? "text-red-400"
							: d.fence.distanceM < 100 ? "text-amber-400" : "text-emerald-400",
						title: d.fence ? `${d.fence.kind}${d.fence.violated ? " — BREACHED" : ""}` : "no fence",
					};
			}
		}
		const def = FIELD_BY_KEY[key];
		if (!def) return null;
		const raw = f ? f[def.key] : undefined;
		if (def.kind === "text") {
			return {
				label: def.label,
				value: def.key === "armed"
					? (raw === undefined ? "—" : raw ? "ARMED" : "DISARMED")
					: ((raw as string | undefined) ?? "—"),
				tone: def.key === "armed" && raw ? "text-amber-300" : "text-white",
			};
		}
		if (def.kind === "control") {
			return {
				label: def.label, value: fmt(raw, def.digits ?? 0), unit: def.unit,
				tone: "text-white", control: isNum(raw) ? raw : undefined,
			};
		}
		return {
			label: def.label, value: fmt(raw, def.digits ?? 1), unit: def.unit,
			tone: "text-white",
		};
	}

	// The picker is a LIST of channels, not a grid of labels. A label alone
	// ("Voltage", "Current") does not say which subsystem it came from, so each
	// row leads with the dotted channel id — bus.voltage, power.motor — grouped
	// under its subsystem and filterable by typing. A grid of bare words made
	// the operator guess; a channel list reads like the telemetry it indexes.
	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		const all = allFieldOptions();
		return q
			? all.filter((o) => o.channel.toLowerCase().includes(q)
				|| o.label.toLowerCase().includes(q))
			: all;
	}, [query]);
	const groupsShown = useMemo(
		() => CHANNEL_GROUPS.filter((g) => matches.some((o) => o.group === g.ns)),
		[matches],
	);

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-stretch">
			{/* Field picker, opened by clicking a cell in edit mode. */}
			{picking ? (
				<div className="pointer-events-auto mb-1 flex max-h-96 w-96 self-center flex-col
					overflow-hidden rounded-md border border-white/15 bg-black/90 text-[11px] backdrop-blur">
					<div className="flex items-center justify-between px-2 pt-2">
						<span className="uppercase tracking-wide text-white/50">
							{picking[1] < 0 ? "Add channel" : "Change channel"}
						</span>
						<button onClick={() => setPicking(null)} className="text-white/40 hover:text-white">
							<X className="h-3.5 w-3.5" />
						</button>
					</div>

					<div className="flex items-center gap-1.5 px-2 py-2">
						<Search className="h-3.5 w-3.5 shrink-0 text-white/30" />
						<input
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter channels — bus.voltage, nav, wind…"
							className="w-full bg-transparent font-mono text-[11px] text-white/90
								placeholder:text-white/25 focus:outline-none"
						/>
					</div>

					<div className="flex-1 overflow-y-auto border-t border-white/10">
						{groupsShown.map((g) => (
							<div key={g.ns}>
								<div className="sticky top-0 bg-black/90 px-2 py-1 text-[9px] uppercase
									tracking-wide text-white/30">
									{g.ns} — {g.title}
								</div>
								{matches.filter((o) => o.group === g.ns).map((o) => {
									const current = picking[1] >= 0
										&& rows[picking[0]]?.[picking[1]] === o.key;
									return (
										<button
											key={o.key}
											onClick={() => {
												const [r, i] = picking;
												if (i < 0) addCell(r, o.key); else setCell(r, i, o.key);
												setPicking(null); setQuery("");
											}}
											className={`flex w-full items-baseline gap-2 px-2 py-1 text-left
												hover:bg-sky-400/10 ${current ? "bg-white/5" : ""}`}
										>
											<span className={`font-mono ${current ? "text-sky-300" : "text-white/85"}`}>
												{o.channel}
											</span>
											<span className="truncate text-white/40">{o.label}</span>
											<span className="flex-1" />
											{o.unit ? (
												<span className="shrink-0 font-mono text-[9px] text-white/30">{o.unit}</span>
											) : null}
										</button>
									);
								})}
							</div>
						))}
						{matches.length === 0 ? (
							<div className="px-2 py-3 text-white/35">No channel matches “{query}”.</div>
						) : null}
					</div>

					{picking[1] >= 0 ? (
						<div className="flex items-center gap-1 border-t border-white/10 p-2">
							<button
								onClick={() => { moveCell(picking[0], picking[1], -1); setPicking(null); }}
								className="rounded border border-white/10 px-1.5 py-1 text-white/70 hover:bg-white/10"
								title="Move left"
							>
								<ChevronLeft className="h-3.5 w-3.5" />
							</button>
							<button
								onClick={() => { moveCell(picking[0], picking[1], 1); setPicking(null); }}
								className="rounded border border-white/10 px-1.5 py-1 text-white/70 hover:bg-white/10"
								title="Move right"
							>
								<ChevronRight className="h-3.5 w-3.5" />
							</button>
							{(() => {
								const key = rows[picking[0]]?.[picking[1]];
								const def = key ? FIELD_BY_KEY[key] : undefined;
								return def?.kind === "num" ? (
									<button
										onClick={() => { toggleCharted(key!); setPicking(null); }}
										className={`rounded border border-white/10 px-1.5 py-1 hover:bg-white/10
											${chartedSet.has(key!) ? "text-sky-400" : "text-white/60"}`}
										title="Toggle sparkline"
									>
										chart
									</button>
								) : null;
							})()}
							<span className="flex-1" />
							<button
								onClick={() => { setCell(picking[0], picking[1], ""); setPicking(null); }}
								className="rounded border border-red-500/30 px-1.5 py-1 text-red-400 hover:bg-red-500/10"
								title="Remove this field"
							>
								Remove
							</button>
						</div>
					) : null}
				</div>
			) : null}

			{/* Full-bleed: the strip spans the whole viewport width, so the grid
			    reads as an instrument row along the bottom edge rather than a
			    floating card. Only the top edge is drawn — the sides are screen. */}
			<div className="pointer-events-auto flex w-full flex-col
				border-t border-white/10 bg-black/70 backdrop-blur">
				{rows.map((row, r) => (
					<div key={r}
						// Edit mode rings every cell, and rings that touch read as one
						// block rather than separate targets — so the row only gains gaps
						// (and side padding, so the end rings aren't flush against the
						// screen) while editing. Normal flight keeps the cells tight.
						className={`flex items-stretch overflow-x-auto py-1.5
							${editing ? "gap-1.5 px-1" : ""}
							${r > 0 ? "border-t border-white/10" : ""}`}>
						{/* Link status leads the first row: the first thing to check. The
						    gutter is a FIXED width and every later row reserves it, so
						    channels on row 1+ start where row 0's channels do instead of
						    sliding under the link block — the strip reads as columns. */}
						<div className={`flex shrink-0 items-center gap-2 ${LINK_GUTTER}`}
							title={r === 0 ? dot.title : undefined} aria-hidden={r > 0}>
							{r === 0 ? (
								<>
									<span className={`h-2 w-2 shrink-0 rounded-full ${dot.className}`} />
									<div className="flex min-w-0 flex-col leading-none">
										<span className="text-[9px] uppercase tracking-wide text-white/45">Link</span>
										{frozen ? (
											<span className="font-mono text-[11px] font-semibold text-red-400"
												title={`No new vehicle data for ${Math.round((age as number) / 1000)} s`}>
												stale {Math.round((age as number) / 1000)}s
											</span>
										) : (
											<span className="font-mono text-[11px] text-white/80">{linkState}</span>
										)}
									</div>
								</>
							) : null}
						</div>
						<Divider />

						{row.map((key, i) => {
							const view = viewFor(key);
							if (!view) return null;
							const def = FIELD_BY_KEY[key];
							return (
								<Cell
									key={`${r}:${i}:${key}`}
									view={view}
									editing={editing}
									onEdit={() => { setQuery(""); setPicking([r, i]); }}
									spark={def?.kind === "num" && chartedSet.has(key)
										? seriesByKey[def.key] : undefined}
								/>
							);
						})}

						{editing ? (
							<button
								onClick={() => { setQuery(""); setPicking([r, -1]); }}
								className="mx-1 shrink-0 self-center rounded border border-dashed border-white/25
									px-2 py-1 text-white/50 hover:bg-white/10"
								title="Add a field to this row"
							>
								<Plus className="h-3.5 w-3.5" />
							</button>
						) : null}

						{editing && r > 0 ? (
							<button
								onClick={() => removeRow(r)}
								className="mr-1 shrink-0 self-center rounded border border-red-500/30 px-1.5 py-1
									text-red-400 hover:bg-red-500/10"
								title="Remove this row"
							>
								<X className="h-3 w-3" />
							</button>
						) : null}

						<span className="flex-1" />

						{/* Edit affordance lives on the first row only. */}
						{r === 0 ? (
							<div className="flex shrink-0 items-center gap-1 px-2">
								{editing ? (
									<button
										onClick={() => addRow()}
										className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-white/70 hover:bg-white/10"
										title="Add a row"
									>
										<Rows3 className="h-3.5 w-3.5" />
									</button>
								) : null}
								<button
									onClick={() => { setEditing((e) => !e); setPicking(null); }}
									className={`rounded border px-1.5 py-1 text-[10px]
										${editing ? "border-sky-400/50 bg-sky-400/10 text-sky-300"
											: "border-white/15 text-white/50 hover:bg-white/10"}`}
									title={editing ? "Done editing" : "Edit the strip: click any field to change it"}
								>
									{editing ? "Done" : <Pencil className="h-3.5 w-3.5" />}
								</button>
							</div>
						) : null}
					</div>
				))}
			</div>
		</div>
	);
}
