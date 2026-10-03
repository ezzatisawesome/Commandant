import { atom } from "nanostores";

// Debug/inspection view toggles for the flight scene. Shared between the
// ViewControls panel (right rail) and the Aircraft component that owns the
// Cesium entities.
export const $showTriad = atom(true);
export const $showHorizPlane = atom(true);
