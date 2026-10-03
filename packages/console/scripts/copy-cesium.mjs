// Cesium ships its Workers/Assets/Widgets/ThirdParty as static files fetched at
// runtime from CESIUM_BASE_URL. Next doesn't bundle them, so copy them into
// public/cesium/ and point CESIUM_BASE_URL there (see Globe.tsx). Runs on
// predev / prebuild / postinstall. No dependencies.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Resolve Cesium's install location rather than assuming it sits in this
// package's node_modules — npm workspaces hoist dependencies to the monorepo
// root, so a hardcoded ./node_modules/cesium path would miss it.
const require = createRequire(import.meta.url);
let src;
try {
	src = join(dirname(require.resolve("cesium/package.json")), "Build", "Cesium");
} catch {
	src = join(root, "node_modules", "cesium", "Build", "Cesium");
}
const dest = join(root, "public", "cesium");

if (!existsSync(src)) {
	console.warn("[copy-cesium] cesium not installed yet; skipping");
	process.exit(0);
}

mkdirSync(dest, { recursive: true });
for (const dir of ["Workers", "Assets", "Widgets", "ThirdParty"]) {
	cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
console.log(`[copy-cesium] copied Cesium assets -> public/cesium`);
