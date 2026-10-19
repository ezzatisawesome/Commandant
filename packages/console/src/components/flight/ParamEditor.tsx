"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@nanostores/react";

import {
	$params, $paramProgress, $paramError, $paramsStale, upsertParam,
} from "@/stores/params.store";
import { $linkState } from "@/stores/link.store";
import {
	diffSnapshot, makeSnapshot, parseSnapshot, snapshotFilename,
	type ParamDiff,
} from "@/lib/paramSnapshot";
import { telemetryClient } from "@/services/telemetry";
import { loadParamMeta, lookupMeta, parseParamInput, validateParam, type ParamMeta } from "@/lib/paramMeta";
import { Button } from "@/components/ui/button";

// Parse `param set-default NAME VALUE` out of the airframe init script so we can
// flag params that differ from what the airframe boots with. Best-effort; a param
// absent here just has no known default.
function parseDefaults(script: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const raw of script.split("\n")) {
		const m = raw.match(/^\s*param set-default\s+(\S+)\s+(\S+)/);
		if (m) {
			const v = Number(m[2]);
			if (Number.isFinite(v)) out[m[1]] = v;
		}
	}
	return out;
}

const EPS = 1e-6;
const ROW_CAP = 400; // cap rendered rows; search narrows beyond this

// Phase-2 PX4 parameter editor: view the live param table and write values on the
// fly. Opening it requests a full refresh (PARAM_REQUEST_LIST via gs); edits go
// out as param_set and are confirmed by param_ack. Changed-from-default rows are
// flagged against the airframe init script.
export default function ParamEditor() {
	const [open, setOpen] = useState(false);
	const params = useStore($params);
	const progress = useStore($paramProgress);
	const paramError = useStore($paramError);
	const paramsStale = useStore($paramsStale);
	const fileRef = useRef<HTMLInputElement>(null);
	const [snapDiff, setSnapDiff] = useState<
		{ label: string; takenAt: string; diffs: ParamDiff[] } | null>(null);
	const [snapError, setSnapError] = useState<string | null>(null);
	const [defaultsNote, setDefaultsNote] = useState<string | null>(null);

	function saveSnapshot() {
		const snap = makeSnapshot($params.get(), { label: "" });
		const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = snapshotFilename(snap);
		a.click();
		URL.revokeObjectURL(url);
	}

	async function onSnapshotFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		e.target.value = "";                     // so the same file can be re-picked
		if (!file) return;
		setSnapError(null);
		setSnapDiff(null);
		const parsed = parseSnapshot(await file.text());
		if ("error" in parsed) {
			setSnapError(parsed.error);
			return;
		}
		setSnapDiff({
			label: parsed.snapshot.label,
			takenAt: parsed.snapshot.takenAt,
			diffs: diffSnapshot(parsed.snapshot, $params.get()),
		});
	}
	const linkState = useStore($linkState);
	const live = linkState === "alive";

	const [query, setQuery] = useState("");
	const [edits, setEdits] = useState<Record<string, string>>({});
	const [rowStatus, setRowStatus] = useState<Record<string, { ok: boolean; text: string }>>({});
	const [defaults, setDefaults] = useState<Record<string, number>>({});
	const [meta, setMeta] = useState<Record<string, ParamMeta>>({});

	// On FIRST open, pull the full list (a ~1000-param download over the radio —
	// not something to repeat on every show/hide; the Refresh button is explicit),
	// load the airframe defaults for diffing, and the bundled PX4 param metadata.
	const fetchedOnce = useRef(false);
	useEffect(() => {
		if (!open || fetchedOnce.current) return;
		fetchedOnce.current = true;
		telemetryClient.refreshParams();
		loadParamMeta().then(setMeta).catch(() => { /* metadata is optional */ });
		// The airframe defaults drive the ● "changed from default" markers. They
		// were fetched and the failure swallowed, so when the path broke the
		// markers simply stopped appearing and nothing said why — an operator
		// cannot tell "nothing has changed from default" from "the comparison is
		// not happening". Say which it is.
		fetch("/api/airframe")
			.then((r) => r.json())
			.then((j) => {
				if (j?.content) {
					setDefaults(parseDefaults(j.content as string));
					setDefaultsNote(null);
				} else {
					setDefaultsNote("airframe defaults unavailable — the ● "
						+ "changed-from-default markers are off");
				}
			})
			.catch(() => setDefaultsNote("airframe defaults could not be read — the "
				+ "● changed-from-default markers are off"));
	}, [open]);

	const { rows, matched } = useMemo(() => {
		const all = Object.values(params).sort((a, b) => a.name.localeCompare(b.name));
		const q = query.trim().toUpperCase();
		const filtered = q ? all.filter((p) => p.name.toUpperCase().includes(q)) : all;
		return { rows: filtered.slice(0, ROW_CAP), matched: filtered.length };
	}, [params, query]);

	const total = Object.keys(params).length;

	async function commit(name: string, ptype: number) {
		const raw = edits[name];
		if (raw === undefined || !live) return;
		const value = parseParamInput(raw);
		if (!Number.isFinite(value)) {
			setRowStatus((s) => ({ ...s, [name]: { ok: false, text: "not a number" } }));
			return;
		}
		// Range/type-check against the bundled metadata before writing; a bad value
		// never leaves the console.
		const invalid = validateParam(lookupMeta(meta, name), value, ptype);
		if (invalid) {
			setRowStatus((s) => ({ ...s, [name]: { ok: false, text: invalid } }));
			return;
		}
		try {
			const ack = await telemetryClient.setParam(name, value, ptype);
			setRowStatus((s) => ({ ...s, [name]: { ok: ack.ok, text: ack.text || (ack.ok ? "set" : "rejected") } }));
			if (ack.ok) {
				setEdits((e) => { const n = { ...e }; delete n[name]; return n; });
				// Reflect the confirmed value even if the echo broadcast was missed.
				const cur = $params.get()[name];
				if (cur) upsertParam({ ...cur, value: ack.value });
			}
		} catch (err) {
			setRowStatus((s) => ({ ...s, [name]: { ok: false, text: err instanceof Error ? err.message : "failed" } }));
		}
	}

	return (
		<>
			<Button
				onClick={() => setOpen((o) => !o)}
				variant="ghost"
				className="h-7 w-64 border border-white/10 bg-black/60 text-xs backdrop-blur"
			>
				{open ? "Hide parameters" : "Parameters"}
			</Button>

			{open && (
				<div className="flex max-h-[80vh] w-[30rem] max-w-[calc(100vw-2rem)] flex-col rounded-md border border-white/10 bg-black/80 backdrop-blur">
					<div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
						<span className="text-xs font-semibold text-white">PX4 parameters</span>
						<div className="flex items-center gap-2">
							<span className="text-[10px] text-white/40">{total} loaded</span>
							<Button size="sm" variant="outline" disabled={!live}
								onClick={() => telemetryClient.refreshParams()} className="h-6 px-2 text-[10px]">
								Refresh
							</Button>
							{/* Snapshots: the one thing Commandant keeps on disk, because
							    "what changed since the configuration that flew?" is a
							    question nothing else can answer. A download and a file
							    picker need no backend, which matters when the only
							    network is the hub's own WiFi. */}
							<Button size="sm" variant="outline" disabled={total === 0}
								onClick={saveSnapshot}
								title={total === 0 ? "Refresh the parameters first"
									: "Save these values to a JSON file"}
								className="h-6 px-2 text-[10px]">Save</Button>
							<Button size="sm" variant="outline" disabled={total === 0}
								onClick={() => fileRef.current?.click()}
								title={total === 0 ? "Refresh the parameters first"
									: "Compare a saved file against these values"}
								className="h-6 px-2 text-[10px]">Compare</Button>
							<input ref={fileRef} type="file" accept=".json,application/json"
								className="hidden" onChange={onSnapshotFile} />
						</div>
					</div>

					{/* The link dropped and came back, so these values predate the
					    gap: gs cannot report a reboot it did not witness. Shown
					    rather than cleared — a thousand values should not vanish
					    because the WiFi hiccuped — but not claimed as current. */}
					{snapError ? (
						<div className="px-3 pt-2 text-[10px] text-red-400">
							✗ {snapError}
						</div>
					) : null}
					{snapDiff ? (
						<div className="border-b border-white/10 px-3 pb-2 pt-2 text-[10px]">
							<div className="flex items-center justify-between">
								<span className="text-white/70">
									vs snapshot {snapDiff.takenAt.slice(0, 19).replace("T", " ")}
									{snapDiff.label ? ` — ${snapDiff.label}` : ""}
								</span>
								<button onClick={() => setSnapDiff(null)}
									className="text-white/40 hover:text-white">close</button>
							</div>
							{snapDiff.diffs.length === 0 ? (
								<div className="pt-1 text-emerald-400">
									✓ identical — every parameter matches the file
								</div>
							) : (
								<div className="mt-1 max-h-40 overflow-auto font-mono">
									{snapDiff.diffs.map((d) => (
										<div key={d.name} className="flex gap-2 py-px">
											<span className="w-40 shrink-0 truncate text-white/80">{d.name}</span>
											{d.kind === "changed" ? (
												<span className="text-amber-300">
													{d.snapshot} → {d.vehicle}
												</span>
											) : d.kind === "only-in-snapshot" ? (
												<span className="text-sky-300/80">
													{d.snapshot} — not on this vehicle
												</span>
											) : (
												<span className="text-sky-300/80">
													{d.vehicle} — not in the file
												</span>
											)}
										</div>
									))}
								</div>
							)}
							<div className="pt-1 text-white/35">
								{snapDiff.diffs.length} difference{snapDiff.diffs.length === 1 ? "" : "s"}
								{" · "}editing is per-parameter below, as always
							</div>
						</div>
					) : null}
					{defaultsNote ? (
						<div className="px-3 pt-2 text-[10px] text-white/45">
							▲ {defaultsNote}
						</div>
					) : null}
					{paramsStale ? (
						<div className="px-3 pt-2 text-[10px] text-amber-400">
							▲ the link dropped — these values predate it and are unverified;
							refresh before trusting or editing any of them
						</div>
					) : null}
					{paramError ? (
						<div className="px-3 pt-2 text-[10px] text-amber-400">
							refresh incomplete ({paramError}) — {total} of the list loaded; retry when the link is alive
						</div>
					) : null}
					{/* Download progress while the list streams in. */}
					{progress ? (
						<div className="px-3 pt-2">
							<div className="h-1 w-full overflow-hidden rounded bg-white/10">
								<div className="h-full bg-sky-400"
									style={{ width: `${Math.round((progress.received / Math.max(progress.count, 1)) * 100)}%` }} />
							</div>
							<div className="mt-0.5 text-[9px] text-white/40">{progress.received}/{progress.count}</div>
						</div>
					) : null}

					<div className="px-3 pt-2">
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="search params…"
							className="h-7 w-full rounded-md border border-white/15 bg-transparent px-2 text-xs text-white placeholder:text-white/30"
						/>
					</div>

					<div className="mt-2 overflow-auto px-3 pb-3 font-mono text-[11px]">
						{rows.length === 0 ? (
							<div className="py-4 text-center text-white/30">{total ? "no match" : "loading…"}</div>
						) : (
							rows.map((p) => {
								const def = defaults[p.name];
								const changed = def !== undefined && Math.abs(def - p.value) > EPS;
								const editing = edits[p.name] !== undefined;
								const st = rowStatus[p.name];
								const md = lookupMeta(meta, p.name);
								// Rich tooltip: short/long description + range, when known.
								const range = md && (md.min !== undefined || md.max !== undefined)
									? `  [${md.min ?? "–"}..${md.max ?? "–"}]` : "";
								const title = md
									? `${md.shortDesc ?? p.name}${range}${md.longDesc ? `\n\n${md.longDesc}` : ""}`
									: p.name;
								// Live range check on the in-progress edit, so an out-of-range
								// value is flagged before Set is pressed.
								const liveErr = editing
									? validateParam(md, parseParamInput(edits[p.name]), p.ptype) : null;
								return (
									<div key={p.name} className="flex items-center gap-2 border-b border-white/5 py-1">
										<span className="flex-1 truncate text-sky-300" title={title}>
											{changed ? <span className="mr-1 text-amber-400" title={`default ${def}`}>●</span> : null}
											{p.name}
										</span>
										<input
											value={editing ? edits[p.name] : String(p.value)}
											onChange={(e) => setEdits((s) => ({ ...s, [p.name]: e.target.value }))}
											onKeyDown={(e) => { if (e.key === "Enter") commit(p.name, p.ptype); }}
											className={`h-6 w-20 rounded border bg-transparent px-1 text-right text-white ${liveErr ? "border-red-500/70" : editing ? "border-amber-400/50" : "border-white/15"}`}
											title={liveErr ?? undefined}
										/>
										<span className="w-8 shrink-0 text-[9px] text-white/40" title={md?.units ? `units: ${md.units}` : undefined}>
											{md?.units ?? ""}
										</span>
										<Button size="sm" variant="outline" disabled={!live || !editing || !!liveErr}
											onClick={() => commit(p.name, p.ptype)} className="h-6 px-2 text-[10px]">
											Set
										</Button>
										{st ? <span className={`w-10 text-[9px] ${st.ok ? "text-emerald-400" : "text-red-400"}`} title={st.text}>{st.ok ? "✓" : "✗"}</span> : <span className="w-10" />}
									</div>
								);
							})
						)}
						{/* The row cap is a render budget, not a statement about the
						    vehicle -- and it said nothing, so the list simply stopped.
						    Real PX4 has 720 parameters; sorted by name, a 400-row cap
						    ends somewhere in the Ms, which hides every RTL_, SENS_ and
						    SYS_ parameter from anyone who scrolls rather than searches.
						    The header said "720 loaded" the whole time. */}
						{matched > rows.length ? (
							<div className="border-t border-white/10 py-2 text-center text-[10px] text-amber-300/70">
								showing {rows.length} of {matched} — search to reach the rest
							</div>
						) : null}
					</div>
				</div>
			)}
		</>
	);
}
