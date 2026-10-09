import { describe, it, expect } from "vitest";

import { applyQuality, QUALITY, type QualityTarget } from "@/lib/renderQuality";

// These settings were Cesium defaults nobody chose. Pinning them matters because
// a default can change under a dependency bump and quietly put two full-screen
// antialiasing passes, or 871 KB of star field, back on a machine already
// sharing its cores with a flight simulator.

function fakeViewer(): QualityTarget {
	return {
		scene: {
			msaaSamples: 4,
			fog: { enabled: true },
			globe: { maximumScreenSpaceError: 2 },
			postProcessStages: { fxaa: { enabled: true } },
			skyBox: { show: true },
			sun: { show: true },
			moon: { show: true },
		},
	};
}

describe("render quality", () => {
	it("turns off both antialiasing passes", () => {
		// Together these are 6.6 of the 6.3 ms measured saving (they overlap
		// slightly). MSAA alone is 4.70 ms of it.
		const v = applyQuality(fakeViewer());
		expect(v.scene.msaaSamples).toBe(1);
		expect(v.scene.postProcessStages.fxaa.enabled).toBe(false);
	});

	it("leaves terrain refinement at Cesium's default", () => {
		// Raising it was measured at 0.40 ms per frame and 38 KB out of 7.3 MB,
		// both inside noise, so it was reverted rather than kept for the look of
		// an optimisation. This test is what stops it drifting back in.
		expect(QUALITY.maximumScreenSpaceError).toBe(2);
		expect(applyQuality(fakeViewer()).scene.globe.maximumScreenSpaceError).toBe(2);
	});

	it("removes the skybox object rather than just hiding it", () => {
		// `show = false` would still leave the six cube faces fetched: Cesium
		// requests them when the skybox is constructed. Dropping the object is
		// what saves the 871 KB.
		expect(applyQuality(fakeViewer()).scene.skyBox).toBeUndefined();
	});

	it("hides the sun and moon sprites without touching the lighting", () => {
		// The terminator comes from globe.enableLighting and the clock, which this
		// does not go near. Only the two billboards in the sky are affected.
		const v = applyQuality(fakeViewer());
		expect(v.scene.sun?.show).toBe(false);
		expect(v.scene.moon?.show).toBe(false);
	});

	it("keeps fog, which the day/night lighting reads against", () => {
		expect(applyQuality(fakeViewer()).scene.fog.enabled).toBe(true);
	});

	it("survives a viewer with no skybox, sun or moon at all", () => {
		// Cesium constructs these lazily in some configurations, and a viewer
		// created without them must not throw on startup.
		const bare: QualityTarget = {
			scene: {
				msaaSamples: 4,
				fog: { enabled: true },
				globe: { maximumScreenSpaceError: 2 },
				postProcessStages: { fxaa: { enabled: true } },
			},
		};
		expect(() => applyQuality(bare)).not.toThrow();
		expect(bare.scene.msaaSamples).toBe(1);
	});

	it("can be overridden for a machine that wants the pretty version", () => {
		const v = applyQuality(fakeViewer(), {
			msaaSamples: 4, fxaa: true, maximumScreenSpaceError: 1.5,
			fog: true, skyBox: true, celestialBodies: true,
		});
		expect(v.scene.msaaSamples).toBe(4);
		expect(v.scene.globe.maximumScreenSpaceError).toBe(1.5);
		expect(v.scene.skyBox?.show).toBe(true);
		expect(v.scene.sun?.show).toBe(true);
	});
});
