"use client";

import { useEffect, useState } from "react";

import { Button } from "@/ui/button";

type Airframe = { name: string; path: string; content: string };

// Render one line of the PX4 airframe init script, lightly styled: comments and
// shell directives dimmed; `param set-default NAME VALUE` picks out the param
// name and value so the operating envelope (airspeeds, control allocation) is
// scannable at a glance.
function ConfigLine({ line }: { line: string }) {
	const t = line.replace(/\s+$/, "");
	const trimmed = t.trim();
	if (trimmed.startsWith("#") || trimmed.startsWith(".") || trimmed.startsWith("PX4_")) {
		return <div className="text-white/35">{t || " "}</div>;
	}
	const m = t.match(/^(\s*param set-default\s+)(\S+)(\s+)(.*)$/);
	if (m) {
		return (
			<div>
				<span className="text-white/40">{m[1]}</span>
				<span className="text-sky-300">{m[2]}</span>
				<span>{m[3]}</span>
				<span className="text-emerald-300">{m[4]}</span>
			</div>
		);
	}
	return <div className="text-white/80">{t || " "}</div>;
}

// A toggle panel showing the PX4 airframe config that PX4 boots the aircraft
// with — the flight-side counterpart to the physical airframe model. Fetched
// live from /api/airframe (the committed source of truth), so what you read here
// is what actually gets installed into PX4.
export default function AirframeConfig() {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState<Airframe | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || data) return;
		fetch("/api/airframe")
			.then(async (r) => {
				const j = await r.json();
				if (!r.ok) throw new Error(j.error || r.statusText);
				return j as Airframe;
			})
			.then(setData)
			.catch((e) => setError(e.message as string));
	}, [open, data]);

	return (
		<>
			<Button
				onClick={() => setOpen((o) => !o)}
				variant="ghost"
				className="h-7 w-64 border border-white/10 bg-black/60 text-xs backdrop-blur"
			>
				{open ? "Hide airframe config" : "Airframe config"}
			</Button>

			{open && (
				<div className="flex max-h-[80vh] w-[30rem] max-w-[calc(100vw-2rem)] flex-col rounded-md border border-white/10 bg-black/80 backdrop-blur">
					<div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
						<span className="text-xs font-semibold text-white">
							PX4 airframe · {data?.name ?? "1100_jsbsim_rev6"}
						</span>
						<span className="text-[10px] uppercase tracking-wide text-white/40">
							source of truth
						</span>
					</div>
					<div className="overflow-auto p-3 font-mono text-[11px] leading-relaxed">
						{error ? (
							<div className="text-red-400">{error}</div>
						) : data ? (
							data.content.split("\n").map((line, i) => <ConfigLine key={i} line={line} />)
						) : (
							<div className="text-white/40">loading…</div>
						)}
					</div>
					{data && (
						<div className="truncate border-t border-white/10 px-3 py-1.5 text-[10px] text-white/30">
							{data.path}
						</div>
					)}
				</div>
			)}
		</>
	);
}
