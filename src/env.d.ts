/// <reference path="../.astro/types.d.ts" />


interface ImportMetaEnv {
	readonly PUBLIC_CESIUM_KEY: string;
	readonly PROPAGATE_ENDPOINT: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}