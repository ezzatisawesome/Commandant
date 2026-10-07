import { atom } from "nanostores";

// Debug/inspection view toggles for the flight scene. Shared between the
// ViewControls panel (right rail) and the Aircraft component that owns the
// Cesium entities.
export const $showTriad = atom(true);
export const $showHorizPlane = atom(true);

// Situation overlays (see components/flight/SituationLayer.tsx). Default-on for
// clearance because it is a safety readout; the vector overlays are opt-in so
// the globe is not busy by default.
export const $showClearance = atom(true);
export const $showWind = atom(false);
export const $showSun = atom(false);
