"use client";

import { useStore } from "@nanostores/react";

import { $replay } from "@/stores/replay.store";

// Deliberately the loudest thing on screen, and deliberately not dismissible.
//
// A replay drives every instrument with real numbers from a real flight, which
// is what makes it useful and what makes it dangerous: the HUD, the globe, the
// health strip and the mission panel are all telling the truth about a moment
// that has already passed. The one piece of information that cannot be left to
// inference is WHICH moment. Commands are refused by gs during a replay — there
// is no vehicle to send them to — but an operator should know before they try,
// not after.
export default function ReplayBanner() {
	const replaying = useStore($replay);
	if (!replaying) return null;

	return (
		<div className="pointer-events-none fixed left-0 right-0 top-0 z-[70]
			border-b border-amber-400/50 bg-amber-500/20 py-1 text-center
			text-[11px] font-semibold uppercase tracking-widest text-amber-200
			backdrop-blur">
			replay — recorded flight, not live
		</div>
	);
}
