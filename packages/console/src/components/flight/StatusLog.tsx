"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";
import { ChevronUp, ChevronDown } from "lucide-react";

import { $statusTexts, clearStatus } from "@/stores/statustext.store";

// MAV_SEVERITY -> color. 0..3 are emergency/alert/critical/error (red),
// 4 warning (amber), 5 notice (sky), 6 info / 7 debug (muted).
function sevClass(sev: number): string {
	if (sev <= 3) return "text-red-400";
	if (sev === 4) return "text-amber-400";
	if (sev === 5) return "text-sky-300";
	return "text-white/60";
}

const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

// PX4 STATUSTEXT log: the autopilot's own warnings, failsafe reasons, and
// mode/command rejections, newest at the bottom. A collapsible right-rail panel.
export function StatusLog() {
	const entries = useStore($statusTexts);
	const [collapsed, setCollapsed] = useState(false);

	// Newest last; show the tail (the panel scrolls).
	const shown = entries.slice(-100);

	return (
		<div className="w-64 rounded-md border border-white/10 bg-black/60 p-3 backdrop-blur">
			<div className="flex items-center justify-between">
				<button
					onClick={() => setCollapsed((c) => !c)}
					className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-white/50 hover:text-white"
					title={collapsed ? "Expand status log" : "Collapse status log"}
				>
					{collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
					Status {entries.length ? `(${entries.length})` : ""}
				</button>
				{entries.length ? (
					<button onClick={() => clearStatus()} className="text-[10px] text-white/40 hover:text-white">
						clear
					</button>
				) : null}
			</div>
			{collapsed ? null : (
				<div className="mt-2 max-h-40 overflow-auto font-mono text-[10px] leading-relaxed">
					{shown.length === 0 ? (
						<div className="text-white/30">no messages</div>
					) : (
						shown.map((e) => (
							<div key={e.id} className="flex gap-1.5">
								<span className="shrink-0 text-white/30">{hhmmss(e.t)}</span>
								<span className={`${sevClass(e.severity)} break-words`}>{e.text}</span>
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
