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
	Entity,
	LabelStyle,
	Math as CesiumMath,
	ScreenSpaceEventHandler,
	ScreenSpaceEventType,
	VerticalOrigin,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import { $handleDrag } from "@/stores/drag.store";
import { isOverHandle } from "@/lib/pickTag";
import { isTouchPrimary } from "@/lib/touchCamera";

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
// It yields to the handles. Hovering a waypoint marker, an altitude chevron, a
// radius rim or a fence corner hides the whole cursor: its plumb line and ground
// ring would otherwise sit on top of the very 9 px handle the operator is aiming
// at, hiding it and making the click look like it will land on the terrain
// instead. The handle is the thing being pointed at, so the pointer's own
// decoration gets out of the way, and the mouse pointer becomes an open hand.
//
// While a handle is HELD ($handleDrag) the cursor stops being a "where would a
// click land" probe. Drawn unchanged it looked exactly like the moment before a
// click that adds a waypoint, so a working radius drag read as a pending add.
// Held, the rod plants itself where the handle was grabbed and STAYS there
// while the mouse travels (a rod chasing the pointer read as the drag not
// having taken), turns aqua (the grabbers' colour) and heavier, its readout
// says what the drag is changing instead of lat/lon/MSL, and the pointer is a
// closed hand.
//
// Cost: one pick per mouse-move and three entities driven by callback
// properties, so nothing is created or destroyed as the mouse travels. The
// entities hide themselves whenever the cursor leaves the globe — sky, or off
// the canvas entirely.

const STEM_MIN_M = 120;   // always stand this tall, even flat-on from above
const STEM_FRAC = 0.04;   // ...and taller as the camera pulls back

const IDLE = Color.WHITE;
const HELD = Color.AQUA;

