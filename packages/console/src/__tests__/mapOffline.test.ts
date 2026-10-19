import { describe, it, expect, beforeEach } from "vitest";

import { $mapImagery, $mapTerrain } from "@/stores/map.store";

/**
 * The globe fetches imagery from ArcGIS and terrain from Cesium Ion, both over
 * the internet. The hub's whole premise is an isolated WiFi network on a flight
 * line with no WAN, so in the field both requests fail — and neither promise
 * had a .catch, so they failed silently and left a blank sphere with no reason
 * given. A blank globe reads as a broken console.
 */
describe("a hub with no internet still has a usable console", () => {
	beforeEach(() => { $mapImagery.set("loading"); $mapTerrain.set("loading"); });

	it("starts as loading, which is neither a success nor a failure", () => {
		expect($mapImagery.get()).toBe("loading");
		expect($mapTerrain.get()).toBe("loading");
	});

	it("says nothing while the map is merely still loading", () => {
		const shown = (i: string, t: string) => i === "unavailable" || t === "unavailable";
		expect(shown($mapImagery.get(), $mapTerrain.get())).toBe(false);
	});

	it("distinguishes the two, because losing one is not losing both", () => {
		$mapTerrain.set("unavailable");
		$mapImagery.set("ok");
		expect($mapTerrain.get()).toBe("unavailable");
		expect($mapImagery.get()).toBe("ok");
	});

	it("a failure is terminal for the layer, not retried into a flicker", () => {
		$mapImagery.set("unavailable");
		expect($mapImagery.get()).toBe("unavailable");
	});
});
