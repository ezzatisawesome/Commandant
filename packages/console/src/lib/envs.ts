const PROD = process.env.NODE_ENV === "production";

// Resolve the gs WebSocket endpoint. In the field the console is served BY the
// hub (a Raspberry Pi running gs); clients join the hub's WiFi and open
// commandant.local, so the WS must target whatever host served the page — NOT
// localhost, which would point a remote phone/laptop back at itself. An explicit
// env var overrides (handy for a split dev setup where gs runs elsewhere); the
// localhost fallback covers SSR/build and plain single-machine dev.
function resolveWsEndpoint(): string {
	const override = process.env.NEXT_PUBLIC_MAVLINK_WS_ENDPOINT;
	if (override) return override;
	if (typeof window !== "undefined" && window.location?.hostname) {
		return `ws://${window.location.hostname}:8790`;
	}
	return "ws://localhost:8790";
}

export default {
	CESIUM_KEY: process.env.NEXT_PUBLIC_CESIUM_KEY ?? "",
	PROPAGATE_ENDPOINT: PROD
		? "https://r4bxsxsmoho7wkmd2x6km2s27q0iuueq.lambda-url.us-west-2.on.aws/"
		: "http://127.0.0.1:5000/propagate",
	// Getter so it resolves against the live `window` on the client at access time
	// (the telemetry client reads it when it constructs, in the browser).
	get MAVLINK_WS_ENDPOINT() {
		return resolveWsEndpoint();
	},
	PROD,
};
