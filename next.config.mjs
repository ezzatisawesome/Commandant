/** @type {import('next').NextConfig} */
const nextConfig = {
	// Cesium creates a single Viewer bound to a DOM element; React Strict Mode's
	// double-mount in dev creates a second one and throws. Disable it (dev-only).
	reactStrictMode: false,
	// The telemetry bridge (instrumentation.ts) uses these Node-only packages;
	// keep them external so Next doesn't try to bundle their socket/stream code.
	serverExternalPackages: ["node-mavlink", "mavlink-mappings", "ws"],
};

export default nextConfig;
