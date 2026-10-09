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
	Ellipsoid,
	EllipsoidGeodesic,
	Entity,
	LabelStyle,
	Math as CesiumMath,
	Matrix4,
	PolygonHierarchy,
	SceneTransforms,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
	Transforms,
	VerticalOrigin,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import { IS_VIEW } from "@/lib/envs";
import { $aircraftStore } from "@/stores/aircraft.store";
import {
	$fenceItems,
	$rallyItems,
	$geoEdit,
	$geoPlaceKind,
	addFencePoint,
	addRallyPoint,
	insertFencePointAfter,
	isCircleKind,
	isPolygonKind,
	moveFencePoint,
	moveRallyPoint,
	updateFenceItem,
	updateRallyItem,
} from "@/stores/geo.store";
import { ALT_SAMPLE_M, altDeltaFromDrag, clampAlt, clampRadius, snap } from "@/lib/grabbers";
import { authoringAltM, drawHeightM, homeAltM } from "@/lib/altFrames";
import { firstTaggedId, tagSeq } from "@/lib/pickTag";
import { ALT_HANDLE_OFFSET_PX, ALT_HANDLE_PX, ALT_HANDLE_RALLY } from "@/lib/altHandle";
import type { FenceItem } from "@/types/app";

// Inclusion = green (fly inside), exclusion = red (keep out). Rally = cyan.
const INCLUSION = Color.LIME;
const EXCLUSION = Color.RED;

function fenceColor(kind: FenceItem["kind"]): Color {
	return kind.includes("exclusion") ? EXCLUSION : INCLUSION;
}

// Geofence + rally authoring/rendering on the globe, mirroring MissionLayer. Draws
// inclusion/exclusion polygons (filled translucent), circle fences (ellipses), and
// rally markers; in geo-edit mode a left-click places the selected kind and any
// vertex/rally marker can be dragged. Kept separate from the mission + aircraft
// layers so each overlay owns its own entities/handlers.
// A geofence has no altitude on the MAVLink wire — PX4 fences are lateral, with
// the ceiling held in a parameter. So the curtain is drawn from the terrain up to
// a height that keeps it meaningful next to the aircraft: tall enough to be a
// barrier, not so tall it fills the sky.
const FENCE_BASE_M = 0;
const FENCE_MIN_TOP_M = 300;
const FENCE_HEADROOM_M = 150;

function fenceCeilingM(): number {
	const alt = $aircraftStore.get()?.alt;
	return typeof alt === "number" && Number.isFinite(alt)
		? Math.max(FENCE_MIN_TOP_M, alt + FENCE_HEADROOM_M)
		: FENCE_MIN_TOP_M;
}