export default function CursorGround() {
	const $viewer = useStore($viewerStore);

	useEffect(() => {
		if (!$viewer) return;
		// Not on a touch screen. The whole layer answers "where is the pointer",
		// and a finger is not anywhere between taps: Cesium synthesises one
		// MOUSE_MOVE per touch, so the rod would plant itself where the operator
		// last tapped and stay there, reading as a live measurement of a place
		// nobody is pointing at. It is also drawn over the terrain the thumb is
		// about to drag. A phone gets no cursor decoration because it has no
		// cursor.
		if (isTouchPrimary()) return;

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
		const held = () => $handleDrag.get() !== null;
		const tint = (alpha: number) => (held() ? HELD : IDLE).withAlpha(alpha);

		const ents: Entity[] = [];

		// The vector itself: head down to the ground.
		ents.push($viewer.entities.add({
			polyline: {
				positions: new CallbackProperty(() => {
					const a = topPos();
					const b = groundPos();
					return a && b ? [a, b] : undefined;
				}, false),
				width: new CallbackProperty(() => (held() ? 3 : 1.5), false) as unknown as number,
				material: new ColorMaterialProperty(new CallbackProperty(() => tint(held() ? 0.9 : 0.6), false)),
				arcType: ArcType.NONE,
			},
		}));

		// The head of the rod: a point with depth testing off, so it survives a
		// grazing view and reads against bright terrain.
		//
		// It is at the TOP of the stem, not the bottom. The dot is what the eye
		// finds first, and at the foot of the rod it sat exactly where the ring
		// already is — two marks on the same pixels, so the dot added nothing and
		// the two together made a blob that was hard to place against texture. At
		// the head it is clear of the ground and of the ring, and it anchors the
		// readout written beside it: dot, numbers, then a line showing you which
		// patch of ground they describe. The ring remains the landing mark, which
		// is the one job the foot of the rod has.
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(topPos, false),
			point: {
				pixelSize: new CallbackProperty(() => (held() ? 9 : 6), false) as unknown as number,
				color: new CallbackProperty(() => tint(0.85), false) as unknown as Color,
				outlineColor: Color.BLACK.withAlpha(0.8),
				outlineWidth: 1,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
		}));

		// Where it lands: a ring, so the landing still reads from straight down
		// where the stem foreshortens to nothing.
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(groundPos, false),
			ellipse: {
				semiMajorAxis: new CallbackProperty(() => stem * 0.12, false) as unknown as number,
				semiMinorAxis: new CallbackProperty(() => stem * 0.12, false) as unknown as number,
				height: new CallbackProperty(() => ground?.height ?? 0, false) as unknown as number,
				material: Color.TRANSPARENT,
				outline: true,
				outlineColor: new CallbackProperty(() => tint(0.45), false) as unknown as Color,
			},
		}));

		// Ground truth beside the head: the numbers a position alone cannot say.
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(topPos, false),
			label: {
				text: new CallbackProperty(() => {
					if (!ground) return "";
					const drag = $handleDrag.get();
					if (drag) return drag.label;
					const lat = CesiumMath.toDegrees(ground.latitude);
					const lon = CesiumMath.toDegrees(ground.longitude);
					return `${lat.toFixed(5)}, ${lon.toFixed(5)}\n${Math.round(ground.height)} m MSL`;
				}, false),
				font: new CallbackProperty(() => (held() ? "bold 11px monospace" : "10px monospace"), false) as unknown as string,
				fillColor: new CallbackProperty(() => tint(held() ? 1 : 0.8), false) as unknown as Color,
				style: LabelStyle.FILL,
				verticalOrigin: VerticalOrigin.BOTTOM,
				// Clear of the head dot, which is now at this same position.
				pixelOffset: new Cartesian2(12, -6),
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
		}));

		let shown = false;
		const setShown = (next: boolean) => {
			shown = next;
			for (const e of ents) e.show = next;
		};
		setShown(false);

		const handler = new ScreenSpaceEventHandler($viewer.scene.canvas);

		const canvas = $viewer.scene.canvas;
		const setPointer = (c: string) => { if (canvas.style.cursor !== c) canvas.style.cursor = c; };
		// The pointer follows the drag even when the mouse is still, at the
		// press and the release.
		// Set once a held drag has planted the rod; cleared on release.
		let planted = false;
		const unsubDrag = $handleDrag.subscribe((d) => {
			setPointer(d ? "grabbing" : "");
			if (!d) planted = false;
			if (!$viewer.isDestroyed()) $viewer.scene.requestRender();
		});

		// Stand the rod on the ground under a pixel, or hide it off the globe.
		const placeAt = (px: Cartesian2) => {
			const scene = $viewer.scene;
			// Terrain first: globe.pick follows the loaded tiles, so the stem
			// stands on the hill the operator is actually looking at. The
			// ellipsoid is the honest fallback while those tiles stream in.
			const ray = scene.camera.getPickRay(px);
			const hit = (ray ? scene.globe.pick(ray, scene) : undefined)
				?? scene.camera.pickEllipsoid(px, scene.globe.ellipsoid);
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
			if (!was || !shown) setShown(true);
			scene.requestRender();
		};

		handler.setInputAction((m: { startPosition: Cartesian2; endPosition: Cartesian2 }) => {
			const scene = $viewer.scene;
			// A handle is held: plant the rod where the drag began (the first move
			// starts at the press) and leave it there; only its readout changes.
			if (held()) {
				if (!planted) { planted = true; placeAt(m.startPosition); }
				return;
			}
			// Over a draggable handle? Then stand down, so the handle is visible
			// and obviously the thing the click will hit. drillPick with a small
			// limit: the handles sit inside and behind translucent geometry, so
			// the topmost primitive is routinely not one of them.
			const overHandle = isOverHandle(scene.drillPick(m.endPosition, 6));
			setPointer(overHandle ? "grab" : "");
			if (overHandle) {
				if (ground !== null || shown) {
					ground = null;
					setShown(false);
					scene.requestRender();
				}
				return;
			}
			placeAt(m.endPosition);
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
			unsubDrag();
			setPointer("");
			handler.destroy();
			ents.forEach((e) => $viewer.entities.remove(e));
		};
	}, [$viewer]);

	return null;
}
