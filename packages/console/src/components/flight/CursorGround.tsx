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
	Entity,
	LabelStyle,
	Math as CesiumMath,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
	VerticalOrigin,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";

// Where is the mouse, in the world?
//
// On a tilted globe the cursor is two-dimensional and the terrain under it is
// not: the same pixel is a hilltop near the camera or a valley floor ten
// kilometres out, and nothing on screen says which. So the cursor gets a plumb
// line — a vertical vector standing over the point it picks, a ring where it
// meets the ground, and the ground truth (lat/lon and terrain elevation)
// written beside its head.
//
// It is drawn in the one colour the scene has left. cyan=track,
// orange=commanded, white=plan, yellow=active item, green/red=fence,
// aqua=radius grabbers; the cursor's vector is thin translucent white, so it
// reads as chrome rather than as data.
//
// Cost: one pick per mouse-move and three entities driven by callback
// properties, so nothing is created or destroyed as the mouse travels. The
// entities hide themselves whenever the cursor leaves the globe — sky, or off
// the canvas entirely.

const STEM_MIN_M = 120;   // always stand this tall, even flat-on from above
const STEM_FRAC = 0.04;   // ...and taller as the camera pulls back

export default function CursorGround() {
	const $viewer = useStore($viewerStore);

	useEffect(() => {
		if (!$viewer) return;

		// The live cursor target: a ground position and the stem height to draw
		// above it. Held in the closure and read by the callbacks below, so a
		// mouse-move is an assignment and a requestRender, not a rebuild.
		let ground: Cartographic | null = null;
		let stem = STEM_MIN_M;

		const atHeight = (extra: number): Cartesian3 | undefined =>
			ground
				? Cartesian3.fromDegrees(
					CesiumMath.toDegrees(ground.longitude),
					CesiumMath.toDegrees(ground.latitude),
					ground.height + extra,
				)
				: undefined;

		const groundPos = () => atHeight(0);
		const topPos = () => atHeight(stem);

		const ents: Entity[] = [];

		// The vector itself: head down to the ground.
		ents.push($viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => {
					const a = topPos();
					const b = groundPos();
					return a && b ? [a, b] : undefined;
				}, false),
				width: 1.5,
				material: Color.WHITE.withAlpha(0.6),
				arcType: ArcType.NONE,
			},
		}));

		// Where it lands: a point with depth testing off, so it survives a
		// grazing view, plus a ring so the landing still reads from straight down
		// where the stem foreshortens to nothing.
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(groundPos, false),
			point: {
				pixelSize: 6,
				color: Color.WHITE.withAlpha(0.85),
				outlineColor: Color.BLACK.withAlpha(0.8),
				outlineWidth: 1,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			ellipse: {
				semiMajorAxis: new CallbackProperty(() => stem * 0.12, false) as unknown as number,
				semiMinorAxis: new CallbackProperty(() => stem * 0.12, false) as unknown as number,
				height: new CallbackProperty(() => ground?.height ?? 0, false) as unknown as number,
				material: Color.TRANSPARENT,
				outline: true,
				outlineColor: Color.WHITE.withAlpha(0.45),
			},
		}));

		// Ground truth beside the head: the numbers a position alone cannot say.
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(topPos, false),
			label: {
				text: new CallbackProperty(() => {
					if (!ground) return "";
					const lat = CesiumMath.toDegrees(ground.latitude);
					const lon = CesiumMath.toDegrees(ground.longitude);
					return `${lat.toFixed(5)}, ${lon.toFixed(5)}\n${Math.round(ground.height)} m MSL`;
				}, false),
				font: "10px monospace",
				fillColor: Color.WHITE.withAlpha(0.8),
				style: LabelStyle.FILL,
				verticalOrigin: VerticalOrigin.BOTTOM,
				pixelOffset: new Cartesian2(10, -4),
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
		}));

		const setShown = (shown: boolean) => {
			for (const e of ents) e.show = shown;
		};
		setShown(false);

		const handler = new ScreenSpaceEventHandler($viewer.scene.canvas);

		handler.setInputAction((m: { endPosition: Cartesian2 }) => {
			const scene = $viewer.scene;
			// Terrain first: globe.pick follows the loaded tiles, so the stem
			// stands on the hill the operator is actually looking at. The
			// ellipsoid is the honest fallback while those tiles stream in.
			const ray = scene.camera.getPickRay(m.endPosition);
			const hit = (ray ? scene.globe.pick(ray, scene) : undefined)
				?? scene.camera.pickEllipsoid(m.endPosition, scene.globe.ellipsoid);
			const was = ground !== null;
			if (!hit) {
				ground = null;
				if (was) { setShown(false); scene.requestRender(); }
				return;
			}
			ground = Cartographic.fromCartesian(hit);
			// Scale the stem with viewing distance: a visible vector from orbit,
			// not a flagpole seen from fifty metres up.
			const dist = Cartesian3.distance(scene.camera.positionWC, hit);
			stem = Math.max(STEM_MIN_M, dist * STEM_FRAC);
			if (!was) setShown(true);
			scene.requestRender();
		}, ScreenSpaceEventType.MOUSE_MOVE);

		// Leaving the canvas takes the cursor's shadow with it.
		const onLeave = () => {
			ground = null;
			setShown(false);
			if (!$viewer.isDestroyed()) $viewer.scene.requestRender();
		};
		$viewer.scene.canvas.addEventListener("pointerleave", onLeave);

		return () => {
			$viewer.scene.canvas.removeEventListener("pointerleave", onLeave);
			handler.destroy();
			ents.forEach((e) => $viewer.entities.remove(e));
		};
	}, [$viewer]);

	return null;
}
