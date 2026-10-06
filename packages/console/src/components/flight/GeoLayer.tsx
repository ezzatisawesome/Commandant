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
	PolygonHierarchy,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
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
	isCircleKind,
	isPolygonKind,
	moveFencePoint,
	moveRallyPoint,
} from "@/stores/geo.store";
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
export default function GeoLayer() {
	const $viewer = useStore($viewerStore);

	useEffect(() => {
		if (!$viewer) return;
		const alt = () => $aircraftStore.get()?.alt ?? 0;

		// Geo entities are rebuilt only when either set changes STRUCTURALLY
		// (count/kind/order). Positions and radii are read live through callback
		// properties so a marker drag never tears everything down per mouse-move.
		let ents: Entity[] = [];
		let structure = "";
		const rebuild = () => {
			const sig = $fenceItems.get().map((it) => `${it.seq}:${it.kind}`).join(",")
				+ "|" + $rallyItems.get().map((it) => it.seq).join(",");
			if (sig === structure) return;
			structure = sig;
			ents.forEach((e) => $viewer.entities.remove(e));
			ents = [];
			const fence = $fenceItems.get();
			// Live polygon vertices for the run [i, j) of the same kind.
			const polyPositions = (kind: FenceItem["kind"], i: number, j: number) => () => {
				const cur = $fenceItems.get();
				const pts: Cartesian3[] = [];
				for (let k = i; k < j && k < cur.length; k++) {
					const g = cur[k];
					if (g.kind !== kind) break;
					pts.push(Cartesian3.fromDegrees(g.lon, g.lat, 0));
				}
				return pts.length >= 3 ? new PolygonHierarchy(pts) : undefined;
			};

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
						// No `height`: a ground polygon is clamped to the terrain mesh.
						// With an explicit height 0 it sat at the ellipsoid and was
						// buried under any terrain above sea level.
						ents.push($viewer.entities.add({
							polygon: {
								hierarchy: new CallbackProperty(polyPositions(it.kind, i, j), false),
								material: col.withAlpha(0.12),
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
				const radius = new CallbackProperty(
					() => $fenceItems.get().find((x) => x.seq === seq)?.params?.radius ?? 100, false);
				ents.push($viewer.entities.add({
					position: new CallbackPositionProperty(() => {
						const cur = $fenceItems.get().find((x) => x.seq === seq);
						return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, 0) : undefined;
					}, false),
					ellipse: {
						semiMajorAxis: radius,
						semiMinorAxis: radius,
						material: col.withAlpha(0.12),
						outline: true,
						outlineColor: col.withAlpha(0.8),
					},
				}));
			}

			// Draggable, numbered markers for every fence point…
			for (const it of fence) {
				const seq = it.seq;
				ents.push($viewer.entities.add({
					id: `geo-fence-${seq}`,
					position: new CallbackPositionProperty(() => {
						const cur = $fenceItems.get().find((x) => x.seq === seq);
						return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, alt()) : undefined;
					}, false),
					point: { pixelSize: 9, color: fenceColor(it.kind), outlineColor: Color.BLACK, outlineWidth: 1 },
					label: {
						text: `${seq}`, font: "11px monospace", fillColor: Color.WHITE,
						style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
						pixelOffset: new Cartesian2(0, -10),
					},
				}));
			}
			// …and every rally point.
			for (const it of $rallyItems.get()) {
				const seq = it.seq;
				ents.push($viewer.entities.add({
					id: `geo-rally-${seq}`,
					position: new CallbackPositionProperty(() => {
						const cur = $rallyItems.get().find((x) => x.seq === seq);
						return cur ? Cartesian3.fromDegrees(cur.lon, cur.lat, alt()) : undefined;
					}, false),
					point: { pixelSize: 11, color: Color.CYAN, outlineColor: Color.BLACK, outlineWidth: 1 },
					label: {
						text: `R${seq}`, font: "11px monospace", fillColor: Color.CYAN,
						style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
						pixelOffset: new Cartesian2(0, -10),
					},
				}));
			}
			$viewer.scene.requestRender();
		};
		rebuild();
		const unsubF = $fenceItems.subscribe(rebuild);
		const unsubR = $rallyItems.subscribe(rebuild);

		// --- authoring: click to place, drag to move -------------------------
		const handler = new ScreenSpaceEventHandler($viewer.scene.canvas);
		let drag: { kind: "fence" | "rally"; seq: number } | null = null;
		let didDrag = false;

		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW || !$geoEdit.get() || didDrag) return;
			const cart = $viewer.camera.pickEllipsoid(m.position, $viewer.scene.globe.ellipsoid);
			if (!cart) return;
			const geo = Cartographic.fromCartesian(cart);
			const lat = CesiumMath.toDegrees(geo.latitude);
			const lon = CesiumMath.toDegrees(geo.longitude);
			const kind = $geoPlaceKind.get();
			if (kind === "rally") addRallyPoint(lat, lon, alt());
			else addFencePoint(kind, lat, lon);
		}, ScreenSpaceEventType.LEFT_CLICK);

		handler.setInputAction((m: { position: Cartesian2 }) => {
			if (IS_VIEW) return;  // read-only: markers are not draggable
			const picked = $viewer.scene.pick(m.position);
			const id: unknown = picked?.id?.id;
			if (typeof id !== "string") return;
			if (id.startsWith("geo-fence-")) drag = { kind: "fence", seq: Number(id.slice("geo-fence-".length)) };
			else if (id.startsWith("geo-rally-")) drag = { kind: "rally", seq: Number(id.slice("geo-rally-".length)) };
			else return;
			didDrag = false;
			$viewer.scene.screenSpaceCameraController.enableInputs = false;
		}, ScreenSpaceEventType.LEFT_DOWN);

		handler.setInputAction((m: { endPosition: Cartesian2 }) => {
			if (!drag) return;
			const cart = $viewer.camera.pickEllipsoid(m.endPosition, $viewer.scene.globe.ellipsoid);
			if (!cart) return;
			const geo = Cartographic.fromCartesian(cart);
			didDrag = true;
			const lat = CesiumMath.toDegrees(geo.latitude);
			const lon = CesiumMath.toDegrees(geo.longitude);
			if (drag.kind === "fence") moveFencePoint(drag.seq, lat, lon);
			else moveRallyPoint(drag.seq, lat, lon);
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
			handler.destroy();
			ents.forEach((e) => $viewer.entities.remove(e));
			ents = [];
			$viewer.scene.screenSpaceCameraController.enableInputs = true;
		};
	}, [$viewer]);

	return null;
}
