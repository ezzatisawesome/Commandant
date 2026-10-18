"use client";

import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import {
	ArcType,
	Cartesian2,
	Cartesian3,
	Cartographic,
	CallbackProperty,
	CallbackPositionProperty,
	Color,
	ColorMaterialProperty,
	Ellipsoid,
	EllipsoidGeodesic,
	Entity,
	HeightReference,
	LabelStyle,
	Math as CesiumMath,
	Matrix4,
	SceneTransforms,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
	Transforms,
	VerticalOrigin,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import { IS_VIEW } from "@/lib/envs";
import {
	$missionItems,
	$missionCurrent,
	$missionReached,
	$missionEdit,
	addWaypoint,
	kindHasPosition,
	moveItemPosition,
	updateItem,
} from "@/stores/mission.store";
import {
	ALT_SAMPLE_M,
	clampAlt,
	clampRadius,
	defaultRadius,
	radiusParamKey,
	snap,
	altDeltaFromDrag,
} from "@/lib/grabbers";
import { firstTaggedId, tagSeq } from "@/lib/pickTag";
import { $params } from "@/stores/params.store";
import { landingGeometry, landingSlopeLimit, lookupFrom, minLegalRunM } from "@/lib/missionCheck";
import { authoringAltM, drawHeightM, homeAltM } from "@/lib/altFrames";
import { ALT_HANDLE_MISSION, ALT_HANDLE_OFFSET_PX, ALT_HANDLE_PX } from "@/lib/altHandle";
import { $aircraftStore } from "@/stores/aircraft.store";
import type { MissionItem } from "@/types/app";

// Mission authoring + rendering on the globe. Draws the planned route as a white
// polyline through the positioned items with a numbered marker per item; the
// active item (MISSION_CURRENT) turns yellow and reached items dim green.
//
// Each waypoint is drawn AT ITS OWN ALTITUDE, standing on a vertical stem down
// to the terrain. Markers used to sit at the aircraft's current altitude, which
// made the plan look flat and left the one number that matters most — how high
// the aircraft will be at that point — editable only as a figure in a table. A
// stem makes the altitude a thing on screen, and a thing on screen can be
// grabbed.
//
// In edit mode each positioned item grows two grabbers:
//
//   ▲ vertical (above the marker)  drag up/down to set altitude. The drag is
//     resolved along the local vertical AS IT PROJECTS ON SCREEN, so it tracks
//     the handle at any camera tilt instead of assuming up-is-up.
//   ◆ radial (on the ring)         drag in/out to set the item's horizontal
//     dimension — a loiter's orbit radius, or a waypoint's accept radius. The
//     ring is drawn at the item's altitude, so what you see is the number.
//
// Kept separate from Aircraft.tsx so the plane overlay and the mission overlay
// own their own entities/handlers independently.
export default function MissionLayer() {
	const $viewer = useStore($viewerStore);

	useEffect(() => {
		if (!$viewer) return;

		const itemOf = (seq: number): MissionItem | undefined =>
			$missionItems.get().find((x) => x.seq === seq);
		// An item's `alt` is metres ABOVE HOME (that is the frame it uploads in).
		// Cesium draws at MSL, so every height below goes through drawHeightM
		// with home's elevation, which the autopilot gives us as the difference
		// between its two reported altitudes. Drawing the raw relative number —
		// what this did before — put the whole plan low by home's elevation.
		const home = () => homeAltM($aircraftStore.get());
		const altOf = (it: MissionItem | undefined) =>
			drawHeightM(it?.alt, home());
		// The authored value itself, for the readout and the drag arithmetic.
		const relAltOf = (it: MissionItem | undefined) =>
			it && Number.isFinite(it.alt) ? (it.alt as number) : 0;
		// Grabbers are an authoring affordance: hidden outside edit mode so a
		// monitoring console is not peppered with handles, and never shown in the
		// read-only build.
		const editing = () => !IS_VIEW && $missionEdit.get();

		const radiusOf = (it: MissionItem | undefined): number | null => {
			if (!it) return null;
			const key = radiusParamKey(it.kind);
			if (!key) return null;
			const v = it.params?.[key];
			return Number.isFinite(v) ? clampRadius(v as number) : null;
		};

		// World position of an item, at its own altitude.
		const posOf = (seq: number): Cartesian3 | undefined => {
			const it = itemOf(seq);
			if (!it || it.lat === undefined || it.lon === undefined) return undefined;
			return Cartesian3.fromDegrees(it.lon, it.lat, altOf(it));
		};

		// A point `metres` due east of an item, at its own altitude — where the
		// radius grabber rides. East is arbitrary but stable, which is what makes
		// the handle findable; local ENU keeps it exact at any latitude.
		const eastOf = (seq: number, metres: number): Cartesian3 | undefined => {
			const centre = posOf(seq);
			if (!centre) return undefined;
			const frame = Transforms.eastNorthUpToFixedFrame(centre);
			return Matrix4.multiplyByPoint(frame, new Cartesian3(metres, 0, 0), new Cartesian3());
		};

		// --- the landing approach, drawn so it can be dragged into compliance ---
		//
		// PX4 refuses a mission whose landing is steeper than FW_LND_ANG, and it
		// says so only through STATUSTEXT at the moment the mode change is
		// refused. Measured here: a 24.6 degree approach against a 5 degree
		// limit, which looked like "setting mission doesn't work".
		//
		// A sentence in a panel makes the operator translate numbers back into
		// which marker to move. So the constraint is drawn instead: the approach
		// segment turns red when it is too steep and green when it is flyable,
		// and a ring around the approach waypoint shows the distance the landing
		// must sit OUTSIDE. Drag the landing past the ring and the line goes
		// green. Both read live from the store, so it updates during the drag.
		const approachGeom = () => landingGeometry($missionItems.get());
		const approachOk = () => {
			const g = approachGeom();
			const limit = landingSlopeLimit(lookupFrom($params.get()));
			if (!g || limit === undefined) return true;   // nothing known against it
			return g.slopeDeg <= limit + 0.1;
		};

		const approach = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => {
					const g = approachGeom();
					if (!g) return undefined;
					const items = $missionItems.get();
					const from = items.find((x) => x.seq === g.fromSeq);
					const to = items.find((x) => x.seq === g.landSeq);
					if (!from || !to || from.lat === undefined || to.lat === undefined) return undefined;
					return [
						Cartesian3.fromDegrees(from.lon!, from.lat, altOf(from)),
						Cartesian3.fromDegrees(to.lon!, to.lat, altOf(to)),
					];
				}, false),
				width: 3,
				material: new ColorMaterialProperty(
					new CallbackProperty(
						() => (approachOk() ? Color.LIME.withAlpha(0.85) : Color.ORANGERED.withAlpha(0.9)),
						false,
					),
				),
				arcType: ArcType.NONE,
			},
		});

		// The ring: put the landing beyond this and the slope is legal.
		const legalRing = $viewer.entities.add({
			position: new CallbackPositionProperty(() => {
				const g = approachGeom();
				if (!g || approachOk()) return undefined;   // only shown while it matters
				const from = $missionItems.get().find((x) => x.seq === g.fromSeq);
				return from && from.lat !== undefined
					? Cartesian3.fromDegrees(from.lon!, from.lat, 0)
					: undefined;
			}, false),
			ellipse: {
				semiMajorAxis: new CallbackProperty(
					() => minLegalRunM($missionItems.get(), lookupFrom($params.get())) ?? 0, false,
				) as unknown as number,
				semiMinorAxis: new CallbackProperty(
					() => minLegalRunM($missionItems.get(), lookupFrom($params.get())) ?? 0, false,
				) as unknown as number,
				height: 0 as unknown as number,
				material: Color.TRANSPARENT,
				outline: true,
				outlineColor: Color.ORANGERED.withAlpha(0.5),
			},
		});

		// Route polyline through positioned items, live from the store, now at the
		// planned altitudes so the route climbs and descends as authored.
		const route = $viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => {
					const pts = $missionItems.get()
						.filter((it) => kindHasPosition(it.kind) && it.lat !== undefined && it.lon !== undefined)
						.map((it) => Cartesian3.fromDegrees(it.lon!, it.lat!, altOf(it)));
					return pts.length >= 2 ? pts : undefined;
				}, false),
				width: 2,
				material: Color.WHITE.withAlpha(0.7),
				arcType: ArcType.NONE,
			},
		});

		// One marker (plus stem and, in edit mode, grabbers) per positioned item.
		// Rebuilt only when the item list changes STRUCTURALLY (add/remove/reorder/
		// kind) or when edit mode toggles; a drag updates lat/lon/alt/radius through
		// the callback properties below, so re-creating every entity on each
		// mouse-move (as a plain store subscription would) is avoided.
		let markers: Entity[] = [];
		let structure = "";
		const rebuildMarkers = () => {
			const sig = $missionItems.get()
				.map((it) => `${it.seq}:${it.kind}:${kindHasPosition(it.kind) && it.lat !== undefined ? 1 : 0}`)
				.join(",") + `|${editing() ? 1 : 0}`;
			if (sig === structure) return;
			structure = sig;
			markers.forEach((m) => $viewer.entities.remove(m));
			markers = [];
			for (const it of $missionItems.get()) {
				if (!kindHasPosition(it.kind) || it.lat === undefined || it.lon === undefined) continue;
				const seq = it.seq;
				const colour = () => {
					if ($missionCurrent.get() === seq) return Color.YELLOW;
					const reached = $missionReached.get();
					if (reached !== null && seq <= reached) return Color.LIME.withAlpha(0.7);
					return Color.WHITE;
				};

				// The stem: terrain up to the planned altitude. This is what turns an
				// altitude into something you can see (and aim a grabber at).
				markers.push($viewer.entities.add({
					polyline: {
						positions: new CallbackProperty(() => {
							const cur = itemOf(seq);
							if (!cur || cur.lat === undefined || cur.lon === undefined) return undefined;
							return [
								Cartesian3.fromDegrees(cur.lon, cur.lat, 0),
								Cartesian3.fromDegrees(cur.lon, cur.lat, altOf(cur)),
							];
						}, false),
						width: 1,
						material: Color.WHITE.withAlpha(0.35),
						arcType: ArcType.NONE,
					},
				}));

				// Ground tick, so the plan's footprint stays readable from straight
				// down where the stems foreshorten to nothing.
				markers.push($viewer.entities.add({
					position: new CallbackPositionProperty(() => {
						const cur = itemOf(seq);
						if (!cur || cur.lat === undefined || cur.lon === undefined) return undefined;
						return Cartesian3.fromDegrees(cur.lon, cur.lat, 0);
					}, false),
					point: {
						pixelSize: 4,
						color: Color.WHITE.withAlpha(0.4),
						heightReference: HeightReference.NONE,
					},
				}));

				// The marker itself, at the item's own altitude.
				markers.push($viewer.entities.add({
					// id tags the marker so the drag handler can map a pick back to a seq.
					id: `mission-wp-${seq}`,
					position: new CallbackPositionProperty(() => posOf(seq), false),
					point: {
						pixelSize: 12,
						color: new CallbackProperty(colour, false),
						outlineColor: Color.BLACK,
						outlineWidth: 1,
						// Grabbable even when a fence wall or the terrain is between it
						// and the camera; a marker you cannot click cannot be moved.
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
					label: {
						text: `${seq}`,
						font: "12px monospace",
						fillColor: Color.BLACK,
						style: LabelStyle.FILL,
						verticalOrigin: VerticalOrigin.CENTER,
						pixelOffset: new Cartesian2(0, 0),
					},
				}));

				// Altitude readout, beside the marker, so a drag has a number.
				//
				// Drawn as solid white on a dark pill rather than translucent text.
				// At 10 px and 75 % alpha this was illegible over bright terrain,
				// which is the worst possible place to economise: the altitude is
				// the number the ▲ handle exists to change, so it has to be
				// readable WHILE being dragged, over whatever happens to be below.
				markers.push($viewer.entities.add({
					position: new CallbackPositionProperty(() => posOf(seq), false),
					label: {
						// The authored altitude, above home — the number the table shows
						// and the one PX4 flies. Showing the MSL height it is DRAWN at
						// would disagree with the table by home's elevation.
						text: new CallbackProperty(() => `${Math.round(relAltOf(itemOf(seq)))} m`, false),
						font: "bold 12px ui-monospace, Menlo, monospace",
						fillColor: Color.WHITE,
						style: LabelStyle.FILL,
						showBackground: true,
						backgroundColor: Color.BLACK.withAlpha(0.55),
						backgroundPadding: new Cartesian2(5, 3),
						verticalOrigin: VerticalOrigin.CENTER,
						pixelOffset: new Cartesian2(16, 12),
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
				}));

				if (!editing()) continue;

				// --- the vertical grabber -------------------------------------
				// A chevron sitting just above the marker. Offset in PIXELS, not
				// metres, so it stays the same reachable distance from the marker at
				// every zoom level — and clear of it, so the two never contend for
				// the same pick.
				markers.push($viewer.entities.add({
					id: `mission-alt-${seq}`,
					position: new CallbackPositionProperty(() => posOf(seq), false),
					billboard: {
						image: ALT_HANDLE_MISSION,
						width: ALT_HANDLE_PX,
						height: ALT_HANDLE_PX,
						verticalOrigin: VerticalOrigin.CENTER,
						pixelOffset: new Cartesian2(0, ALT_HANDLE_OFFSET_PX),
						// Reachable even when the handle is behind terrain or inside a
						// fence volume; a grabber you cannot click is not a grabber.
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
				}));

				// --- the radial grabber ---------------------------------------
				const key = radiusParamKey(it.kind);
				if (key) {
					const ringRadius = () => radiusOf(itemOf(seq)) ?? defaultRadius(it.kind);
					// The ring: the dimension, drawn at the item's altitude.
					markers.push($viewer.entities.add({
						position: new CallbackPositionProperty(() => posOf(seq), false),
						ellipse: {
							semiMajorAxis: new CallbackProperty(ringRadius, false) as unknown as number,
							semiMinorAxis: new CallbackProperty(ringRadius, false) as unknown as number,
							height: new CallbackProperty(() => altOf(itemOf(seq)), false) as unknown as number,
							material: Color.AQUA.withAlpha(0.06),
							outline: true,
							outlineColor: Color.AQUA.withAlpha(0.55),
						},
					}));
					// The handle on the rim.
					markers.push($viewer.entities.add({
						id: `mission-rad-${seq}`,
						position: new CallbackPositionProperty(
							() => eastOf(seq, ringRadius()), false,
						),
						point: {
							pixelSize: 9,
							color: Color.AQUA,
							outlineColor: Color.BLACK,
							outlineWidth: 1,
							disableDepthTestDistance: Number.POSITIVE_INFINITY,
						},
						label: {
							text: new CallbackProperty(() => `${Math.round(ringRadius())} m`, false),
							font: "bold 11px ui-monospace, Menlo, monospace",
							fillColor: Color.AQUA,
							style: LabelStyle.FILL,
							showBackground: true,
							backgroundColor: Color.BLACK.withAlpha(0.55),
							backgroundPadding: new Cartesian2(4, 2),
							verticalOrigin: VerticalOrigin.BOTTOM,
							pixelOffset: new Cartesian2(0, -12),
							disableDepthTestDistance: Number.POSITIVE_INFINITY,
						},
					}));
				}
			}
			$viewer.scene.requestRender();
		};
		rebuildMarkers();
		const unsubItems = $missionItems.subscribe(rebuildMarkers);
		// Toggling edit mode adds/removes the grabbers, so it is a structural change.
		const unsubEdit = $missionEdit.subscribe(rebuildMarkers);

		// --- authoring: double-click to add, drag to move/raise/resize --------
		const handler = new ScreenSpaceEventHandler($viewer.scene.canvas);

		// Left-click appends a waypoint, but only in edit mode (otherwise it would
		// fight camera interaction). A drag-release also fires LEFT_CLICK, so skip
		// the add if we were dragging.
		type Drag =
			| { what: "move"; seq: number }
			| { what: "alt"; seq: number; startAlt: number; from: Cartesian2 }
			| { what: "radius"; seq: number };
		let drag: Drag | null = null;
		let didDrag = false;
		// Set when a single click has just appended a waypoint, so the
		// double-click that follows it does not append a second one on the same
		// spot. Cesium delivers LEFT_CLICK then LEFT_DOUBLE_CLICK for the same
		// gesture; only one waypoint should come out of it.
		let justAdded = false;

		// Drop a waypoint under the cursor, at the aircraft's current altitude —
		// the only sane default — and let the operator drag it from there. Picks
		// the terrain where tiles are loaded so the marker starts on the hill it
		// looks like it is on, falling back to the ellipsoid while they stream.
		const addAt = (px: Cartesian2) => {
			const scene = $viewer.scene;
			const ray = scene.camera.getPickRay(px);
			const cart = (ray ? scene.globe.pick(ray, scene) : undefined)
				?? scene.camera.pickEllipsoid(px, scene.globe.ellipsoid);
			if (!cart) return false;
			const geo = Cartographic.fromCartesian(cart);
			addWaypoint(
				CesiumMath.toDegrees(geo.latitude),
				CesiumMath.toDegrees(geo.longitude),
				clampAlt(authoringAltM($aircraftStore.get()).alt),
			);
			return true;
		};

		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW || !$missionEdit.get() || didDrag) return;
			if (addAt(m.position)) {
				justAdded = true;
				setTimeout(() => { justAdded = false; }, 400);
			}
		}, ScreenSpaceEventType.LEFT_CLICK);

		// Double-click drops a waypoint without first arming edit mode, and turns
		// edit mode on so the thing you just made is visible and grabbable. This
		// is the gesture that puts a waypoint on the globe in one move; the
		// single-click add above still works once you are in edit mode.
		//
		// Cesium's own double-click handler tracks the picked entity, which would
		// snap the camera onto the aircraft at the same moment — so that default
		// is removed here, on the viewer's own handler.
		$viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW || didDrag) return;
			// Never on top of an existing marker or grabber: a double-click there
			// is aimed at that waypoint, not at the ground behind it.
			const onHandle = firstTaggedId(
				$viewer.scene.drillPick(m.position, 8),
				["mission-alt-", "mission-rad-", "mission-wp-"],
			) !== null;
			if (onHandle) return;
			if (!justAdded) addAt(m.position);
			justAdded = false;
			$missionEdit.set(true);
			$viewer.scene.requestRender();
		}, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

		// Arm a drag: pick on LEFT_DOWN, move on MOUSE_MOVE, release on LEFT_UP.
		// Disable the camera controls while dragging so the globe doesn't pan.
		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW) return;  // read-only: nothing is draggable
			// drillPick, not pick: a marker can sit behind a fence wall or inside
			// its own ring, and the topmost primitive is often not the handle.
			// The nearest TAGGED hit wins; the grabbers are offset clear of the
			// marker so the three never contend for the same pixel.
			const id = firstTaggedId(
				$viewer.scene.drillPick(m.position, 8),
				["mission-alt-", "mission-rad-", "mission-wp-"],
			);
			if (id === null) return;

			const altSeq = tagSeq(id, "mission-alt-");
			const radSeq = tagSeq(id, "mission-rad-");
			const wpSeq = tagSeq(id, "mission-wp-");

			if (altSeq !== null) {
				drag = { what: "alt", seq: altSeq, startAlt: altOf(itemOf(altSeq)), from: m.position.clone() };
			} else if (radSeq !== null) {
				drag = { what: "radius", seq: radSeq };
			} else if (wpSeq !== null) {
				drag = { what: "move", seq: wpSeq };
			} else {
				return;
			}
			didDrag = false;
			$viewer.scene.screenSpaceCameraController.enableInputs = false;
		}, ScreenSpaceEventType.LEFT_DOWN);

		handler.setInputAction((m: { endPosition: Cartesian2 }) => {
			if (!drag) return;

			if (drag.what === "alt") {
				// Resolve the drag along the local vertical as it projects on screen,
				// so the handle tracks the mouse at any camera tilt. Two samples
				// 100 m apart give that direction and its pixel length.
				const base = posOf(drag.seq);
				if (!base) return;
				const it = itemOf(drag.seq);
				if (!it || it.lat === undefined || it.lon === undefined) return;
				const higher = Cartesian3.fromDegrees(it.lon, it.lat, altOf(it) + ALT_SAMPLE_M);
				// altOf() is the MSL draw height; the sample only needs to be one
				// ALT_SAMPLE_M above it, and the result is applied to the stored
				// above-home value, so no home offset enters the arithmetic.
				const s0 = SceneTransforms.worldToWindowCoordinates($viewer.scene, base);
				const s1 = SceneTransforms.worldToWindowCoordinates($viewer.scene, higher);
				if (!s0 || !s1) return;
				const delta = altDeltaFromDrag(
					{ x: m.endPosition.x - drag.from.x, y: m.endPosition.y - drag.from.y },
					{ x: s1.x - s0.x, y: s1.y - s0.y },
				);
				didDrag = true;
				updateItem(drag.seq, { alt: snap(clampAlt(drag.startAlt + delta)) });
				$viewer.scene.requestRender();
				return;
			}

			if (drag.what === "radius") {
				// Radius is the ground distance from the item to the cursor, which
				// reads exactly as "drag the ring to the size you want".
				const it = itemOf(drag.seq);
				if (!it || it.lat === undefined || it.lon === undefined) return;
				const key = radiusParamKey(it.kind);
				if (!key) return;
				const cart = $viewer.camera.pickEllipsoid(m.endPosition, $viewer.scene.globe.ellipsoid);
				if (!cart) return;
				const cursor = Cartographic.fromCartesian(cart);
				const centre = Cartographic.fromDegrees(it.lon, it.lat);
				const geodesic = new EllipsoidGeodesic(centre, cursor, Ellipsoid.WGS84);
				didDrag = true;
				updateItem(drag.seq, {
					params: { ...it.params, [key]: snap(clampRadius(geodesic.surfaceDistance)) },
				});
				$viewer.scene.requestRender();
				return;
			}

			// Plain lateral move.
			const cart = $viewer.camera.pickEllipsoid(m.endPosition, $viewer.scene.globe.ellipsoid);
			if (!cart) return;
			const geo = Cartographic.fromCartesian(cart);
			didDrag = true;
			moveItemPosition(
				drag.seq,
				CesiumMath.toDegrees(geo.latitude),
				CesiumMath.toDegrees(geo.longitude),
			);
		}, ScreenSpaceEventType.MOUSE_MOVE);

		handler.setInputAction(() => {
			if (drag !== null) {
				drag = null;
				$viewer.scene.screenSpaceCameraController.enableInputs = true;
				// Clear the drag flag on the next tick so the trailing LEFT_CLICK is
				// still suppressed, but a later plain click adds normally.
				setTimeout(() => { didDrag = false; }, 0);
			}
		}, ScreenSpaceEventType.LEFT_UP);

		return () => {
			unsubItems();
			unsubEdit();
			handler.destroy();
			markers.forEach((m) => $viewer.entities.remove(m));
			markers = [];
			$viewer.entities.remove(route);
			$viewer.entities.remove(approach);
			$viewer.entities.remove(legalRing);
			$viewer.scene.screenSpaceCameraController.enableInputs = true;
		};
	}, [$viewer]);

	return null;
}
