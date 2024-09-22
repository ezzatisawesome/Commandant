import * as Cesium from "cesium";
import { atom } from "nanostores";

// Initialize the viewer store
export const $viewerStore = atom<Cesium.Viewer | null>(null);