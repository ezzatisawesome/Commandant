// Render quality for the globe.
//
// Cesium's defaults are tuned for a demo on an idle machine: 4x MSAA, an FXAA
// pass on top of it, and terrain refined to a 2 px screen-space error. Nobody
// chose those for this application — they were simply never set, and each one
// costs either GPU time every frame or tiles over the network.
//
// This console runs next to a SITL simulator that takes three of eight cores, on
// a laptop, in a browser that is also holding a websocket at 25 Hz. The globe is
// a moving map of terrain and a flight path, not an architectural render, so the
// defaults buy image quality it does not need with frame time and bandwidth it
// does.
//
// Separated from the component and expressed as data so the choices are visible,
// reviewable and testable, rather than four scattered assignments.

export interface QualitySettings {
	/** Multisample count. 1 disables MSAA. */
	msaaSamples: number;
	/** The extra full-screen antialiasing pass. */
	fxaa: boolean;
	/** Terrain/imagery refinement, in pixels of allowed error. Higher means
	 *  fewer and coarser tiles: less network, less memory, less CPU. */
	maximumScreenSpaceError: number;
	/** Distance fog over terrain. Pretty; costs a shader branch per pixel. */
	fog: boolean;
}

/**
 * What the globe runs at.
 *
 * MSAA off and FXAA off: this scene's edges are terrain and polylines, and
 * polylines are already drawn with their own width and blending. Two
 * antialiasing passes over a full viewport is the single largest fixed GPU cost
 * in the default configuration, and the thing it smooths is barely visible on a
 * moving map.
 *
 * Screen-space error 3 rather than 2: terrain tile count scales roughly with the
 * square of the inverse of this, so 2 -> 3 is a large reduction in tiles for a
 * difference an operator does not notice on a hillside seen from 400 ft.
 *
 * Fog stays on: it is how the globe reads as having depth, and the day/night
 * lighting this console drives from simulated time depends on the same haze.
 */
export const QUALITY: QualitySettings = {
	msaaSamples: 1,
	fxaa: false,
	maximumScreenSpaceError: 3,
	fog: true,
};

/** Shape of the bits of a Cesium viewer this touches, so the function can be
 *  called with a test double instead of a real WebGL context. */
export interface QualityTarget {
	scene: {
		msaaSamples: number;
		fog: { enabled: boolean };
		globe: { maximumScreenSpaceError: number };
		postProcessStages: { fxaa: { enabled: boolean } };
	};
}

/** Apply the settings to a viewer. Returns the target, for chaining in tests. */
export function applyQuality<T extends QualityTarget>(
	viewer: T, q: QualitySettings = QUALITY,
): T {
	viewer.scene.msaaSamples = q.msaaSamples;
	viewer.scene.postProcessStages.fxaa.enabled = q.fxaa;
	viewer.scene.globe.maximumScreenSpaceError = q.maximumScreenSpaceError;
	viewer.scene.fog.enabled = q.fog;
	return viewer;
}
