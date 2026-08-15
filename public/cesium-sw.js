// Service worker that caches Cesium Ion tile traffic (terrain + imagery) so
// that (a) page refreshes reuse already-downloaded tiles instead of re-fetching
// and (b) a region pre-warmed while online keeps working with no internet.
//
// Strategy: cache-first with background refresh. Ion signs tile URLs with a
// rotating token in the query string, so the offline fallback matches with
// { ignoreSearch: true } to still find the tile when the token has changed.

const CACHE = "cesium-tiles-v1";

// Hosts whose GET responses we cache. Ion serves both terrain (quantized-mesh)
// and Cesium World Imagery through the ion asset/CDN hosts below.
const CACHEABLE_HOSTS = [
	"assets.ion.cesium.com",
	"assets.cesium.com",
	"api.cesium.com",
	"ibasemaps-api.arcgis.com",
	"services.arcgisonline.com", // Esri World Imagery tiles
	"server.arcgisonline.com",
];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function isCacheable(url) {
	return CACHEABLE_HOSTS.some(
		(h) => url.hostname === h || url.hostname.endsWith("." + h),
	);
}

self.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") return;
	const url = new URL(event.request.url);
	if (!isCacheable(url)) return;
	event.respondWith(handle(event.request));
});

async function handle(request) {
	const cache = await caches.open(CACHE);

	// Exact match (same token) → serve instantly, refresh in the background.
	const exact = await cache.match(request);
	if (exact) {
		fetchAndStore(cache, request).catch(() => {});
		return exact;
	}

	// Not cached yet → go to network, store on success.
	try {
		return await fetchAndStore(cache, request);
	} catch (err) {
		// Offline: fall back to any cached copy of this tile, ignoring the
		// (expired) token in the query string.
		const stale = await cache.match(request, { ignoreSearch: true });
		if (stale) return stale;
		throw err;
	}
}

async function fetchAndStore(cache, request) {
	const response = await fetch(request);
	// Only cache readable, successful responses (Ion uses CORS, so these are
	// not opaque). Skip partial/opaque to avoid poisoning the cache.
	if (response.ok && response.type !== "opaque") {
		cache.put(request, response.clone());
	}
	return response;
}
