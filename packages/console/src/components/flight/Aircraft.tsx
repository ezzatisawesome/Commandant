"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import {
	ArcType,
	Cartesian2,
	Cartesian3,
	Cartographic,
	CallbackProperty,
	CallbackPositionProperty,
	Color,
	Entity,
	HeadingPitchRoll,
	Math as CesiumMath,
	Matrix3,
	Matrix4,
	PolygonHierarchy,
	Quaternion,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
	Transforms,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import {
	$aircraftStore, $trailChunks, $trailTail, $targetChunks, $targetTail,
	$aircraftEntityStore, hasFix, isNum,
} from "@/stores/aircraft.store";
import { $showTriad, $showHorizPlane } from "@/stores/viewControls.store";
import { $linkState } from "@/stores/link.store";
import { pushStatus } from "@/stores/statustext.store";
import { telemetryClient } from "@/services/telemetry";
import { IS_VIEW } from "@/lib/envs";

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

	// Open the telemetry stream once (shared singleton, so the command controls
	// send over the same socket).
	useEffect(() => {
		telemetryClient.connect();
		return () => telemetryClient.disconnect();
	}, []);

	useEffect(() => {
		if (!$viewer) return;

		entitiesRef.current.forEach((id) => $viewer.entities.removeById(id));

		const positionProp = new CallbackPositionProperty(() => {
			const f = $aircraftStore.get();
			if (!f || !hasFix(f.lat, f.lon) || !isNum(f.alt)) {
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
			if (!f || !hasFix(f.lat, f.lon) || !isNum(f.alt)) {
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
			if (!f || !hasFix(f.lat, f.lon) || !isNum(f.alt)) return undefined;
			const position = Cartesian3.fromDegrees(f.lon!, f.lat!, f.alt);
			return { position, rot: Matrix3.fromQuaternion(flightQuat(position, f), new Matrix3()) };
		};
		function axisLine(axis: Cartesian3, color: Color): Entity {
			return $viewer!.entities.add({
				polyline: {
					width: 3,
					material: color,
					arcType: ArcType.NONE,
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
			if (!f || !hasFix(f.lat, f.lon) || !isNum(f.alt)) return undefined;
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

		// The flight path is drawn as FROZEN CHUNKS plus one short active tail.
		//
		// MEASURED: a polyline whose positions array reference changes re-uploads
		// its whole vertex buffer. One 3000-point trail at 6.3 changes/s is 17,500
		// points/s — 420 KB/s, forever. Chunks never change after they close, so
		// each is uploaded once as STATIC geometry (a plain array, not a
		// CallbackProperty, so Cesium's dynamic updater never touches it), and only
		// the <=250-point tail is re-uploaded. Measured 22x less vertex traffic.
		//
		// ArcType.NONE on all of them: consecutive fixes are metres apart, so
		// geodesic subdivision is pure cost.
		const chunkEntities: Entity[] = [];
		const syncChunks = (chunks: readonly Cartesian3[][]) => {
			// Add an entity for each chunk that does not have one yet.
			while (chunkEntities.length < chunks.length) {
				const idx = chunkEntities.length;
				chunkEntities.push($viewer.entities.add({
					polyline: {
						positions: chunks[idx] as Cartesian3[],  // static: uploaded once, never again
						width: 2,
						material: Color.CYAN.withAlpha(0.8),
						arcType: ArcType.NONE,
					},
				}));
			}
			// Drop entities for chunks that aged out of the cap.
			while (chunkEntities.length > chunks.length) {
				const e = chunkEntities.pop();
				if (e) $viewer.entities.remove(e);
			}
			$viewer.scene.requestRender();
		};
		syncChunks($trailChunks.get());
		const unsubChunks = $trailChunks.subscribe(syncChunks);

		const trail = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => $trailTail.get(), false),
				width: 2,
				material: Color.CYAN.withAlpha(0.8),
				arcType: ArcType.NONE,
			},
		});

		// "What the autopilot wants": the commanded position-setpoint path
		// (POSITION_TARGET_GLOBAL_INT), overlaid in orange against the cyan actual
		// track. In a healthy loiter these coincide as one closed circle; divergence
		// between them is exactly the tracking/control error to look for.
		// Same frozen-chunk treatment as the flown path: the commanded path grows
		// at the same rate and had the same O(trail) re-upload cost.
		const targetChunkEntities: Entity[] = [];
		const syncTargetChunks = (chunks: readonly Cartesian3[][]) => {
			while (targetChunkEntities.length < chunks.length) {
				const idx = targetChunkEntities.length;
				targetChunkEntities.push($viewer.entities.add({
					polyline: {
						positions: chunks[idx] as Cartesian3[],
						width: 2,
						material: Color.ORANGE.withAlpha(0.9),
						arcType: ArcType.NONE,
					},
				}));
			}
			while (targetChunkEntities.length > chunks.length) {
				const e = targetChunkEntities.pop();
				if (e) $viewer.entities.remove(e);
			}
			$viewer.scene.requestRender();
		};
		syncTargetChunks($targetChunks.get());
		const unsubTargetChunks = $targetChunks.subscribe(syncTargetChunks);

		const targetTrail = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => $targetTail.get(), false),
				width: 2,
				material: Color.ORANGE.withAlpha(0.9),
				arcType: ArcType.NONE,
			},
		});

		// Marker at the current setpoint — the single point PX4 is steering toward.
		const targetPoint = $viewer.entities.add({
			position: new CallbackPositionProperty(() => {
				const f = $aircraftStore.get();
				if (!f || !hasFix(f.targetLat, f.targetLon) || !isNum(f.alt)) {
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

		// "Fly to here": double-click the globe to command a reposition to that
		// point (PX4 fixed-wing loiters there). Double-click so it doesn't fight
		// normal drag/zoom. Only acts while the link is alive; gs enforces
		// commander/authority and replies with an ack we surface in the status log.
		const clickHandler = new ScreenSpaceEventHandler($viewer.scene.canvas);
		clickHandler.setInputAction((movement: { position: Cartesian2 }) => {
			if (IS_VIEW) return;  // the viewer never commands a reposition
			if ($linkState.get() !== "alive") return;
			const cart = $viewer.camera.pickEllipsoid(
				movement.position,
				$viewer.scene.globe.ellipsoid,
			);
			if (!cart) return;
			const geo = Cartographic.fromCartesian(cart);
			const lat = CesiumMath.toDegrees(geo.latitude);
			const lon = CesiumMath.toDegrees(geo.longitude);
			// Hold the aircraft's current altitude (the horizontal "go there" is the
			// intent; alt frame for FW reposition is the current amsl).
			const alt = $aircraftStore.get()?.alt ?? 0;
			pushStatus(6, `fly-to ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
			telemetryClient
				.sendCommand("reposition", { lat, lon, alt })
				.then((ack) => pushStatus(ack.ok ? 6 : 4, `reposition: ${ack.text}`))
				.catch((err) => pushStatus(4, `reposition failed: ${err instanceof Error ? err.message : "error"}`));
		}, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

		// Fly to the aircraft once, on the first position fix. camera.flyTo to the
		// actual coordinates is reliable (no dependency on the model loading).
		let flown = false;
		const unsubscribe = $aircraftStore.subscribe((f) => {
			if (flown || !f || !hasFix(f.lat, f.lon) || !isNum(f.alt)) {
				return;
			}
			flown = true;
			$viewer.camera.flyTo({
				destination: Cartesian3.fromDegrees(f.lon!, f.lat!, f.alt! + 1200),
				duration: 1.5,
			});
		});

		return () => {
			unsubscribe();
			unsubChunks();
			unsubTargetChunks();
			chunkEntities.forEach((e) => $viewer.entities.remove(e));
			targetChunkEntities.forEach((e) => $viewer.entities.remove(e));
			chunkEntities.length = 0;
			targetChunkEntities.length = 0;
			clickHandler.destroy();
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
