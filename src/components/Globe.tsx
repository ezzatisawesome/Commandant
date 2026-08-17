"use client";

import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import { Viewer, Ion, createWorldTerrainAsync, ArcGisMapServerImageryProvider } from "cesium";

import envs from "@/lib/envs";
import { $viewerStore } from "@/stores/cesium.store";
import { $timeStore } from "@/stores/states.store";

// Generic Cesium globe. Owns only the Viewer + container; domain layers
// (satellites, aircraft) add their own entities to the shared $viewerStore.
export default function Globe() {
	const $time = useStore($timeStore);

	useEffect(() => {
		// Guard against a second Viewer on the same container (React dev remounts /
		// Strict Mode). Creating two Viewers on one element throws and breaks the page.
		if ($viewerStore.get()) return;

		// Cesium fetches Workers/Assets/Widgets from here at runtime (copied to
		// public/cesium by scripts/copy-cesium.mjs). Set before creating the Viewer.
		(window as any).CESIUM_BASE_URL = "/cesium";

		// Register the tile-caching service worker (fast reloads + offline
		// region support). Safe to call repeatedly; the browser dedupes.
		if ("serviceWorker" in navigator) {
			navigator.serviceWorker
				.register("/cesium-sw.js")
				.catch((err) => console.warn("Cesium SW registration failed", err));
		}

		// Initialize Cesium Viewer.
		Ion.defaultAccessToken = envs.CESIUM_KEY;
		const viewer = new Viewer("cesiumContainer", {
			timeline: false,
			geocoder: false, // Search button
			homeButton: false,
			navigationHelpButton: false,
			baseLayerPicker: false, // Imagery layer picker
			sceneModePicker: true, // Need this functionality
			animation: false,
			fullscreenButton: false,
			infoBox: false, // sandboxed iframe (top-right) that overlaps the HUD + throws a sandbox console error
			selectionIndicator: false,
		});
		viewer.creditDisplay.container.style.display = "none"; // Hide Cesium logo
		(window as any).__cesiumViewer = viewer; // handy for debugging / tests
		$viewerStore.set(viewer);

		// Day/night: shade the globe from the sun's position (derived from the
		// clock), so the terminator and dark side appear. The clock is driven by
		// the sim's simulated time-of-day (telemetry `sunEpochMs`), so "night" in
		// the sim -> a dark globe here, in sync with irradiance going to zero.
		viewer.scene.globe.enableLighting = true;
		// Keep the ground atmosphere (the blue haze over terrain) for daytime, but
		// it stays lit at close range on the night side. `atmosphereBrightnessShift`
		// is driven from the telemetry's irradiance (telemetry.ts): ~0 in daylight
		// (full haze), -> -1 at night (dark), so night is dark at every zoom while
		// day keeps the haze.
		viewer.clock.shouldAnimate = false; // time comes from telemetry, not wall-clock

		// Enable 3D terrain (Cesium World Terrain from Ion). Loads async; the
		// viewer starts flat (EllipsoidTerrainProvider) and swaps in real
		// elevation once the provider resolves. Guard against the viewer being
		// destroyed before the promise settles (fast unmount / Strict Mode).
		createWorldTerrainAsync().then((terrainProvider) => {
			if (!viewer.isDestroyed()) viewer.terrainProvider = terrainProvider;
		});

		// Swap the muddy default (Bing/Cesium World Imagery) for Esri World
		// Imagery — crisper, more natural color, high-res to street level, no key.
		// Loads async; replace the base layer once it resolves.
		ArcGisMapServerImageryProvider.fromUrl(
			"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
		).then((esri) => {
			if (viewer.isDestroyed()) return;
			viewer.imageryLayers.removeAll();
			viewer.imageryLayers.addImageryProvider(esri);
		});

		// Set up clock.
		viewer.clock.startTime = $time.clone();
		viewer.clock.currentTime = $time.clone();

		// Cleanup: destroy THIS viewer and clear the shared store.
		return () => {
			if (!viewer.isDestroyed()) viewer.destroy();
			$viewerStore.set(null);
		};
	}, []);

	return (
		<div id="cesiumContainer" className="h-screen w-screen" />
	);
}
