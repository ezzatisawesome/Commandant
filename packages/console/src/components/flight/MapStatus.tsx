"use client";

import { useStore } from "@nanostores/react";

import { $mapImagery, $mapTerrain } from "@/stores/map.store";

// The hub runs an isolated WiFi network on a flight line, so the map's imagery
// (ArcGIS) and terrain (Cesium Ion) -- both fetched over the internet -- simply
// do not load there. Before this they failed silently and the operator got a
// blank sphere, which reads as a broken console rather than an unreachable map.
//
// Everything Commandant itself draws comes from telemetry in geographic
// coordinates and is unaffected, which is the part worth saying out loud.
export default function MapStatus() {
	const imagery = useStore($mapImagery);
	const terrain = useStore($mapTerrain);
	if (imagery !== "unavailable" && terrain !== "unavailable") return null;

	const what = imagery === "unavailable" && terrain === "unavailable"
		? "Map imagery and terrain"
		: imagery === "unavailable" ? "Map imagery" : "Map terrain";

	return (
		<div className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2
			rounded border border-white/10 bg-black/70 px-3 py-1.5 text-[10px]
			text-white/60 backdrop-blur">
			{what} could not be loaded — this hub has no internet. The aircraft,
			its track, the mission and the geofence are still drawn to scale.
		</div>
	);
}
