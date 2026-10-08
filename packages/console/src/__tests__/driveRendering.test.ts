import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { driveRendering } from "@/lib/driveRendering";
import { $aircraftStore, $trailStore, pushFrame } from "@/stores/aircraft.store";
import { $missionItems } from "@/stores/mission.store";
import type { TelemetryFrame } from "@/types/app";

// A stand-in for the Cesium Viewer: all driveRendering touches is
// scene.requestRender() and isDestroyed().
function fakeViewer() {
	const v = {
		renders: 0,
		destroyed: false,
		scene: { requestRender: () => { v.renders++; } },
		isDestroyed: () => v.destroyed,
	};
	return v;
}

/** Run every queued requestAnimationFrame callback. */
function flushFrames() {
	vi.advanceTimersByTime(17);
}

const frameAt = (t: number, metres: number): TelemetryFrame => ({
	t, connected: true,
	lat: 37.3985511 + metres / 111_320,
	lon: -122.148853, alt: 233,
});

let stop: (() => void) | null = null;

beforeEach(() => {
	// Fake rAF on top of fake timers so coalescing is deterministic.
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
	vi.stubGlobal("performance", { now: () => Date.now() });
	$aircraftStore.set(null); $trailStore.set([]); $missionItems.set([]);
	pushFrame({ t: 0, connected: false });
});
afterEach(() => {
	stop?.(); stop = null;
	vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("driveRendering", () => {
	it("renders once on attach so the scene is not blank", () => {
		const v = fakeViewer();
		stop = driveRendering(v as never);
		flushFrames();
		expect(v.renders).toBe(1);
	});

	it("coalesces several stores changing in one tick into ONE render", () => {
		const v = fakeViewer();
		stop = driveRendering(v as never);
		flushFrames();
		// Clear the rate-limit window so this measures coalescing, not the FPS cap
		// (the cap is covered by its own test below).
		vi.advanceTimersByTime(100);
		const base = v.renders;

		// A single telemetry frame moves $aircraftStore AND $trailStore.
		pushFrame(frameAt(10_000, 0));
		pushFrame(frameAt(10_040, 5));
		$missionItems.set([{ seq: 0, kind: "waypoint", lat: 37.4, lon: -122.1, alt: 100 }]);
		flushFrames();

		expect(v.renders).toBe(base + 1);   // not one per store, not one per frame
	});

	it("caps the render rate even under a burst of changes", () => {
		const v = fakeViewer();
		stop = driveRendering(v as never);
		flushFrames();
		const base = v.renders;

		// 100 frames of data inside ~200 ms of wall time. At a 30 fps ceiling that
		// is at most ~6 renders, not 100.
		for (let i = 0; i < 100; i++) {
			pushFrame(frameAt(20_000 + i * 40, i * 5));
			vi.advanceTimersByTime(2);
		}
		flushFrames();
		expect(v.renders - base).toBeLessThanOrEqual(8);
	});

	it("asks for a frame whenever data actually moves, over time", () => {
		const v = fakeViewer();
		stop = driveRendering(v as never);
		flushFrames();
		const base = v.renders;

		// Spread changes well apart: each should earn its own render.
		for (let i = 0; i < 5; i++) {
			pushFrame(frameAt(30_000 + i * 40, i * 5));
			vi.advanceTimersByTime(100);
		}
		expect(v.renders - base).toBeGreaterThanOrEqual(4);
	});

	it("requests nothing once the aircraft is parked", () => {
		const v = fakeViewer();
		stop = driveRendering(v as never);
		pushFrame(frameAt(40_000, 0));
		vi.advanceTimersByTime(200);
		const settled = v.renders;

		// Same position, 2 s of frames. $aircraftStore still changes (new object
		// each frame) so some renders are expected, but the trail must contribute
		// nothing — this is the "parked aircraft costs 60 fps" bug, now bounded.
		for (let i = 0; i < 50; i++) {
			pushFrame(frameAt(41_000 + i * 40, 0));
			vi.advanceTimersByTime(40);
		}
		// 2 s at a 30 fps ceiling is 60 renders max; well under the 120 that
		// continuous rendering at display refresh would have cost.
		expect(v.renders - settled).toBeLessThanOrEqual(60);
	});

	it("stops requesting after unsubscribe and after the viewer is destroyed", () => {
		const v = fakeViewer();
		const off = driveRendering(v as never);
		flushFrames();
		off();
		const after = v.renders;
		pushFrame(frameAt(50_000, 10));
		flushFrames();
		expect(v.renders).toBe(after);

		// And a destroyed viewer is never drawn into.
		const v2 = fakeViewer();
		stop = driveRendering(v2 as never);
		v2.destroyed = true;
		pushFrame(frameAt(60_000, 20));
		flushFrames();
		expect(v2.renders).toBe(0);
	});
});
