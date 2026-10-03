"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@nanostores/react";

import { $params, $paramProgress } from "@/stores/params.store";
import { $linkState } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
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
	const linkState = useStore($linkState);
	const live = linkState === "alive";

	const [query, setQuery] = useState("");
	const [edits, setEdits] = useState<Record<string, string>>({});
	const [rowStatus, setRowStatus] = useState<Record<string, { ok: boolean; text: string }>>({});
	const [defaults, setDefaults] = useState<Record<string, number>>({});

	// On first open, pull the full list and load the airframe defaults for diffing.
	useEffect(() => {
		if (!open) return;
		telemetryClient.refreshParams();
		fetch("/api/airframe")
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => { if (j?.content) setDefaults(parseDefaults(j.content as string)); })
			.catch(() => { /* defaults are optional */ });
	}, [open]);

	const rows = useMemo(() => {
		const all = Object.values(params).sort((a, b) => a.name.localeCompare(b.name));
		const q = query.trim().toUpperCase();
		const filtered = q ? all.filter((p) => p.name.toUpperCase().includes(q)) : all;
		return filtered.slice(0, ROW_CAP);
	}, [params, query]);

	const total = Object.keys(params).length;

	async function commit(name: string, ptype: number) {
		const raw = edits[name];
		if (raw === undefined) return;
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			setRowStatus((s) => ({ ...s, [name]: { ok: false, text: "NaN" } }));
			return;
		}
		try {
			const ack = await telemetryClient.setParam(name, value, ptype);
			setRowStatus((s) => ({ ...s, [name]: { ok: ack.ok, text: ack.text || (ack.ok ? "set" : "rejected") } }));
			if (ack.ok) setEdits((e) => { const n = { ...e }; delete n[name]; return n; });
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
						</div>
					</div>

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
								return (
									<div key={p.name} className="flex items-center gap-2 border-b border-white/5 py-1">
										<span className="flex-1 truncate text-sky-300" title={changed ? `default ${def}` : p.name}>
											{changed ? <span className="mr-1 text-amber-400" title={`default ${def}`}>●</span> : null}
											{p.name}
										</span>
										<input
											value={editing ? edits[p.name] : String(p.value)}
											onChange={(e) => setEdits((s) => ({ ...s, [p.name]: e.target.value }))}
											onKeyDown={(e) => { if (e.key === "Enter") commit(p.name, p.ptype); }}
											className={`h-6 w-20 rounded border bg-transparent px-1 text-right text-white ${editing ? "border-amber-400/50" : "border-white/15"}`}
										/>
										<Button size="sm" variant="outline" disabled={!live || !editing}
											onClick={() => commit(p.name, p.ptype)} className="h-6 px-2 text-[10px]">
											Set
										</Button>
										{st ? <span className={`w-10 text-[9px] ${st.ok ? "text-emerald-400" : "text-red-400"}`} title={st.text}>{st.ok ? "✓" : "✗"}</span> : <span className="w-10" />}
									</div>
								);
							})
						)}
					</div>
				</div>
			)}
		</>
	);
}
