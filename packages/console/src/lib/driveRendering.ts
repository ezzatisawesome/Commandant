// Drive Cesium's on-demand rendering from the data, not from the display clock.
//
// `requestRenderMode: true` makes Cesium redraw only when it is asked to. It
// detects camera moves and tile loads itself, but it cannot see a
// CallbackProperty changing — and every moving thing in this scene (the model,
// its orientation, both trails, the setpoint marker, the mission markers, the
// fence rings) is a CallbackProperty. So something has to translate "new data
// arrived" into "please draw a frame". That is this.
//
// Without it the scene freezes visually. Data alone sets the render rate for
// everything but the aircraft; the aircraft, while its drawn pose is easing
// between samples (lib/poseEase), draws on every display frame.

import type { Viewer } from "cesium";

import {
	$aircraftStore, $trailTail, $targetTail,
} from "@/stores/aircraft.store";
import { $missionItems, $missionCurrent, $missionReached } from "@/stores/mission.store";
import { $fenceItems, $rallyItems } from "@/stores/geo.store";
import { $derived } from "@/stores/derived.store";
import {
	$showTriad, $showHorizPlane, $showClearance, $showWind, $showSun,
} from "@/stores/viewControls.store";
import { easeUntilMs } from "@/lib/poseEase";

/**
 * Hard ceiling on requested frames per second.
 *
 * Telemetry is 25 Hz locally, but a burst — a reconnect replaying retained
 * state, several stores changing in one tick — must not translate into a burst
 * of renders.
 *
 * It was 15, MEASURED to cut main-thread script time by 31% with the CPU
 * throttled 4x beside a SITL holding three of eight cores. But at 15 Hz the
 * aircraft visibly stepped (12 Hz in practice: a 25 Hz sample landing inside
 * the budget was dropped), which is what an operator watching the model --
 * its surfaces, its wing loads -- reads as a broken frame rate. 60 with the
 * pose eased between samples is smooth; the cost is the per-frame scene
 * update, paid only while the aircraft moves. Camera drags and tile loads are
 * Cesium's own renders and never pass through this cap.
 */
const MAX_FPS = 60;
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

	// While the aircraft's drawn pose is still easing toward its newest sample,
	// draw every animation frame (within the cap), and once more when it lands.
	// A parked aircraft eases nowhere, so it costs only the data renders above.
	// 0.9: rAF's own period jitters around 1/60 s, and a frame that arrives a
	// hair early must not be skipped.
	let easing = false;
	let moved = false;      // this run of the loop drew an eased (in-between) pose
	const ease = () => {
		if (disposed || viewer.isDestroyed()) { easing = false; return; }
		const now = performance.now();
		const landed = now >= easeUntilMs();
		if ((landed && moved) || (!landed && now - lastAt >= 0.9 * MIN_INTERVAL_MS)) {
			lastAt = now;
			viewer.scene.requestRender();
		}
		if (landed) { easing = false; return; }
		moved = true;
		requestAnimationFrame(ease);
	};
	const onAircraft = () => {
		request();
		if (easing || typeof requestAnimationFrame !== "function") return;
		easing = true;
		moved = false;
		requestAnimationFrame(ease);
	};

	// `listen` rather than `subscribe`: subscribe fires immediately on attach,
	// which would request a render per store just for mounting.
	const unsubscribers = [
		$aircraftStore.listen(onAircraft),
		$trailTail.listen(request),
		$targetTail.listen(request),
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
