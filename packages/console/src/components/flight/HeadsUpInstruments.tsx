"use client";

import { useStore } from "@nanostores/react";

import { $hudFrame } from "@/stores/aircraft.store";
import { AttitudeIndicator } from "./AttitudeIndicator";
import { Compass } from "./Compass";

// The two instruments that stay on screen at all times, drawn bare.
//
// Everything else is behind the dock, because a panel is a hole in the map. These
// two earn their pixels: attitude and heading are the readings you must not have
// to click for, and they are pictures rather than numbers, so no amount of
// bottom-strip real estate replaces them. No border, no backdrop, no title —
// the globe shows through around them.
export function HeadsUpInstruments() {
	const f = useStore($hudFrame);
	return (
		<div className="pointer-events-none flex items-center gap-2 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
			<AttitudeIndicator roll={f?.roll ?? 0} pitch={f?.pitch ?? 0} size={64} />
			<Compass heading={f?.heading ?? 0} size={64} />
		</div>
	);
}

export default HeadsUpInstruments;
