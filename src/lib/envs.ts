const PROD = process.env.NODE_ENV === "production";

export default {
	CESIUM_KEY: process.env.NEXT_PUBLIC_CESIUM_KEY ?? "",
	PROPAGATE_ENDPOINT: PROD
		? "https://r4bxsxsmoho7wkmd2x6km2s27q0iuueq.lambda-url.us-west-2.on.aws/"
		: "http://127.0.0.1:5000/propagate",
	MAVLINK_WS_ENDPOINT: process.env.NEXT_PUBLIC_MAVLINK_WS_ENDPOINT ?? "ws://localhost:8080",
	PROD,
};
