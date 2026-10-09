"use client";

import { useState, type ReactNode } from "react";

// Tabs inside one dock panel.
//
// Two icons for mission and geofence, or for parameters and airframe, spend a
// permanent slot in the gutter on things that are the same job: authoring the
// geometry the vehicle flies, and configuring the vehicle. The dock's rule is
// one panel at a time, so a second icon never let you see both anyway — it only
// made the operator remember which of two icons held the thing they wanted.
// Tabs put that choice inside the panel, where the labels are words.

export interface PanelTab {
	key: string;
	label: string;
	content: ReactNode;
}

export function PanelTabs({ tabs }: { tabs: PanelTab[] }) {
	const [active, setActive] = useState(tabs[0]?.key);
	const current = tabs.find((t) => t.key === active) ?? tabs[0];

	return (
		<div className="flex flex-col">
			<div role="tablist" className="mb-2 flex gap-1 border-b border-white/10 pb-2">
				{tabs.map((t) => (
					<button
						key={t.key}
						role="tab"
						aria-selected={t.key === current?.key}
						onClick={() => setActive(t.key)}
						className={`rounded px-2 py-1 text-[10px] uppercase tracking-wide ${
							t.key === current?.key
								? "bg-white/15 text-white"
								: "text-white/45 hover:bg-white/10 hover:text-white"
						}`}
					>
						{t.label}
					</button>
				))}
			</div>
			<div role="tabpanel">{current?.content}</div>
		</div>
	);
}

export default PanelTabs;
