// Next calls register() once on server startup. We use it to launch the
// telemetry bridge (UDP MAVLink/JSON -> WebSocket) inside the same process as
// the web app — so `npm run dev` brings up both. Node runtime only.
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { startBridge } = await import("./lib/bridge/bridge");
		startBridge();
	}
}
