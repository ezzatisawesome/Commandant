import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import { Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import { $viewerStore } from "@/stores/cesium.store";
import { $satStore } from "@/stores/sat.store";
import { $timeStore } from "@/stores/states.store";
import Satellite from "./Satellite";


export default function Test() {
	const $viewer = useStore($viewerStore);
	const $sats = useStore($satStore);
	const $time = useStore($timeStore);

	useEffect(() => {
		// Initialize Cesium Viewer.
		const viewer = new Viewer("cesiumContainer", {
			timeline: false,
			geocoder: false, // Search button
			homeButton: false,
			navigationHelpButton: false,
			baseLayerPicker: false, // Imagery layer picker
			sceneModePicker: false, // Need this functionality
			animation: false,
			fullscreenButton: false,
		});
		viewer.creditDisplay.container.style.display = "none"; // Hide Cesium logo
		$viewerStore.set(viewer);

		// Set up clock.
		viewer.clock.startTime = $time.clone();
		viewer.clock.currentTime = $time.clone();

		// Cleanup Cesium Viewer on component unmount
		return () => {
			if ($viewer && $viewer.isDestroyed()) {
				$viewer.destroy();
			}
		};
	}, []);

	return (
		<div id="cesiumContainer" className="h-screen w-screen">
			{
				$sats.map((s) => (
					<Satellite key={s._id} id={s._id} />
				))
			}
		</div>
	);
}
