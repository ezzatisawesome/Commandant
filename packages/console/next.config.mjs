/** @type {import('next').NextConfig} */
const nextConfig = {
	// Cesium creates a single Viewer bound to a DOM element; React Strict Mode's
	// double-mount in dev creates a second one and throws. Disable it (dev-only).
	reactStrictMode: false,
};

export default nextConfig;
