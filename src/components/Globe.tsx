import { useState, useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";

import * as Cesium from "cesium";
import {
	Viewer,
	Cartesian3,
	JulianDate
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import { Satellite } from "@/services/Satellite";
import { $statesStore } from "@/stores/states.store";


export default function Test() {
	const $states = useStore($statesStore);
	const viewerRef = useRef<Viewer>(); // Ref to store the Cesium viewer instance
	const satelliteRef = useRef<Satellite>(); // Ref to store the Satellite instance

	useEffect(() => {
		// Setting up Cesium
		viewerRef.current = new Viewer("cesiumContainer");

		// Set up satellite
		const satellite = new Satellite([7641.80, 0.00000001, 100.73, 0, 0, 90]);
		satelliteRef.current = satellite;
		satellite.init();

		// Cleanup Cesium
		return () => {
			if (viewerRef.current && !viewerRef.current.isDestroyed()) {
				viewerRef.current.destroy();
			}
		};
	}, []);

	const [positions, setPositions] = useState<Cartesian3[]>([]); // State to store Cartesian positions


	useEffect(() => {
		const viewer = viewerRef.current;

		if (viewer) {
			const start = JulianDate.fromDate(new Date(2024, 2, 20, 0, 0, 0)); // March 20, 2024
			const end = JulianDate.addHours(start, 2, new JulianDate()); // Orbit duration of 2 hours
			viewer.clock.startTime = start.clone();
			viewer.clock.stopTime = end.clone();
			viewer.clock.currentTime = start.clone();
			viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP; // Loop at the end

			const t0 = JulianDate.toDate(start).getTime() / 1000; // Initial start time in seconds

			const polylineEntity = viewer.entities.add({
				polyline: {
					positions: new Cesium.CallbackProperty((time, result) => {
						const currentTime = JulianDate.toDate(time).getTime() / 1000; // Current time in seconds
                        const elapsedSeconds = currentTime - t0; // Time elapsed since start in seconds

                        // Calculate the start index based on the elapsed time in 500-second increments
                        const startIndex = Math.floor(elapsedSeconds);
                        const endIndex = startIndex + 500; // Increment by 500 seconds

                        // Ensure we don't go out of bounds of the states array
                        const slicedStates = $states.slice(startIndex, endIndex).map((state) => {
                            const [x, y, z] = state;
                            return Cartesian3.fromElements(x * 1000, y * 1000, z * 1000);
                        });

                        return slicedStates;
					}, false),
					width: 2,
					material: Cesium.Color.CYAN, // Orbit track color
				}
			});
		}

	}, [$states]);

	// // Drawing satellite states on the globe.
	// useEffect(() => {
	// 	const viewer = viewerRef.current;
	// 	const satellite = satelliteRef.current;

	// 	if (satellite && satellite.states.length > 0) {
	// 		const states = satellite.states
	// 		console.log(states)






	// 		// let yo = 101;




	// 	}
	// }, [satelliteRef.current && satelliteRef.current.states]);




	// const viewer = viewerRef.current;
	// console.log("Updating viewer with new states:", $states);

	// const position = new Cesium.SampledPositionProperty(Cesium.ReferenceFrame.FIXED);



	// // Define the start and end time for the orbit
	// const start = Cesium.JulianDate.fromDate(new Date(2024, 2, 20, 0, 0, 0)); // Example start date
	// const end = Cesium.JulianDate.addHours(start, 2, new Cesium.JulianDate()); // Orbit duration of 2 hours
	// viewer.clock.startTime = start.clone();
	// viewer.clock.stopTime = end.clone();
	// viewer.clock.currentTime = start.clone();
	// viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP; // Loop at the end
	// viewer.clock.multiplier = 60; // Speed up the simulation


	// const orbitPositions = []; // Array to store the Cartesian positions for the polyline


	// for (let i = 0; i < 500; i += 1) {
	// 	const time = Cesium.JulianDate.addSeconds(start, i, new Cesium.JulianDate());
	// 	console.log($states[i])
	// 	const x = $states[i][0] * 1000;
	// 	const y = $states[i][1] * 1000;
	// 	const z = $states[i][2] * 1000;
	// 	const positionCartesian = Cesium.Cartesian3.fromElements(x, y, z);
	// 	position.addSample(time, positionCartesian);
	// 	position.add
	// 	orbitPositions.push(positionCartesian);
	// 	satelliteRef.current.incrementIndex();
	// }

	// // Create the entity representing the orbiting object
	// const satellite = viewer.entities.add({
	// 	position: position,
	// 	point: {
	// 		pixelSize: 10,
	// 		color: Cesium.Color.YELLOW,
	// 	},
	// 	path: {
	// 		resolution: 1,
	// 		material: new Cesium.PolylineGlowMaterialProperty({
	// 			glowPower: 0.1,
	// 			color: Cesium.Color.YELLOW,
	// 		}),
	// 		width: 2,
	// 	}
	// });

	// viewer.entities.add({
	// 	polyline: {
	// 		positions: orbitPositions,
	// 		width: 2,
	// 		material: Cesium.Color.CYAN, // Orbit track color
	// 	}
	// });


	// $states.forEach((state) => {
	// 	const [x, y, z] = state;
	// 	viewer.entities.add({
	// 		polyline: {

	// 		}
	// 		position: Cartesian3.fromElements(x * 1000, y * 1000, z * 1000),
	// 		point: { pixelSize: 5, color: Color.WHITE },
	// 	});
	// });


	return (
		<div
			id="cesiumContainer"
			className="h-screen w-screen"
		/>
	)
}