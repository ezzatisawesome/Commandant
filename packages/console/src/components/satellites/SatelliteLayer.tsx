"use client";

import { useStore } from "@nanostores/react";

import { $satStore } from "@/stores/sat.store";
import Satellite from "./Satellite";

// Renders one imperative Satellite entity per stored orbit. Each <Satellite>
// returns null and adds its entities to the shared Cesium viewer, so this layer
// only needs to exist alongside <Globe/>.
export default function SatelliteLayer() {
	const $sats = useStore($satStore);
	return (
		<>
			{$sats.map((s) => (
				<Satellite key={s._id} id={s._id} />
			))}
		</>
	);
}
