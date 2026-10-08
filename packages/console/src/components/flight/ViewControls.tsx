"use client";

import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";

import {
	$showTriad, $showHorizPlane, $showClearance, $showWind, $showSun,
} from "@/stores/viewControls.store";
import { $aircraftEntityStore } from "@/stores/aircraft.store";
import { $viewerStore } from "@/stores/cesium.store";

// Scene-inspection controls (right rail, under the Telemetry panel). Toggles the
// debug overlays; state lives in viewControls.store so the Aircraft component can
// drive the Cesium entities.
export default function ViewControls() {
	const showTriad = useStore($showTriad);
	const showHorizPlane = useStore($showHorizPlane);
	const showClearance = useStore($showClearance);
	const showWind = useStore($showWind);
	const showSun = useStore($showSun);
	// Follow (chase camera): the aircraft entity carries a `viewFrom` offset, so
	// setting it as Cesium's trackedEntity gives a follow cam. The built-in track
	// button lives in the InfoBox, which is disabled on this viewer — so drive it
	// explicitly here. Re-applies if the entity is (re)created while following.
	const entity = useStore($aircraftEntityStore);
	const [follow, setFollow] = useState(false);
	useEffect(() => {
		const viewer = $viewerStore.get();
		if (!viewer || viewer.isDestroyed()) return;
		viewer.trackedEntity = follow ? (entity ?? undefined) : undefined;
		return () => {
			if (viewer && !viewer.isDestroyed()) viewer.trackedEntity = undefined;
		};
	}, [follow, entity]);

	return (
		<div className="w-64 rounded-md border border-white/10 bg-black/60 p-3 text-xs text-white backdrop-blur">
			<div className="mb-2 text-[10px] uppercase tracking-wide text-white/50">View</div>
			<div className="flex flex-col gap-1.5">
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={follow}
						disabled={!entity}
						onChange={(e) => setFollow(e.target.checked)}
					/>
					Follow aircraft (chase cam)
				</label>
				<label className="flex items-center gap-2">
					<input type="checkbox" checked={showTriad} onChange={(e) => $showTriad.set(e.target.checked)} />
					Body axes (triad)
				</label>
				<label className="flex items-center gap-2">
					<input type="checkbox" checked={showHorizPlane} onChange={(e) => $showHorizPlane.set(e.target.checked)} />
					Horizontal plane (white)
				</label>

				{/* Situation overlays. Each is opt-in because the globe has a finite
				    budget of attention, and each uses shape or the vertical axis
				    rather than a new colour — cyan/orange/white/yellow/green/red are
				    already spoken for by the track, plan and fence. */}
				<div className="mt-1 border-t border-white/10 pt-1 text-[10px] uppercase tracking-wide text-white/40">
					Situation
				</div>
				<label className="flex items-center gap-2" title="Vertical line to the terrain below, coloured by clearance">
					<input type="checkbox" checked={showClearance} onChange={(e) => $showClearance.set(e.target.checked)} />
					Terrain clearance
				</label>
				<label className="flex items-center gap-2" title="Arrow pointing the way the wind blows, scaled by speed">
					<input type="checkbox" checked={showWind} onChange={(e) => $showWind.set(e.target.checked)} />
					Wind vector
				</label>
				<label className="flex items-center gap-2" title="Ray toward the sun; hidden at night">
					<input type="checkbox" checked={showSun} onChange={(e) => $showSun.set(e.target.checked)} />
					Sun vector
				</label>
			</div>
		</div>
	);
}
