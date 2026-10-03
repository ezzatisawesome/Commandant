// Pre-download terrain + imagery tiles for a bounding box while online so a
// known flight region works fully offline. Every request goes through the
// Cesium provider (and therefore the cesium-sw service worker, which stores
// the response). Run this before losing internet.

import {
	Rectangle,
	Request,
	Math as CMath,
	type Viewer,
	type TerrainProvider,
	type ImageryProvider,
} from "cesium";

export interface Region {
	west: number;
	south: number;
	east: number;
	north: number;
}

export interface PreCacheOptions extends Region {
	/** Coarsest level to fetch (0 = whole globe). */
	minLevel?: number;
	/** Finest level. ~13-15 is street-ish for terrain; higher = much more data. */
	maxLevel?: number;
	/** Called after each level with progress info. */
	onProgress?: (info: {
		level: number;
		tiles: number;
		done: number;
		total: number;
	}) => void;
}

// Cesium throttles concurrent tile requests; requestTileGeometry/requestImage
// return undefined when the queue is full. Retry with a short backoff so we
// don't silently skip tiles.
function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function tilesForLevel(
	rect: Rectangle,
	level: number,
	scheme: TerrainProvider["tilingScheme"],
) {
	const sw = scheme.positionToTileXY(Rectangle.southwest(rect), level);
	const ne = scheme.positionToTileXY(Rectangle.northeast(rect), level);
	if (!sw || !ne) return [] as Array<{ x: number; y: number }>;
	const tiles: Array<{ x: number; y: number }> = [];
	// Tile Y grows southward, so the northeast corner has the smaller Y.
	for (let x = sw.x; x <= ne.x; x++) {
		for (let y = ne.y; y <= sw.y; y++) tiles.push({ x, y });
	}
	return tiles;
}

async function requestWithRetry(fn: () => unknown, retries = 40) {
	for (let i = 0; i < retries; i++) {
		const result = fn();
		if (result !== undefined) {
			try {
				await (result as Promise<unknown>);
			} catch {
				/* a single failed tile shouldn't abort the whole run */
			}
			return true;
		}
		await delay(50); // queue full — let in-flight requests drain
	}
	return false;
}

/**
 * Download all terrain + imagery tiles covering `region` from minLevel..maxLevel.
 * Returns the number of tiles requested. Warn: high maxLevel over a wide box is
 * a LOT of data (tile count roughly quadruples per level).
 */
export async function preCacheRegion(
	viewer: Viewer,
	opts: PreCacheOptions,
): Promise<number> {
	const { minLevel = 0, maxLevel = 13, onProgress } = opts;
	const rect = Rectangle.fromDegrees(
		opts.west,
		opts.south,
		opts.east,
		opts.north,
	);

	const terrain = viewer.terrainProvider;
	const imagery: ImageryProvider | undefined =
		viewer.imageryLayers.length > 0
			? viewer.imageryLayers.get(0).imageryProvider
			: undefined;

	// Count total tiles up front for progress reporting.
	const perLevel: number[] = [];
	for (let level = minLevel; level <= maxLevel; level++) {
		perLevel.push((await tilesForLevel(rect, level, terrain.tilingScheme)).length);
	}
	const total = perLevel.reduce((a, b) => a + b, 0);

	let done = 0;
	let requested = 0;
	for (let level = minLevel; level <= maxLevel; level++) {
		const tiles = await tilesForLevel(rect, level, terrain.tilingScheme);
		for (const { x, y } of tiles) {
			// Terrain
			if (
				!terrain.availability ||
				terrain.getTileDataAvailable(x, y, level) !== false
			) {
				await requestWithRetry(() =>
					terrain.requestTileGeometry(x, y, level, new Request()),
				);
				requested++;
			}
			// Imagery (same tiling scheme for Web Mercator/Geographic providers)
			if (imagery) {
				await requestWithRetry(() =>
					imagery.requestImage(x, y, level, new Request()),
				);
				requested++;
			}
			done++;
		}
		onProgress?.({ level, tiles: tiles.length, done, total });
	}

	CMath; // keep import if tree-shaking complains
	return requested;
}
