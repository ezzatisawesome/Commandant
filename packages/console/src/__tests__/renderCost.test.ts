import { describe, it, expect, beforeEach } from "vitest";

import {
	$aircraftStore, $hudFrame, $historyStore, $trailStore, $targetTrailStore,
	pushFrame,
} from "@/stores/aircraft.store";
import type { TelemetryFrame } from "@/types/app";

// Every store notification at 25 Hz becomes React work, Cesium work, or both.
// These tests measure that cost so a regression is visible rather than felt as
// "the fan is loud". Numbers are budgets, not trivia: exceed one and the UI got
// more expensive per frame.

const M_PER_DEG = 111_320;

/** A frame `metres` north of Coyote Hill at time `t`. */
const frameAt = (t: number, metres: number, over: Partial<TelemetryFrame> = {}): TelemetryFrame => ({
	t, connected: true,
	lat: 37.3985511 + metres / M_PER_DEG,
	lon: -122.148853,
	alt: 233, ...over,
});

function countNotifications(run: () => void) {
	const counts = { aircraft: 0, hud: 0, history: 0, trail: 0, target: 0 };
	const un = [
		$aircraftStore.listen(() => counts.aircraft++),
		$hudFrame.listen(() => counts.hud++),
		$historyStore.listen(() => counts.history++),
		$trailStore.listen(() => counts.trail++),
		$targetTrailStore.listen(() => counts.target++),
	];
	run();
	un.forEach((u) => u());
	return counts;
}

beforeEach(() => {
	$aircraftStore.set(null); $hudFrame.set(null);
	$historyStore.set([]); $trailStore.set([]); $targetTrailStore.set([]);
	pushFrame(frameAt(0, 0, { connected: false }));   // settle the run-boundary edge
	$trailStore.set([]); $historyStore.set([]);
});

describe("per-frame store cost at 25 Hz", () => {
	it("a stationary aircraft costs nothing beyond the latest-frame stores", () => {
		// 4 s of 25 Hz with the aircraft parked. The trail must not grow and must
		// not notify: a decimated point should return the SAME array reference, and
		// nanostores skips notifying when the reference is unchanged.
		const c = countNotifications(() => {
			for (let i = 0; i < 100; i++) pushFrame(frameAt(10_000 + i * 40, 0));
		});
		expect(c.aircraft).toBe(100);          // Cesium reads this; full rate is correct
		// 100 frames at 25 Hz is 4 s; a 10 Hz budget allows ~40 notifications.
		expect(c.hud).toBeLessThanOrEqual(42); // React reads this; throttled to ~10 Hz
		expect(c.trail).toBeLessThanOrEqual(1); // one seed vertex, then nothing
		expect($trailStore.get().length).toBeLessThanOrEqual(1);
	});

	it("a moving aircraft appends only when it has moved far enough to matter", () => {
		// 15 m/s for 4 s = 60 m. At a 2 m decimation floor that is ~30 vertices,
		// not the 100 frames that arrived.
		const c = countNotifications(() => {
			for (let i = 0; i < 100; i++) pushFrame(frameAt(20_000 + i * 40, i * 0.6));
		});
		expect(c.trail).toBeGreaterThan(20);
		expect(c.trail).toBeLessThanOrEqual(35);
		expect(c.trail).toBeLessThan(100);     // the point of decimation
	});

	it("history stays at its 4 Hz budget regardless of frame rate", () => {
		const c = countNotifications(() => {
			for (let i = 0; i < 100; i++) pushFrame(frameAt(30_000 + i * 40, i * 0.6));
		});
		expect(c.history).toBeLessThanOrEqual(17);   // 4 s at 4 Hz, plus slack
	});

	it("the setpoint trail costs nothing when no setpoint is present", () => {
		const c = countNotifications(() => {
			for (let i = 0; i < 100; i++) pushFrame(frameAt(40_000 + i * 40, i * 0.6));
		});
		expect(c.target).toBe(0);
	});

	it("bounded growth holds over a long flight", () => {
		// 20 minutes at 25 Hz, moving the whole time: caps must hold and memory
		// must not creep, which is what a days-long flight depends on.
		for (let i = 0; i < 30_000; i++) pushFrame(frameAt(100_000 + i * 40, i * 0.6));
		expect($trailStore.get().length).toBeLessThanOrEqual(3000);
		expect($historyStore.get().length).toBeLessThanOrEqual(480);
	});
});

describe("frame identity", () => {
	it("reuses the trail array when nothing was appended, so Cesium re-uploads nothing", () => {
		pushFrame(frameAt(50_000, 0));
		const first = $trailStore.get();
		pushFrame(frameAt(50_040, 0.1));        // 10 cm: below the decimation floor
		expect($trailStore.get()).toBe(first);  // same reference, not a copy
	});
});
