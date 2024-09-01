/// <reference path="../../.astro/types.d.ts" />


interface ImportMetaEnv {
	readonly PUBLIC_CESIUM_KEY: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}