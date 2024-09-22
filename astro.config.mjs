import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import cesium from 'vite-plugin-cesium-build'


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
      cesium()
    ],
  },
});
