"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import {
	Cartesian3,
	CallbackProperty,
	CallbackPositionProperty,
	Color,
	Entity,
	HeadingPitchRoll,
	Matrix3,
	Matrix4,
	PolygonHierarchy,
	Quaternion,
	Transforms,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import { $aircraftStore, $trailStore, $targetTrailStore, $aircraftEntityStore } from "@/stores/aircraft.store";
import { $showTriad, $showHorizPlane } from "@/stores/viewControls.store";
import { TelemetryClient } from "@/services/telemetry";

// A usable horizontal fix: both defined, finite, and not the null-island (0,0)
// sentinel some glitch/uninitialized frames carry. Guarding on it keeps the model
// and setpoint marker from teleporting to (0,0) and dragging a line across.
function hasFix(lat?: number, lon?: number): boolean {
	return (
		lat !== undefined && lon !== undefined &&
		Number.isFinite(lat) && Number.isFinite(lon) &&
		(Math.abs(lat) > 1e-4 || Math.abs(lon) > 1e-4)
	);
}

// Live aircraft: a glTF model driven by MAVLink position + attitude, plus a
// flight-path trail. Entities read the store inside CallbackProperty so updates
// are smooth without re-adding entities. Mirrors the imperative-entity pattern
// in components/satellites/Satellite.tsx.
export default function Aircraft() {
	const $viewer = useStore($viewerStore);
	const entitiesRef = useRef<string[]>([]);

	// Debug overlays driven by the ViewControls panel via the store.
	const showTriad = useStore($showTriad);
	const showHorizPlane = useStore($showHorizPlane);

	const axesRef = useRef<Entity[]>([]);
	const horizPlaneRef = useRef<Entity | null>(null);

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
			if (!f || !hasFix(f.lat, f.lon) || f.alt === undefined) {
				return undefined;
			}
			return Cartesian3.fromDegrees(f.lon!, f.lat!, f.alt);
		}, false);

		// Fixed rotation that reconciles the glTF's authoring axes with Cesium's body
		// frame (heading, pitch, roll in degrees). Applied in the model's own frame so
		// it only reposes the rest attitude — it does not disturb roll/pitch dynamics.
		const CORRECTION = HeadingPitchRoll.fromDegrees(0, 90, 180);
		const correctionQuat = Quaternion.fromHeadingPitchRoll(CORRECTION);

		// Shared flight-frame orientation from live telemetry. This source has its
		// pitch and roll about swapped axes for our frame (a roll showed up as a
		// nose-pitch), so we feed pitch and roll into the swapped HPR slots. Model,
		// triad, and body-plane quad all use this ONE builder so they stay consistent.
		function flightQuat(position: Cartesian3, f: { yaw?: number; pitch?: number; roll?: number }): Quaternion {
			const hpr = new HeadingPitchRoll(f.yaw ?? 0, -(f.roll ?? 0), f.pitch ?? 0);
			return Transforms.headingPitchRollQuaternion(position, hpr);
		}

		// The aircraft orientation with the glTF stand-up correction applied.
		function currentOrientation(): Quaternion | undefined {
			const f = $aircraftStore.get();
			if (!f || !hasFix(f.lat, f.lon) || f.alt === undefined) {
				return undefined;
			}
			const position = Cartesian3.fromDegrees(f.lon!, f.lat!, f.alt);
			return Quaternion.multiply(flightQuat(position, f), correctionQuat, new Quaternion());
		}

		const orientationProp = new CallbackProperty(() => currentOrientation(), false);

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
				// Rendered at true real-world size (the glTF is in metres, ~7 m span),
				// so it grows/shrinks accurately with zoom. No minimumPixelSize clamp —
				// the yellow point below keeps it locatable when zoomed far out.
				uri: "/models/solar-airplane.glb",
				scale: 1.0,
			},
			// Chase-camera offset (east, north, up in local frame) used by trackedEntity.
			viewFrom: new Cartesian3(-600, 0, 250),
		});

		// Body-frame XYZ triad drawn from the flight orientation: X (red) = the frame's
		// forward, Y (green), Z (blue). The model's local axes live in this frame, so
		// it doubles as the reference to align the model correction against.
		const AXIS_LEN = 15; // metres
		const bodyRot = () => {
			const f = $aircraftStore.get();
			if (!f || !hasFix(f.lat, f.lon) || f.alt === undefined) return undefined;
			const position = Cartesian3.fromDegrees(f.lon!, f.lat!, f.alt);
			return { position, rot: Matrix3.fromQuaternion(flightQuat(position, f), new Matrix3()) };
		};
		function axisLine(axis: Cartesian3, color: Color): Entity {
			return $viewer!.entities.add({
				polyline: {
					width: 3,
					material: color,
					positions: new CallbackProperty(() => {
						const b = bodyRot();
						if (!b) return undefined;
						const dir = Matrix3.multiplyByVector(b.rot, axis, new Cartesian3());
						const tip = Cartesian3.add(
							b.position,
							Cartesian3.multiplyByScalar(dir, AXIS_LEN, new Cartesian3()),
							new Cartesian3(),
						);
						return [b.position, tip];
					}, false),
				},
			});
		}
		const axisX = axisLine(new Cartesian3(1, 0, 0), Color.RED);
		const axisY = axisLine(new Cartesian3(0, 1, 0), Color.GREEN);
		const axisZ = axisLine(new Cartesian3(0, 0, 1), Color.BLUE);
		axesRef.current = [axisX, axisY, axisZ];

		// The LOCAL (world) horizontal plane: a quad in the east-north plane at the
		// aircraft position — always level, regardless of attitude. Comparing the body
		// axes against this level reference shows the aircraft's pitch and bank.
		const PLANE_HALF = 12; // metres, half-extent of the quad
		const horizPlaneCorners = () => {
			const f = $aircraftStore.get();
			if (!f || !hasFix(f.lat, f.lon) || f.alt === undefined) return undefined;
			const position = Cartesian3.fromDegrees(f.lon!, f.lat!, f.alt);
			const enu = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3());
			const east = Matrix3.getColumn(enu, 0, new Cartesian3());
			const north = Matrix3.getColumn(enu, 1, new Cartesian3());
			const corner = (se: number, sn: number) => {
				const p = Cartesian3.clone(position, new Cartesian3());
				Cartesian3.add(p, Cartesian3.multiplyByScalar(east, se * PLANE_HALF, new Cartesian3()), p);
				Cartesian3.add(p, Cartesian3.multiplyByScalar(north, sn * PLANE_HALF, new Cartesian3()), p);
				return p;
			};
			return [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
		};
		const horizPlane = $viewer.entities.add({
			polygon: {
				hierarchy: new CallbackProperty(() => {
					const c = horizPlaneCorners();
					return c ? new PolygonHierarchy(c) : undefined;
				}, false),
				perPositionHeight: true,
				material: Color.WHITE.withAlpha(0.15),
				outline: true,
				outlineColor: Color.WHITE.withAlpha(0.7),
			},
		});
		horizPlaneRef.current = horizPlane;

		const trail = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => $trailStore.get(), false),
				width: 2,
				material: Color.CYAN.withAlpha(0.8),
			},
		});

		// "What the autopilot wants": the commanded position-setpoint path
		// (POSITION_TARGET_GLOBAL_INT), overlaid in orange against the cyan actual
		// track. In a healthy loiter these coincide as one closed circle; divergence
		// between them is exactly the tracking/control error to look for.
		const targetTrail = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => $targetTrailStore.get(), false),
				width: 2,
				material: Color.ORANGE.withAlpha(0.9),
			},
		});

		// Marker at the current setpoint — the single point PX4 is steering toward.
		const targetPoint = $viewer.entities.add({
			position: new CallbackPositionProperty(() => {
				const f = $aircraftStore.get();
				if (!f || !hasFix(f.targetLat, f.targetLon) || f.alt === undefined) {
					return undefined;
				}
				return Cartesian3.fromDegrees(f.targetLon!, f.targetLat!, f.alt);
			}, false),
			point: {
				pixelSize: 9,
				color: Color.ORANGE,
				outlineColor: Color.BLACK,
				outlineWidth: 1,
			},
		});

		entitiesRef.current = [
			model.id, trail.id, targetTrail.id, targetPoint.id,
			axisX.id, axisY.id, axisZ.id, horizPlane.id,
		];
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
			axesRef.current = [];
			horizPlaneRef.current = null;
			entitiesRef.current.forEach((id) => $viewer.entities.removeById(id));
			entitiesRef.current = [];
		};
	}, [$viewer]);

	// Sync overlay visibility with the ViewControls toggles.
	useEffect(() => {
		axesRef.current.forEach((e) => (e.show = showTriad));
		$viewer?.scene.requestRender();
	}, [showTriad, $viewer]);
	useEffect(() => {
		if (horizPlaneRef.current) horizPlaneRef.current.show = showHorizPlane;
		$viewer?.scene.requestRender();
	}, [showHorizPlane, $viewer]);

	return null;
}
