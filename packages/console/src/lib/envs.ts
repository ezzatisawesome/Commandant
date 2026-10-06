const PROD = process.env.NODE_ENV === "production";

// Two deployments of the same app:
//
//  COCKPIT (default) — served by the field hub, talks to the local gs daemon,
//    holds command authority. Works with no internet.
//  VIEW — served at commandant.guppi.com, talks to the public relay, and is
//    read-only BY CONSTRUCTION: the telemetry client refuses to transmit and the
//    relay has no path back to the hub. Nothing on the internet can command.
//
// Set NEXT_PUBLIC_MODE=view at build time for the hosted deployment.
export type AppMode = "cockpit" | "view";
export const MODE: AppMode = process.env.NEXT_PUBLIC_MODE === "view" ? "view" : "cockpit";
export const IS_VIEW = MODE === "view";

// Resolve the gs WebSocket endpoint. In the field the console is served BY the
// hub (a Raspberry Pi running gs); clients join the hub's WiFi and open
// commandant.local, so the WS must target whatever host served the page — NOT
// localhost, which would point a remote phone/laptop back at itself. An explicit
// env var overrides (handy for a split dev setup where gs runs elsewhere); the
// localhost fallback covers SSR/build and plain single-machine dev.
function resolveWsEndpoint(): string {
	const override = process.env.NEXT_PUBLIC_MAVLINK_WS_ENDPOINT;
	if (override) return override;
	// VIEW mode watches the relay, not a hub on the LAN.
	if (MODE === "view") {
		const relay = process.env.NEXT_PUBLIC_RELAY_ENDPOINT;
		if (relay) return relay;
		if (typeof window !== "undefined" && window.location?.hostname) {
			const scheme = window.location.protocol === "https:" ? "wss" : "ws";
			return `${scheme}://${window.location.hostname}/watch`;
		}
	}
	if (typeof window !== "undefined" && window.location?.hostname) {
		// A page served over https cannot open ws:// (SecurityError), so follow the
		// page's scheme; the hub serves plain http today, so this is ws:// there.
		const scheme = window.location.protocol === "https:" ? "wss" : "ws";
		return `${scheme}://${window.location.hostname}:8790`;
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
