"use client";

import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import {
	Cartesian2,
	Cartesian3,
	Cartographic,
	CallbackProperty,
	CallbackPositionProperty,
	Color,
	Entity,
	LabelStyle,
	Math as CesiumMath,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
	VerticalOrigin,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import {
	$missionItems,
	$missionCurrent,
	$missionReached,
	$missionEdit,
	addWaypoint,
	kindHasPosition,
	moveItemPosition,
} from "@/stores/mission.store";
import { $aircraftStore } from "@/stores/aircraft.store";

// Mission authoring + rendering on the globe. Draws the planned route as a white
// polyline through the positioned items with a numbered marker per item; the
// active item (MISSION_CURRENT) turns yellow and reached items dim green. In edit
// mode a left-click appends a waypoint at the clicked point, and any marker can be
// dragged to move its item. Kept separate from Aircraft.tsx so the plane overlay
// and the mission overlay own their own entities/handlers independently.
//
// Markers are drawn at the aircraft's current altitude (the plan's horizontal
// path is the intent; alt per item is edited in the table), matching how the
// setpoint overlay is placed in Aircraft.tsx.
export default function MissionLayer() {
	const $viewer = useStore($viewerStore);

	useEffect(() => {
		if (!$viewer) return;

		const markerAlt = () => $aircraftStore.get()?.alt ?? 0;

		// Route polyline through positioned items, live from the store.
		const route = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => {
					const pts = $missionItems.get()
						.filter((it) => kindHasPosition(it.kind) && it.lat !== undefined && it.lon !== undefined)
						.map((it) => Cartesian3.fromDegrees(it.lon!, it.lat!, markerAlt()));
					return pts.length >= 2 ? pts : undefined;
				}, false),
				width: 2,
				material: Color.WHITE.withAlpha(0.7),
			},
		});

		// One marker entity per positioned item. Rebuilt whenever the item list
		// changes structurally (add/remove/reorder); colors update live via the
		// current/reached stores without a rebuild.
		let markers: Entity[] = [];
		const rebuildMarkers = () => {
			markers.forEach((m) => $viewer.entities.remove(m));
			markers = [];
			for (const it of $missionItems.get()) {
				if (!kindHasPosition(it.kind) || it.lat === undefined || it.lon === undefined) continue;
				const seq = it.seq;
				const m = $viewer.entities.add({
					// id tags the marker so the drag handler can map a pick back to a seq.
					id: `mission-wp-${seq}`,
					position: new CallbackPositionProperty(() => {
						const cur = $missionItems.get().find((x) => x.seq === seq);
						if (!cur || cur.lat === undefined || cur.lon === undefined) return undefined;
						return Cartesian3.fromDegrees(cur.lon, cur.lat, markerAlt());
					}, false),
					point: {
						pixelSize: 12,
						color: new CallbackProperty(() => {
							if ($missionCurrent.get() === seq) return Color.YELLOW;
							const reached = $missionReached.get();
							if (reached !== null && seq <= reached) return Color.LIME.withAlpha(0.7);
							return Color.WHITE;
						}, false),
						outlineColor: Color.BLACK,
						outlineWidth: 1,
					},
					label: {
						text: `${seq}`,
						font: "12px monospace",
						fillColor: Color.BLACK,
						style: LabelStyle.FILL,
						verticalOrigin: VerticalOrigin.CENTER,
						pixelOffset: new Cartesian2(0, 0),
					},
				});
				markers.push(m);
			}
			$viewer.scene.requestRender();
		};
		rebuildMarkers();
		const unsubItems = $missionItems.subscribe(rebuildMarkers);

		// --- authoring: click to add, drag to move ---------------------------
		const handler = new ScreenSpaceEventHandler($viewer.scene.canvas);

		// Left-click appends a waypoint, but only in edit mode (otherwise it would
		// fight camera interaction). A drag-release also fires LEFT_CLICK, so skip
		// the add if we were dragging.
		let dragSeq: number | null = null;
		let didDrag = false;

		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (!$missionEdit.get() || didDrag) return;
			const cart = $viewer.camera.pickEllipsoid(m.position, $viewer.scene.globe.ellipsoid);
			if (!cart) return;
			const geo = Cartographic.fromCartesian(cart);
			addWaypoint(
				CesiumMath.toDegrees(geo.latitude),
				CesiumMath.toDegrees(geo.longitude),
				markerAlt(),
			);
		}, ScreenSpaceEventType.LEFT_CLICK);

		// Drag a marker: pick on LEFT_DOWN, move on MOUSE_MOVE, release on LEFT_UP.
		// Disable the camera controls while dragging so the globe doesn't pan.
		handler.setInputAction((m: { position: Cartesian2 }) => {
			const picked = $viewer.scene.pick(m.position);
			const id: unknown = picked?.id?.id;
			if (typeof id === "string" && id.startsWith("mission-wp-")) {
				dragSeq = Number(id.slice("mission-wp-".length));
				didDrag = false;
				$viewer.scene.screenSpaceCameraController.enableInputs = false;
			}
		}, ScreenSpaceEventType.LEFT_DOWN);

		handler.setInputAction((m: { endPosition: Cartesian2 }) => {
			if (dragSeq === null) return;
			const cart = $viewer.camera.pickEllipsoid(m.endPosition, $viewer.scene.globe.ellipsoid);
			if (!cart) return;
			const geo = Cartographic.fromCartesian(cart);
			didDrag = true;
			moveItemPosition(
				dragSeq,
				CesiumMath.toDegrees(geo.latitude),
				CesiumMath.toDegrees(geo.longitude),
			);
		}, ScreenSpaceEventType.MOUSE_MOVE);

		handler.setInputAction(() => {
			if (dragSeq !== null) {
				dragSeq = null;
				$viewer.scene.screenSpaceCameraController.enableInputs = true;
				// Clear the drag flag on the next tick so the trailing LEFT_CLICK is
				// still suppressed, but a later plain click adds normally.
				setTimeout(() => { didDrag = false; }, 0);
			}
		}, ScreenSpaceEventType.LEFT_UP);

		return () => {
			unsubItems();
			handler.destroy();
			markers.forEach((m) => $viewer.entities.remove(m));
			markers = [];
			$viewer.entities.remove(route);
			$viewer.scene.screenSpaceCameraController.enableInputs = true;
		};
	}, [$viewer]);

	return null;
}