export default function GeoLayer() {
	const $viewer = useStore($viewerStore);

	useEffect(() => {
		if (!$viewer) return;
		// Grabbers are an authoring affordance: hidden outside geo-edit mode so a
		// monitoring console is not peppered with handles, and never in the
		// read-only build.
		const editing = () => !IS_VIEW && $geoEdit.get();

		// Geo entities are rebuilt only when either set changes STRUCTURALLY
		// (count/kind/order). Positions and radii are read live through callback
		// properties so a marker drag never tears everything down per mouse-move.
		let ents: Entity[] = [];
		let structure = "";
		const rebuild = () => {
			const sig = $fenceItems.get().map((it) => `${it.seq}:${it.kind}`).join(",")
				+ "|" + $rallyItems.get().map((it) => it.seq).join(",")
				// Toggling edit mode adds/removes every grabber, so it is structural.
				+ `|${editing() ? 1 : 0}`;
			if (sig === structure) return;
			structure = sig;
			ents.forEach((e) => $viewer.entities.remove(e));
			ents = [];
			const fence = $fenceItems.get();
			// Live polygon vertices for the run [i, j) of the same kind.
			const ringPoints = (kind: FenceItem["kind"], i: number, j: number) => {
				const cur = $fenceItems.get();
				const pts: Cartesian3[] = [];
				for (let k = i; k < j && k < cur.length; k++) {
					const g = cur[k];
					if (g.kind !== kind) break;
					pts.push(Cartesian3.fromDegrees(g.lon, g.lat, 0));
				}
				return pts;
			};
			const polyPositions = (kind: FenceItem["kind"], i: number, j: number) => () => {
				const pts = ringPoints(kind, i, j);
				return pts.length >= 3 ? new PolygonHierarchy(pts) : undefined;
			};
			const ringLength = (kind: FenceItem["kind"], i: number, j: number) =>
				ringPoints(kind, i, j).length;

			// Polygons: each contiguous run of the same polygon kind is one polygon.
			let i = 0;
			while (i < fence.length) {
				const it = fence[i];
				if (isPolygonKind(it.kind)) {
					let j = i;
					while (j < fence.length && fence[j].kind === it.kind) j++;
					const group = fence.slice(i, j);
					if (group.length >= 3) {
						const col = fenceColor(it.kind);
						const exclusion = it.kind.includes("exclusion");
						// A fence is a VOLUME the aircraft may not cross, so draw it as
						// one: a vertical curtain standing on the terrain. A flat ground
						// outline reads as a drawing on a map; a wall reads as a barrier,
						// and at a shallow camera angle it is the only form you can
						// actually see from the cockpit view.
						ents.push($viewer.entities.add({
							wall: {
								positions: new CallbackProperty(() => {
									const h = polyPositions(it.kind, i, j)();
									if (!h) return undefined;
									// Close the ring so there is no gap in the barrier.
									const pts = h.positions.slice();
									if (pts.length) pts.push(pts[0]);
									return pts;
								}, false),
								// Stand the wall from the ground up to the fence ceiling.
								minimumHeights: new CallbackProperty(() => {
									const n = ringLength(it.kind, i, j) + 1;
									return new Array(n).fill(FENCE_BASE_M);
								}, false),
								maximumHeights: new CallbackProperty(() => {
									const n = ringLength(it.kind, i, j) + 1;
									return new Array(n).fill(fenceCeilingM());
								}, false),
								// Exclusion reads as "keep out", so it is more opaque and
								// more saturated than an inclusion boundary you fly inside.
								material: col.withAlpha(exclusion ? 0.28 : 0.14),
								outline: true,
								outlineColor: col.withAlpha(0.9),
							},
						}));
						// Translucent floor, so the footprint is still legible from above.
						ents.push($viewer.entities.add({
							polygon: {
								hierarchy: new CallbackProperty(polyPositions(it.kind, i, j), false),
								material: col.withAlpha(exclusion ? 0.16 : 0.07),
								outline: true,
								outlineColor: col.withAlpha(0.8),
							},
						}));
					}
					i = j;
				} else {
					i++;
				}
			}

			// Circle fences: one ellipse per circle item, radius from params.
			for (const c of fence) {
				if (!isCircleKind(c.kind)) continue;
				const seq = c.seq;
				const col = fenceColor(c.kind);
				const exclusion = c.kind.includes("exclusion");
				const radiusOf = () =>
					$fenceItems.get().find((x) => x.seq === seq)?.params?.radius ?? 100;
				const radius = new CallbackProperty(radiusOf, false);
				const centre = () => $fenceItems.get().find((x) => x.seq === seq);

				// A cylinder, for the same reason polygons became walls: a circle
				// fence is a volume, and a flat disc does not read as one.
				ents.push($viewer.entities.add({
					position: new CallbackPositionProperty(() => {
						const cur = centre();
						if (!cur) return undefined;
						const ceil = fenceCeilingM();
						return Cartesian3.fromDegrees(cur.lon, cur.lat, (FENCE_BASE_M + ceil) / 2);
					}, false),
					cylinder: {
						length: new CallbackProperty(
							() => Math.max(10, fenceCeilingM() - FENCE_BASE_M), false,
						) as unknown as number,
						topRadius: radius,
						bottomRadius: radius,
						material: col.withAlpha(exclusion ? 0.22 : 0.10),
						outline: true,
						outlineColor: col.withAlpha(0.85),
						numberOfVerticalLines: 16,
					},
				}));
				// Footprint on the ground for the top-down view.
				ents.push($viewer.entities.add({
					position: new CallbackPositionProperty(() => {
						const cur = centre();
						return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, 0) : undefined;
					}, false),
					ellipse: {
						semiMajorAxis: radius,
						semiMinorAxis: radius,
						material: col.withAlpha(exclusion ? 0.16 : 0.07),
						outline: true,
						outlineColor: col.withAlpha(0.8),
					},
				}));
			}

			// Draggable, numbered markers for every fence point. They sit ON THE
			// GROUND, where the boundary itself is: they used to be drawn at the
			// AIRCRAFT's altitude, so the handle for a fence corner floated
			// hundreds of metres above the corner it moved.
			for (const it of fence) {
				const seq = it.seq;
				const circle = isCircleKind(it.kind);
				ents.push($viewer.entities.add({
					id: `geo-fence-${seq}`,
					position: new CallbackPositionProperty(() => {
						const cur = $fenceItems.get().find((x) => x.seq === seq);
						return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, FENCE_BASE_M) : undefined;
					}, false),
					point: {
						pixelSize: circle ? 11 : 9,
						color: fenceColor(it.kind),
						outlineColor: Color.BLACK,
						outlineWidth: 1,
						// A corner handle must stay grabbable even when its own wall is
						// between it and the camera; without this the marker is hidden by
						// the very volume it defines.
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
					label: {
						text: circle ? `C${seq}` : `${seq}`, font: "11px monospace", fillColor: Color.WHITE,
						style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
						pixelOffset: new Cartesian2(0, -10),
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
				}));

				// A circle fence's size is a number you can only reach in the table
				// otherwise. Give it the same rim grabber the mission layer gives a
				// loiter radius: drag the edge of the circle to the size you want.
				if (circle && editing()) {
					const radiusOf = () =>
						clampRadius($fenceItems.get().find((x) => x.seq === seq)?.params?.radius ?? 100);
					ents.push($viewer.entities.add({
						id: `geo-circle-r-${seq}`,
						position: new CallbackPositionProperty(() => {
							const cur = $fenceItems.get().find((x) => x.seq === seq);
							if (!cur) return undefined;
							const centre = Cartesian3.fromDegrees(cur.lon, cur.lat, FENCE_BASE_M);
							const frame = Transforms.eastNorthUpToFixedFrame(centre);
							return Matrix4.multiplyByPoint(
								frame, new Cartesian3(radiusOf(), 0, 0), new Cartesian3(),
							);
						}, false),
						point: {
							pixelSize: 9, color: Color.WHITE, outlineColor: fenceColor(it.kind),
							outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY,
						},
						label: {
							text: new CallbackProperty(() => `${Math.round(radiusOf())} m`, false),
							font: "10px monospace", fillColor: Color.WHITE,
							style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
							pixelOffset: new Cartesian2(0, -10),
							disableDepthTestDistance: Number.POSITIVE_INFINITY,
						},
					}));
				}
			}

			// Midpoint handles, one per polygon EDGE, in edit mode. Dragging a
			// corner can only move the corners you already have; reshaping a
			// boundary means adding one, and appending a vertex puts it at the end
			// of the ring rather than on the edge you grabbed. Pulling a midpoint
			// splits that edge in place, which is how every map editor behaves.
			if (editing()) {
				let a = 0;
				while (a < fence.length) {
					const first = fence[a];
					if (!isPolygonKind(first.kind)) { a++; continue; }
					let b = a;
					while (b < fence.length && fence[b].kind === first.kind) b++;
					const run = fence.slice(a, b);
					if (run.length >= 2) {
						for (let k = 0; k < run.length; k++) {
							// The closing edge (last -> first) gets a handle too, so every
							// side of the ring is reshapeable.
							const from = run[k];
							const to = run[(k + 1) % run.length];
							if (run.length === 2 && k === 1) break; // a 2-point run has one edge
							ents.push($viewer.entities.add({
								id: `geo-mid-${from.seq}`,
								position: new CallbackPositionProperty(() => {
									const cur = $fenceItems.get();
									const p = cur.find((x) => x.seq === from.seq);
									const q = cur.find((x) => x.seq === to.seq);
									if (!p || !q) return undefined;
									return Cartesian3.fromDegrees((p.lon + q.lon) / 2, (p.lat + q.lat) / 2, FENCE_BASE_M);
								}, false),
								point: {
									pixelSize: 6,
									color: fenceColor(first.kind).withAlpha(0.5),
									outlineColor: Color.WHITE.withAlpha(0.7),
									outlineWidth: 1,
									disableDepthTestDistance: Number.POSITIVE_INFINITY,
								},
							}));
						}
					}
					a = b;
				}
			}

			// …and every rally point. A rally point DOES carry an altitude on the
			// wire, so it is drawn at its own, on a stem, like a waypoint.
			for (const it of $rallyItems.get()) {
				const seq = it.seq;
				// Stored above home (RallyItem.alt is relative-to-home, like a
				// mission item); drawn at MSL.
				const rallyRelAlt = () => {
					const cur = $rallyItems.get().find((x) => x.seq === seq);
					return cur && Number.isFinite(cur.alt) ? (cur.alt as number) : 0;
				};
				const rallyAlt = () => drawHeightM(rallyRelAlt(), homeAltM($aircraftStore.get()));
				ents.push($viewer.entities.add({
					polyline: {
						positions: new CallbackProperty(() => {
							const cur = $rallyItems.get().find((x) => x.seq === seq);
							if (!cur) return undefined;
							return [
								Cartesian3.fromDegrees(cur.lon, cur.lat, 0),
								Cartesian3.fromDegrees(cur.lon, cur.lat, rallyAlt()),
							];
						}, false),
						width: 1,
						material: Color.CYAN.withAlpha(0.35),
					},
				}));
				ents.push($viewer.entities.add({
					id: `geo-rally-${seq}`,
					position: new CallbackPositionProperty(() => {
						const cur = $rallyItems.get().find((x) => x.seq === seq);
						return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, rallyAlt()) : undefined;
					}, false),
					point: {
						pixelSize: 11, color: Color.CYAN, outlineColor: Color.BLACK, outlineWidth: 1,
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
					label: {
						text: `R${seq}`, font: "11px monospace", fillColor: Color.CYAN,
						style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
						pixelOffset: new Cartesian2(0, -10),
						disableDepthTestDistance: Number.POSITIVE_INFINITY,
					},
				}));
				// Rally altitude grabber, same gesture as a waypoint's.
				if (editing()) {
					ents.push($viewer.entities.add({
						id: `geo-rally-alt-${seq}`,
						position: new CallbackPositionProperty(() => {
							const cur = $rallyItems.get().find((x) => x.seq === seq);
							return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, rallyAlt()) : undefined;
						}, false),
						// A billboard, not a point: only a billboard takes a pixel offset,
						// which is what keeps the handle the same reachable distance from
						// its marker at every zoom level instead of merging with it.
						billboard: {
							image: ALT_HANDLE_RALLY,
							width: ALT_HANDLE_PX,
							height: ALT_HANDLE_PX,
							verticalOrigin: VerticalOrigin.CENTER,
							pixelOffset: new Cartesian2(0, ALT_HANDLE_OFFSET_PX),
							disableDepthTestDistance: Number.POSITIVE_INFINITY,
						},
						label: {
							text: new CallbackProperty(() => `${Math.round(rallyRelAlt())} m`, false),
							font: "10px monospace", fillColor: Color.CYAN,
							style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.CENTER,
							pixelOffset: new Cartesian2(16, ALT_HANDLE_OFFSET_PX),
							disableDepthTestDistance: Number.POSITIVE_INFINITY,
						},
					}));
				}
			}
			$viewer.scene.requestRender();
		};
		rebuild();
		const unsubF = $fenceItems.subscribe(rebuild);
		const unsubR = $rallyItems.subscribe(rebuild);
		const unsubE = $geoEdit.subscribe(rebuild);

		// --- authoring: click to place, drag to move/resize/reshape ----------
		const handler = new ScreenSpaceEventHandler($viewer.scene.canvas);
		type Drag =
			| { what: "fence"; seq: number }
			| { what: "rally"; seq: number }
			| { what: "radius"; seq: number }
			| { what: "rally-alt"; seq: number; startAlt: number; from: Cartesian2 };
		let drag: Drag | null = null;
		let didDrag = false;

		const ground = (p: Cartesian2) => {
			const cart = $viewer.camera.pickEllipsoid(p, $viewer.scene.globe.ellipsoid);
			if (!cart) return null;
			const geo = Cartographic.fromCartesian(cart);
			return { lat: CesiumMath.toDegrees(geo.latitude), lon: CesiumMath.toDegrees(geo.longitude) };
		};

		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW || !$geoEdit.get() || didDrag) return;
			const at = ground(m.position);
			if (!at) return;
			const kind = $geoPlaceKind.get();
			// A rally point takes the aircraft's current altitude to start from and
			// is then dragged vertically like a waypoint.
			if (kind === "rally") addRallyPoint(at.lat, at.lon, clampAlt(authoringAltM($aircraftStore.get()).alt));
			else addFencePoint(kind, at.lat, at.lon);
		}, ScreenSpaceEventType.LEFT_CLICK);

		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW) return;  // read-only: nothing is draggable
			// drillPick, not pick: fences are drawn as walls and cylinders OVER
			// their own vertex markers, so the topmost primitive under the cursor is
			// the volume, not the handle. scene.pick returned that wall, its entity
			// carried no tagged id, and the drag never armed — which is precisely
			// why a boundary could not be adjusted. Depth order still decides
			// between handles; they are offset clear of one another so they do not
			// contend for the same pixel.
			const id = firstTaggedId(
				$viewer.scene.drillPick(m.position, 12),
				["geo-circle-r-", "geo-rally-alt-", "geo-mid-", "geo-rally-", "geo-fence-"],
			);
			if (id === null) return;

			const radSeq = tagSeq(id, "geo-circle-r-");
			const rAltSeq = tagSeq(id, "geo-rally-alt-");
			const midSeq = tagSeq(id, "geo-mid-");
			const rallySeq = tagSeq(id, "geo-rally-");
			const fenceSeq = tagSeq(id, "geo-fence-");

			if (radSeq !== null) {
				drag = { what: "radius", seq: radSeq };
			} else if (rAltSeq !== null) {
				const cur = $rallyItems.get().find((x) => x.seq === rAltSeq);
				drag = {
					what: "rally-alt", seq: rAltSeq,
					startAlt: cur && Number.isFinite(cur.alt) ? (cur.alt as number) : 0,
					from: m.position.clone(),
				};
			} else if (midSeq !== null) {
				// Grabbing a midpoint splits that edge: insert a real vertex at the
				// cursor, then drag it as an ordinary corner from here on. The new
				// point's seq is the edge's first vertex + 1 (see the store), so the
				// ring's winding order survives the insertion.
				const at = ground(m.position);
				if (!at) return;
				insertFencePointAfter(midSeq, at.lat, at.lon);
				drag = { what: "fence", seq: midSeq + 1 };
			} else if (rallySeq !== null) {
				drag = { what: "rally", seq: rallySeq };
			} else if (fenceSeq !== null) {
				drag = { what: "fence", seq: fenceSeq };
			} else {
				return;
			}
			didDrag = false;
			$viewer.scene.screenSpaceCameraController.enableInputs = false;
		}, ScreenSpaceEventType.LEFT_DOWN);

		handler.setInputAction((m: { endPosition: Cartesian2 }) => {
			const d = drag;
			if (!d) return;

			if (d.what === "radius") {
				// Radius is the ground distance from the circle's centre to the
				// cursor: drag the rim out to the size you want.
				const cur = $fenceItems.get().find((x) => x.seq === d.seq);
				if (!cur) return;
				const at = ground(m.endPosition);
				if (!at) return;
				const geodesic = new EllipsoidGeodesic(
					Cartographic.fromDegrees(cur.lon, cur.lat),
					Cartographic.fromDegrees(at.lon, at.lat),
					Ellipsoid.WGS84,
				);
				didDrag = true;
				updateFenceItem(d.seq, {
					params: { ...cur.params, radius: snap(clampRadius(geodesic.surfaceDistance)) },
				});
				$viewer.scene.requestRender();
				return;
			}

			if (d.what === "rally-alt") {
				// Same screen-space vertical projection as a waypoint's altitude
				// grabber, so the gesture behaves identically at any camera tilt.
				const cur = $rallyItems.get().find((x) => x.seq === d.seq);
				if (!cur) return;
				const here = Number.isFinite(cur.alt) ? (cur.alt as number) : 0;
				// Project at the MSL height it is drawn at; apply the result to the
				// stored above-home value.
				const drawn = drawHeightM(here, homeAltM($aircraftStore.get()));
				const base = Cartesian3.fromDegrees(cur.lon, cur.lat, drawn);
				const higher = Cartesian3.fromDegrees(cur.lon, cur.lat, drawn + ALT_SAMPLE_M);
				const s0 = SceneTransforms.worldToWindowCoordinates($viewer.scene, base);
				const s1 = SceneTransforms.worldToWindowCoordinates($viewer.scene, higher);
				if (!s0 || !s1) return;
				const delta = altDeltaFromDrag(
					{ x: m.endPosition.x - d.from.x, y: m.endPosition.y - d.from.y },
					{ x: s1.x - s0.x, y: s1.y - s0.y },
				);
				didDrag = true;
				updateRallyItem(d.seq, { alt: snap(clampAlt(d.startAlt + delta)) });
				$viewer.scene.requestRender();
				return;
			}

			// Lateral move of a fence vertex / circle centre / rally point.
			const at = ground(m.endPosition);
			if (!at) return;
			didDrag = true;
			if (d.what === "fence") moveFencePoint(d.seq, at.lat, at.lon);
			else moveRallyPoint(d.seq, at.lat, at.lon);
		}, ScreenSpaceEventType.MOUSE_MOVE);

		handler.setInputAction(() => {
			if (drag) {
				drag = null;
				$viewer.scene.screenSpaceCameraController.enableInputs = true;
				setTimeout(() => { didDrag = false; }, 0);
			}
		}, ScreenSpaceEventType.LEFT_UP);

		return () => {
			unsubF();
			unsubR();
			unsubE();
			handler.destroy();
			ents.forEach((e) => $viewer.entities.remove(e));
			ents = [];
			$viewer.scene.screenSpaceCameraController.enableInputs = true;
		};
	}, [$viewer]);

	return null;
}
