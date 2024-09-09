import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";

import * as Cesium from "cesium";
import { Viewer, Cartesian3, JulianDate } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import { Satellite } from "@/services/Satellite";
import { $statesStore } from "@/stores/states.store";
import { $viewerStore } from "@/stores/cesium.store";

export default function Test() {
	const $states = useStore($statesStore);
	const $viewer = useStore($viewerStore);

	const stateRef = useRef<number>(0);
	const satelliteRef = useRef<Satellite>(); // Ref to store the Satellite instance
	const startJulianDateRef = useRef<JulianDate>(); // Ref to store the Julian start date

	// Initialize Cesium Viewer and Satellite only once on component mount
	useEffect(() => {
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

		// Set up satellite
		const satellite = new Satellite([7641.8, 0.00000001, 100.73, 0, 0, 90]);
		satelliteRef.current = satellite;
		satellite.init();

		// Set up initial Julian Date
		startJulianDateRef.current = JulianDate.fromDate(new Date(2024, 2, 20, 0, 0, 0)); // March 20, 2024
		viewer.clock.startTime = startJulianDateRef.current.clone();
		viewer.clock.currentTime = startJulianDateRef.current.clone();

		// Cleanup Cesium Viewer on component unmount
		return () => {
			if ($viewer && $viewer.isDestroyed()) {
				$viewer.destroy();
			}
		};
	}, []);

	// Effect to handle animation logic
	useEffect(() => {
		const viewer = $viewer;
		if (viewer && startJulianDateRef.current) {
			const t0 = JulianDate.toDate(startJulianDateRef.current).getTime() / 1000; // Initial start time in seconds

			// Update or create polyline entity with updated positions
			viewer.entities.removeAll(); // Remove old entities before adding new ones

			viewer.entities.add({
				polyline: {
					positions: new Cesium.CallbackProperty((time, result) => {
						const currentTime = JulianDate.toDate(time).getTime() / 1000; // Current time in seconds
						const elapsedSeconds = currentTime - t0; // Time elapsed since start in seconds

						stateRef.current = Math.floor(elapsedSeconds);

						if (stateRef.current + 500 > $states.length && $states.length !== 0) {
							satelliteRef.current?.propagate(true);
						}

						// Ensure we don't go out of bounds of the states array
						const slicedStates = $states.slice(stateRef.current, stateRef.current + 500).map((state) => {
							const [x, y, z] = state;
							return Cartesian3.fromElements(x * 1000, y * 1000, z * 1000);
						});

						return slicedStates;
					}, false),
					width: 2,
					material: Cesium.Color.CYAN, // Orbit track color
				},
			});
		}
	}, [$states]); // Depend on $states updates

	return (
		<div id="cesiumContainer" className="h-screen w-screen" />
	);
}
