import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	test: {
		environment: "happy-dom",
		include: ["src/**/*.test.ts"],
		// Cesium is a large ESM package; one shared worker keeps startup sane.
		pool: "forks",
	},
});
