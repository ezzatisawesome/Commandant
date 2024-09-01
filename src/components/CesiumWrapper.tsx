import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import {
	Cartesian3,
	CesiumWidget,
	Color,
	Ion,
	Terrain,
	Viewer,
	JulianDate,
	SampledPositionProperty,
	TimeIntervalCollection,
	TimeInterval,
	PathGraphics
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import envs from "../lib/config";
import { propagate } from "../services/api";


export default function Test() {
	useEffect(() => {
		const asyncWrapper = async () => {
			Ion.defaultAccessToken = envs.CESIUM_KEY;
			const viewer = new Viewer("cesiumContainer");
			// (viewer.creditDisplay.container as HTMLElement).style.display = "none";

			const results = await propagate(0, [7641.80, 0.00000001, 100.73, 0, 0, 90], 36000, 1)
			const satelliteStates = results.statesSat

			for (let i = 0; i < satelliteStates.length; i++) {
				const dataPoint = satelliteStates[i];

				viewer.entities.add({
					position: Cartesian3.fromElements(dataPoint[0]*1000, dataPoint[1]*1000, dataPoint[2]*1000),
					point: { pixelSize: 1, color: Color.RED }
				});
			}
		}

		asyncWrapper()
	}, [])

	return (
		<div id="cesiumContainer" className="h-screen w-screen" />
	)
}