// Render quality for the globe.
//
// Cesium's defaults are tuned for a demo on an idle machine, and for a scene
// that might be viewed from orbit. Nobody chose them here; they were never set.
// This console is a moving map of terrain and a flight path, running beside a
// SITL simulator that takes three of eight cores, in a browser also holding a
// 25 Hz websocket.
//
// Every value below was measured rather than assumed, on an Apple M1 through
// ANGLE's Metal backend, against a live link with a moving aircraft. The numbers
// are in docs/layout.md. One setting was measured, found not to earn its cost,
// and reverted — that note is kept deliberately.
//
// Separated from the component and expressed as data so the choices are visible,
// reviewable and testable, rather than scattered assignments in an effect.

export interface QualitySettings {
	/** Multisample count. 1 disables MSAA.
	 *
	 *  MEASURED: the single largest fixed cost in the default configuration.
	 *  4 -> 1 took 4.70 ms off a 14.10 ms frame, three quarters of the total win.
	 *  What it smooths is terrain and polyline edges on a map that is moving. */
	msaaSamples: number;
	/** The extra full-screen antialiasing pass, on top of MSAA.
	 *
	 *  MEASURED: 1.90 ms per frame. Two antialiasing passes over a full viewport
	 *  for a scene whose polylines already carry their own width and blending. */
	fxaa: boolean;
	/** Terrain/imagery refinement, in pixels of allowed error.
	 *
	 *  LEFT AT CESIUM'S DEFAULT, deliberately. Raising it to 3 was tried: it
	 *  bought 0.40 ms per frame, within run-to-run noise, and changed first-load
	 *  traffic by 38 KB out of 7.3 MB — the tile set at this camera is governed
	 *  by the terrain provider's available levels, not by this number. Coarser
	 *  terrain for nothing, so it was reverted. Pinned here so a dependency bump
	 *  cannot change it silently. */
	maximumScreenSpaceError: number;
	/** Distance fog over terrain. Kept: it is how the globe reads as having
	 *  depth, and the day/night lighting reads against the same haze. */
	fog: boolean;
	/** The star-field cube map behind the globe.
	 *
	 *  MEASURED: 871 KB over six JPEG requests, fetched eagerly on every cold
	 *  load. An operator watching an aircraft orbit a hill at 400 ft never sees
	 *  it; the atmosphere still renders the daylight sky from below. */
	skyBox: boolean;
	/** The rendered sun and moon billboards.
	 *
	 *  Not the lighting — `globe.enableLighting` and the clock drive that, and
	 *  the sun's direction still produces the terminator and the dark side. These
	 *  are the two sprites in the sky, which share the skybox's problem. */
	celestialBodies: boolean;
}

export const QUALITY: QualitySettings = {
	msaaSamples: 1,
	fxaa: false,
	maximumScreenSpaceError: 2,
	fog: true,
	skyBox: false,
	celestialBodies: false,
};

/** Shape of the bits of a Cesium viewer this touches, so the function can be
 *  called with a test double instead of a real WebGL context. */
export interface QualityTarget {
	scene: {
		msaaSamples: number;
		fog: { enabled: boolean };
		globe: { maximumScreenSpaceError: number };
		postProcessStages: { fxaa: { enabled: boolean } };
		skyBox?: { show: boolean } | undefined;
		sun?: { show: boolean } | undefined;
		moon?: { show: boolean } | undefined;
	};
}

/** Apply the settings to a viewer. Returns the target, for chaining in tests. */
export function applyQuality<T extends QualityTarget>(
	viewer: T, q: QualitySettings = QUALITY,
): T {
	const s = viewer.scene;
	s.msaaSamples = q.msaaSamples;
	s.postProcessStages.fxaa.enabled = q.fxaa;
	s.globe.maximumScreenSpaceError = q.maximumScreenSpaceError;
	s.fog.enabled = q.fog;
	// `show = false` is not enough for the skybox: Cesium has already requested
	// the six cube faces by then. Dropping the object is what prevents the
	// fetch, and Cesium treats a missing skyBox as "draw no stars".
	if (!q.skyBox) s.skyBox = undefined;
	else if (s.skyBox) s.skyBox.show = true;
	if (s.sun) s.sun.show = q.celestialBodies;
	if (s.moon) s.moon.show = q.celestialBodies;
	return viewer;
}
