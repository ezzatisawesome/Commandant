import { Viewer } from "cesium";
import { atom, onMount } from "nanostores";

// Initialize the viewer store
export const $viewerStore = atom<Viewer | null>(null);