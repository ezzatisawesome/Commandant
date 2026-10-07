// Drive Cesium's on-demand rendering from the data, not from the display clock.
//
// `requestRenderMode: true` makes Cesium redraw only when it is asked to. It
// detects camera moves and tile loads itself, but it cannot see a
// CallbackProperty changing — and every moving thing in this scene (the model,
// its orientation, both trails, the setpoint marker, the mission markers, the
// fence rings) is a CallbackProperty. So something has to translate "new data
// arrived" into "please draw a frame". That is this.
//
// Without it the scene freezes visually; with it, render rate equals data rate.

import type { Viewer } from "cesium";

import { $aircraftStore, $trailStore, $targetTrailStore } from "@/stores/aircraft.store";
import { $missionItems, $missionCurrent, $missionReached } from "@/stores/mission.store";
import { $fenceItems, $rallyItems } from "@/stores/geo.store";
import { $derived } from "@/stores/derived.store";
import {
	$showTriad, $showHorizPlane, $showClearance, $showWind, $showSun,
} from "@/stores/viewControls.store";

/** Hard ceiling on requested frames per second. Telemetry is 25 Hz locally but a
 *  burst (a reconnect replaying retained state, several stores changing in one
 *  tick) must not translate into a burst of renders. */
const MAX_FPS = 30;
const MIN_INTERVAL_MS = 1000 / MAX_FPS;

/**
 * Subscribe to everything the scene draws and request a frame when it changes.
 * Returns an unsubscribe function.
 *
 * Coalescing matters: one telemetry frame updates several stores, and each would
 * otherwise ask for its own render. We collapse them into at most one request
 * per animation frame, and never faster than MAX_FPS.
 */
export function driveRendering(viewer: Viewer): () => void {
	let queued = false;
	let lastAt = 0;
	let disposed = false;

	const request = () => {
		if (disposed || queued) return;
		queued = true;
		// requestAnimationFrame collapses every store that changed in this tick
		// into a single render request.
		const fire = () => {
			queued = false;
			if (disposed || viewer.isDestroyed()) return;
			const now = performance.now();
			if (now - lastAt < MIN_INTERVAL_MS) return;   // over budget; the next change will ask again
			lastAt = now;
			viewer.scene.requestRender();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(fire);
		else setTimeout(fire, 0);
	};

	// `listen` rather than `subscribe`: subscribe fires immediately on attach,
	// which would request a render per store just for mounting.
	const unsubscribers = [
		$aircraftStore.listen(request),
		$trailStore.listen(request),
		$targetTrailStore.listen(request),
		$missionItems.listen(request),
		$missionCurrent.listen(request),
		$missionReached.listen(request),
		$fenceItems.listen(request),
		$rallyItems.listen(request),
		$showTriad.listen(request),
		$showHorizPlane.listen(request),
		$showClearance.listen(request),
		$showWind.listen(request),
		$showSun.listen(request),
		$derived.listen(request),
	];

	// One render now so the scene is not blank until the first frame arrives.
	request();

	return () => {
		disposed = true;
		unsubscribers.forEach((u) => u());
	};
}
