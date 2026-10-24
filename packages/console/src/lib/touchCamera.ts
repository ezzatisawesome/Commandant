// Camera feel on a touch screen.
//
// Cesium's camera controller is tuned for a mouse: a wheel that zooms in fixed
// notches, a drag with a button held, and a right-drag to tilt. On a phone the
// same controller is driving three gestures that a map user already has firm
// expectations about, learned from every map application they have ever used:
//
//   one finger    drag the ground, and it keeps gliding when you let go
//   two fingers   pinch to zoom; drag to tilt; twist to rotate
//   no finger     nothing moves
//
// Cesium does bind all three. What it does not do is make them feel like a map,
// and the gap is almost entirely in three places:
//
//  1. INERTIA. The defaults coast briefly and stop. A map's pan glides, which
//     is not cosmetic: a thumb can only sweep ~250 px, so without glide,
//     crossing the screen is four strokes and the operator loses the aircraft
//     between them.
//
//  2. ZOOM RANGE. The default floor is 1 m, which is right, but the default
//     controller will happily put the camera inside a hill; on a phone the
//     recovery gesture for that is not obvious. Collision detection on, with a
//     floor the operator can actually reach a wing from.
//
//  3. WHAT THE ZOOM AIMS AT. `enableCollisionDetection` plus a pinch anchored
//     at the gesture's own midpoint is the difference between zooming toward
//     the thing you pinched and zooming toward the middle of the screen.
//
// Expressed as data, like renderQuality: these are choices, they are the kind
// of choice that gets silently reverted by a dependency bump, and they are
// testable without a WebGL context.

export interface TouchCameraSettings {
	/** How long a released rotate/pan/zoom keeps coasting, 0..1 (higher = longer).
	 *
	 *  Cesium's defaults are 0.9 / 0.9 / 0.8, which coast for a few frames. A
	 *  map's pan glides for most of a second, and that is what makes a thumb
	 *  sweep worth a screen and a half instead of 250 px. */
	inertiaSpin: number;
	inertiaTranslate: number;
	inertiaZoom: number;
	/** Closest the camera may come to what it is looking at, metres. Close
	 *  enough to read a wing, far enough that the near plane does not clip it. */
	minimumZoomDistance: number;
	/** Keep the camera above the terrain. Flying the camera inside a hill is
	 *  recoverable with a mouse and bewildering with a thumb. */
	enableCollisionDetection: boolean;
	/** Free-look (drag the view direction without moving the camera). A mouse
	 *  has a spare button for this; touch does not, and Cesium binds it to the
	 *  same two-finger gesture as tilt, so the two fight. Tilt wins — it is the
	 *  gesture people know from maps. */
	enableLook: boolean;
	/** Two-finger tilt and twist. Both are map gestures and both stay. */
	enableTilt: boolean;
	enableRotate: boolean;
	enableTranslate: boolean;
	enableZoom: boolean;
}

export const TOUCH_CAMERA: TouchCameraSettings = {
	inertiaSpin: 0.95,
	inertiaTranslate: 0.95,
	inertiaZoom: 0.9,
	minimumZoomDistance: 2,
	enableCollisionDetection: true,
	enableLook: false,
	enableTilt: true,
	enableRotate: true,
	enableTranslate: true,
	enableZoom: true,
};

/** The parts of a Cesium viewer this touches, so it can be driven by a double. */
export interface CameraTarget {
	scene: {
		screenSpaceCameraController: {
			inertiaSpin: number;
			inertiaTranslate: number;
			inertiaZoom: number;
			minimumZoomDistance: number;
			enableCollisionDetection: boolean;
			enableLook: boolean;
			enableTilt: boolean;
			enableRotate: boolean;
			enableTranslate: boolean;
			enableZoom: boolean;
		};
	};
}

/** Apply the settings. Returns the target, for chaining in tests. */
export function applyTouchCamera<T extends CameraTarget>(
	viewer: T, s: TouchCameraSettings = TOUCH_CAMERA,
): T {
	const c = viewer.scene.screenSpaceCameraController;
	c.inertiaSpin = s.inertiaSpin;
	c.inertiaTranslate = s.inertiaTranslate;
	c.inertiaZoom = s.inertiaZoom;
	c.minimumZoomDistance = s.minimumZoomDistance;
	c.enableCollisionDetection = s.enableCollisionDetection;
	c.enableLook = s.enableLook;
	c.enableTilt = s.enableTilt;
	c.enableRotate = s.enableRotate;
	c.enableTranslate = s.enableTranslate;
	c.enableZoom = s.enableZoom;
	return viewer;
}

/**
 * Is the primary pointer on this device a finger?
 *
 * Asked of the device's capability, not of its screen width: a narrow desktop
 * window is still a mouse, and a 1024 px tablet is still a thumb. `any-pointer`
 * would be wrong in the other direction — a laptop with a touchscreen is used
 * with its trackpad.
 *
 * Used to decide whether a hover-only affordance is worth drawing at all. SSR
 * and jsdom have no matchMedia, so the answer there is "mouse", which is the
 * safe default: it draws something rather than nothing.
 */
export function isTouchPrimary(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	return window.matchMedia("(pointer: coarse)").matches;
}
