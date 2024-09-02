import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import {
	Viewer,
	Cartesian3,
	Color
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import { Satellite } from "@/services/Satellite";
import { $statesStore } from "@/stores/states.store";


export default function Test() {
	const viewerRef = useRef<Viewer>(); // Ref to store the Cesium viewer instance
	const $states = useStore($statesStore);

	// Setting up Cesium
	useEffect(() => {
		viewerRef.current = new Viewer("cesiumContainer");

		return () => {
			if (viewerRef.current && !viewerRef.current.isDestroyed()) {
				viewerRef.current.destroy();
			}
		};
	}, []);

	useEffect(() => {
		const satellite = new Satellite([7641.80, 0.00000001, 100.73, 0, 0, 90]);
		satellite.init();
	}, []);

	// Drawing satellite states on the globe.
	useEffect(() => {
		if (viewerRef.current) {
			const viewer = viewerRef.current;
			console.log("Updating viewer with new states:", $states);

			$states.forEach((state) => {
				const [x, y, z] = state;
				viewer.entities.add({
					position: Cartesian3.fromElements(x * 1000, y * 1000, z * 1000),
					point: { pixelSize: 10, color: Color.RED },
				});
			});
		}
	}, [$states]);

	return (
		<div
			id="cesiumContainer"
			className="h-screen w-screen"
		/>
	)
}