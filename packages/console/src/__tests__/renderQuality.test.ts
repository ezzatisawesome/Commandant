import { describe, it, expect } from "vitest";

import { applyQuality, QUALITY, type QualityTarget } from "@/lib/renderQuality";

// These four settings were Cesium defaults nobody chose. The point of pinning
// them is that a default can change under a dependency bump and quietly put two
// full-screen antialiasing passes back on a machine that is already sharing its
// cores with a flight simulator.

function fakeViewer(): QualityTarget {
	return {
		scene: {
			msaaSamples: 4,
			fog: { enabled: true },
			globe: { maximumScreenSpaceError: 2 },
			postProcessStages: { fxaa: { enabled: true } },
		},
	};
}

describe("render quality", () => {
	it("turns off both antialiasing passes", () => {
		const v = applyQuality(fakeViewer());
		expect(v.scene.msaaSamples).toBe(1);
		expect(v.scene.postProcessStages.fxaa.enabled).toBe(false);
	});

	it("relaxes terrain refinement rather than tightening it", () => {
		// Looser than Cesium's default of 2. Tighter would mean MORE tiles, which
		// is the opposite of the intent, so compare against the default directly.
		const before = fakeViewer();
		const after = applyQuality(fakeViewer());
		expect(after.scene.globe.maximumScreenSpaceError)
			.toBeGreaterThan(before.scene.globe.maximumScreenSpaceError);
	});

	it("keeps fog, which the day/night lighting reads against", () => {
		expect(applyQuality(fakeViewer()).scene.fog.enabled).toBe(true);
	});

	it("applies exactly the documented settings and nothing else", () => {
		const v = applyQuality(fakeViewer());
		expect({
			msaaSamples: v.scene.msaaSamples,
			fxaa: v.scene.postProcessStages.fxaa.enabled,
			maximumScreenSpaceError: v.scene.globe.maximumScreenSpaceError,
			fog: v.scene.fog.enabled,
		}).toEqual(QUALITY);
	});

	it("can be overridden for a machine that wants the pretty version", () => {
		const v = applyQuality(fakeViewer(), {
			msaaSamples: 4, fxaa: true, maximumScreenSpaceError: 1.5, fog: true,
		});
		expect(v.scene.msaaSamples).toBe(4);
		expect(v.scene.globe.maximumScreenSpaceError).toBe(1.5);
	});
});
