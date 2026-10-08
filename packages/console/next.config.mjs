/** @type {import('next').NextConfig} */
const nextConfig = {
	// Cesium creates a single Viewer bound to a DOM element; React Strict Mode's
	// double-mount in dev creates a second one and throws. Disable it (dev-only).
	reactStrictMode: false,
	// NOTE: cesium is pinned to 1.128.0 in package.json, and @zip.js/zip.js is
	// held on the 2.7 line by a root override. Cesium >= 1.132 ships wasm-bindgen
	// glue whose inlined binary the minifier rewrites into a template literal with
	// octal escapes — invalid JS, so the production bundle fails to parse and the
	// page never mounts. Dev builds are unminified and hide it. Do not widen either
	// pin without loading a production build in a browser.
};

export default nextConfig;
