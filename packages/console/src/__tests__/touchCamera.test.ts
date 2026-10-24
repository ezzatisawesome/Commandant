import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyTouchCamera, TOUCH_CAMERA, type CameraTarget } from "@/lib/touchCamera";

// The console is read on a phone in the field, where every gesture is a thumb.
// Cesium's camera defaults are a mouse's defaults, and the difference is not
// cosmetic: without glide a thumb sweep moves 250 px, and the operator loses
// the aircraft between strokes. These pin the choices, the way renderQuality's
// tests pin that scene's.

// Cesium's own defaults, so the test asserts a CHANGE rather than agreement
// with whatever the library happens to ship.
function fakeViewer(): CameraTarget {
	return {
		scene: {
			screenSpaceCameraController: {
				inertiaSpin: 0.9,
				inertiaTranslate: 0.9,
				inertiaZoom: 0.8,
				minimumZoomDistance: 1,
				enableCollisionDetection: true,
				enableLook: true,
				enableTilt: true,
				enableRotate: true,
				enableTranslate: true,
				enableZoom: true,
			},
		},
	};
}

describe("touch camera", () => {
	it("glides further than Cesium's defaults on every axis", () => {
		const d = fakeViewer().scene.screenSpaceCameraController;
		const c = applyTouchCamera(fakeViewer()).scene.screenSpaceCameraController;
		expect(c.inertiaSpin).toBeGreaterThan(d.inertiaSpin);
		expect(c.inertiaTranslate).toBeGreaterThan(d.inertiaTranslate);
		expect(c.inertiaZoom).toBeGreaterThan(d.inertiaZoom);
		// Inertia is a decay factor, not a duration: at 1 the camera never stops,
		// which on a map is a scene that drifts away while nobody is touching it.
		for (const v of [c.inertiaSpin, c.inertiaTranslate, c.inertiaZoom]) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(1);
		}
	});

	it("keeps the camera above the terrain", () => {
		// Recoverable with a mouse, bewildering with a thumb: there is no obvious
		// gesture for "I am inside a hill".
		const c = applyTouchCamera(fakeViewer()).scene.screenSpaceCameraController;
		expect(c.enableCollisionDetection).toBe(true);
		expect(c.minimumZoomDistance).toBeGreaterThan(0);
	});

	it("drops free-look, which fights the two-finger tilt", () => {
		// Cesium binds both to the same touch gesture. Tilt is the one people know
		// from every map they have used, so it is the one that keeps the gesture.
		const c = applyTouchCamera(fakeViewer()).scene.screenSpaceCameraController;
		expect(c.enableLook).toBe(false);
		expect(c.enableTilt).toBe(true);
	});

	it("leaves pan, pinch and twist enabled", () => {
		// The three map gestures. Disabling any of them strands a phone operator:
		// there is no keyboard or wheel to fall back on.
		const c = applyTouchCamera(fakeViewer()).scene.screenSpaceCameraController;
		expect(c.enableTranslate).toBe(true);
		expect(c.enableZoom).toBe(true);
		expect(c.enableRotate).toBe(true);
	});

	it("can be overridden wholesale", () => {
		const c = applyTouchCamera(fakeViewer(), {
			...TOUCH_CAMERA, inertiaTranslate: 0.5, enableLook: true,
		}).scene.screenSpaceCameraController;
		expect(c.inertiaTranslate).toBe(0.5);
		expect(c.enableLook).toBe(true);
	});
});

describe("touch detection", () => {
	it("asks about the pointer, not about the window width", () => {
		// A narrow desktop window is still a mouse; a 1024 px tablet is still a
		// thumb. `any-pointer` would be wrong the other way — a touchscreen laptop
		// is used with its trackpad.
		const SRC = readFileSync(join(__dirname, "..", "lib", "touchCamera.ts"), "utf8");
		expect(SRC).toContain('matchMedia("(pointer: coarse)")');
		expect(SRC).not.toContain("innerWidth");
		expect(SRC).not.toContain('matchMedia("(any-pointer');
	});
});
