import { Viewer } from "cesium";
import { atom } from "nanostores";

// Initialize the viewer store
export const $viewerStore = atom<Viewer | null>(null);