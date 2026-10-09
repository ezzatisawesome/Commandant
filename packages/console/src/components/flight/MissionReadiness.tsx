"use client";

import { useState } from "react";

import type { Blocker } from "@/lib/missionCheck";

// Can PX4 fly this plan? One chip, not an essay.
//
// The first version of this stacked a paragraph per problem above the mission
// table, which is how a panel becomes a wall of amber the operator stops
// reading. The constraint is better expressed three ways at once, each short:
//
//   * here, as a dot and two words — enough to know whether to press MISSION
//   * on the offending table row, as a flag — so the problem has a LOCATION
//   * on the globe, as the approach line and the ring the landing must sit
//     outside — so the constraint can be dragged into compliance directly
//
// The full sentence still exists, in the tooltip and behind one click. Nobody
// needs it until they want it, and then they want all of it.

export function MissionReadiness({ blockers, count }: { blockers: Blocker[]; count: number }) {
	const [open, setOpen] = useState(false);

	if (count === 0) return null;

	const ok = blockers.length === 0;
	const summary = ok
		? "ready to fly"
		: blockers.length === 1
			? blockers[0].short
			: `${blockers.length} problems`;
	const tip = ok
		? "Nothing predictable stops PX4 flying this plan."
		: blockers.map((b) => `• ${b.detail}`).join("\n\n");

	return (
		<div className="pt-2">
			<button
				onClick={() => setOpen((o) => !o)}
				disabled={ok}
				title={tip}
				className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10px] ${
					ok ? "text-emerald-400/90" : "text-amber-300 hover:bg-amber-400/10"
				}`}
			>
				<span aria-hidden>{ok ? "●" : "▲"}</span>
				<span className="truncate">{summary}</span>
				{!ok ? (
					<span className="ml-auto shrink-0 text-white/35">{open ? "hide" : "why"}</span>
				) : null}
			</button>

			{open && !ok ? (
				<ul className="mt-1 space-y-1 pl-4 text-[10px] leading-relaxed text-white/60">
					{blockers.map((b) => (
						<li key={b.code} className="list-disc">
							{b.detail}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** The row flag: a small mark on the item a blocker points at. */
export function RowFlag({ blockers }: { blockers: Blocker[] }) {
	if (blockers.length === 0) return <span className="w-3" />;
	return (
		<span
			className="w-3 shrink-0 cursor-help text-center text-amber-300"
			title={blockers.map((b) => b.detail).join("\n\n")}
			aria-label={blockers.map((b) => b.short).join("; ")}
		>
			▲
		</span>
	);
}

export default MissionReadiness;
