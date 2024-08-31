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

		const viewer = new CesiumWidget("cesiumContainer");
		(viewer.creditDisplay.container as HTMLElement).style.display = "none";
	}, [])

	return (
		<div id="cesiumContainer" className="h-screen w-screen">



		</div>
	)
}