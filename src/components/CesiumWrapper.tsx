import { useEffect } from "react";
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

import envs from "../services/config";
import { propagate } from "../services/api";


export default function Test() {
	useEffect(() => {
		console.log(envs.CESIUM_KEY)
		Ion.defaultAccessToken = envs.CESIUM_KEY;

		const viewer = new Viewer("cesiumContainer", {
			terrain: Terrain.fromWorldTerrain(),
		});

		// const viewer = new CesiumWidget("cesiumContainer", {
		// });
		// Array.from(document.getElementsByClassName('cesium-widget-credits') as HTMLCollectionOf<HTMLElement>)[0].style.display = 'none';

		// Usage example
		propagate(Date.now(), [7000, 0.01, 98.6, 0, 0, 0], 60, 60)
			.then(response => {
				console.log("API Response:", response);
			})
			.catch(error => {
				console.error("API Error:", error);
			});
	}, [])

	return (
		<div id="cesiumContainer" className="h-screen w-screen">



		</div>
	)
}