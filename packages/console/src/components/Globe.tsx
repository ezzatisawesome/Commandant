"use client";

import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import { Viewer, Ion, createWorldTerrainAsync, ArcGisMapServerImageryProvider } from "cesium";

import envs from "@/lib/envs";
import { $viewerStore } from "@/stores/cesium.store";
import { driveRendering } from "@/lib/driveRendering";
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
			// On-demand rendering. Without this Cesium redraws at display refresh
			// forever, whether or not anything moved: a parked aircraft still cost
			// ~60 fps of globe, which is most of the fan noise with a tab open.
			// Telemetry arrives at 25 Hz (5 Hz on the hosted viewer), so the scene
			// never needs more than that.
			//
			// The catch: every entity driven by a CallbackProperty is invisible to
			// Cesium's change detection, so SOMETHING must call requestRender when
			// the data moves. driveRendering() below subscribes to the frame store
			// and does exactly that; camera input and tile loads are handled by
			// Cesium itself.
			requestRenderMode: true,
			// Still redraw at least this often so slow-changing scene state (sun
			// angle, atmosphere, terrain streaming) keeps up when data is static.
			maximumRenderTimeChange: 0.5,
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

		// Ask for a frame whenever the aircraft state changes. This is what makes
		// requestRenderMode safe with CallbackProperty-driven entities.
		const stopDriving = driveRendering(viewer);

		// Set up clock.
		viewer.clock.startTime = $time.clone();
		viewer.clock.currentTime = $time.clone();

		// Cleanup: destroy THIS viewer and clear the shared store.
		return () => {
			stopDriving();
			if (!viewer.isDestroyed()) viewer.destroy();
			$viewerStore.set(null);
		};
	}, []);

	return (
		<div id="cesiumContainer" className="h-screen w-screen" />
	);
}
