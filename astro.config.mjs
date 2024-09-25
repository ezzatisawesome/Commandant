import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import { viteStaticCopy } from 'vite-plugin-static-copy'

const cesiumBaseUrl = import.meta.env.PROD ? '_astro/' : 'node_modules/.vite/deps'
const cesiumSource = 'node_modules/cesium/Build/Cesium'

// https://astro.build/config
export default defineConfig({
	integrations: [
    react(), 
    tailwind({
      configFile: "./tailwind.config.mjs",
      applyBaseStyles: false
    })
  ],
  vite: {
    plugins: [
      viteStaticCopy({
        targets: [
          { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
          { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
          { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
          { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
        ],
      }),
    ],
  },
});
