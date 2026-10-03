"use client";

import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";

import { $showTriad, $showHorizPlane } from "@/stores/viewControls.store";
import { $aircraftEntityStore } from "@/stores/aircraft.store";
import { $viewerStore } from "@/stores/cesium.store";

// Scene-inspection controls (right rail, under the Telemetry panel). Toggles the
// debug overlays; state lives in viewControls.store so the Aircraft component can
// drive the Cesium entities.
export default function ViewControls() {
	const showTriad = useStore($showTriad);
	const showHorizPlane = useStore($showHorizPlane);
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
			</div>
		</div>
	);
}
