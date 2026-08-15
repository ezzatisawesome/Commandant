"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import {
	Cartesian3,
	CallbackProperty,
	CallbackPositionProperty,
	Color,
	HeadingPitchRoll,
	Transforms,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import { $aircraftStore, $trailStore, $aircraftEntityStore } from "@/stores/aircraft.store";
import { TelemetryClient } from "@/services/telemetry";

// Live aircraft: a glTF model driven by MAVLink position + attitude, plus a
// flight-path trail. Entities read the store inside CallbackProperty so updates
// are smooth without re-adding entities. Mirrors the imperative-entity pattern
// in components/satellites/Satellite.tsx.
export default function Aircraft() {
	const $viewer = useStore($viewerStore);
	const entitiesRef = useRef<string[]>([]);

	// Open the telemetry stream once.
	useEffect(() => {
		const client = new TelemetryClient();
		client.connect();
		return () => client.disconnect();
	}, []);

	useEffect(() => {
		if (!$viewer) return;

		entitiesRef.current.forEach((id) => $viewer.entities.removeById(id));

		const positionProp = new CallbackPositionProperty(() => {
			const f = $aircraftStore.get();
			if (!f || f.lat === undefined || f.lon === undefined || f.alt === undefined) {
				return undefined;
			}
			return Cartesian3.fromDegrees(f.lon, f.lat, f.alt);
		}, false);

		const orientationProp = new CallbackProperty(() => {
			const f = $aircraftStore.get();
			if (!f || f.lat === undefined || f.lon === undefined || f.alt === undefined) {
				return undefined;
			}
			const position = Cartesian3.fromDegrees(f.lon, f.lat, f.alt);
			const hpr = new HeadingPitchRoll(f.yaw ?? 0, f.pitch ?? 0, f.roll ?? 0);
			return Transforms.headingPitchRollQuaternion(position, hpr);
		}, false);

		const model = $viewer.entities.add({
			position: positionProp,
			orientation: orientationProp,
			// Always-visible marker: the plane shows even if the glTF fails to load,
			// and it gives the entity a real bounding sphere for camera framing.
			point: {
				pixelSize: 12,
				color: Color.YELLOW,
				outlineColor: Color.BLACK,
				outlineWidth: 1,
			},
			model: {
				uri: "/models/solar-airplane.glb",
				minimumPixelSize: 64,
				maximumScale: 20000,
			},
			// Chase-camera offset (east, north, up in local frame) used by trackedEntity.
			viewFrom: new Cartesian3(-600, 0, 250),
		});

		const trail = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => $trailStore.get(), false),
				width: 2,
				material: Color.CYAN.withAlpha(0.8),
			},
		});

		entitiesRef.current = [model.id, trail.id];
		$aircraftEntityStore.set(model);

		// Fly to the aircraft once, on the first position fix. camera.flyTo to the
		// actual coordinates is reliable (no dependency on the model loading).
		let flown = false;
		const unsubscribe = $aircraftStore.subscribe((f) => {
			if (flown || !f || f.lat === undefined || f.lon === undefined || f.alt === undefined) {
				return;
			}
			flown = true;
			$viewer.camera.flyTo({
				destination: Cartesian3.fromDegrees(f.lon, f.lat, f.alt + 1200),
				duration: 1.5,
			});
		});

		return () => {
			unsubscribe();
			$aircraftEntityStore.set(null);
			entitiesRef.current.forEach((id) => $viewer.entities.removeById(id));
			entitiesRef.current = [];
		};
	}, [$viewer]);

	return null;
}
