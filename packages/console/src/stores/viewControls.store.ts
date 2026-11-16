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

// Follow the aircraft (chase camera). A store, not the View panel's own state:
// the panel unmounts when it closes -- and any press on the globe closes it --
// so a follow held there was cancelled by the first drag. Aircraft.tsx, which
// is always mounted, applies it as Cesium's trackedEntity.
export const $followAircraft = atom(false);

// Draw control-surface deflections at SURFACE_EXAGGERATION x their true angle.
// Off by default: in cruise the real deflections are a few degrees on a 7-8 cm
// chord -- millimetres -- and only visible this way. lib/modelAnimation.
export const $exaggerateSurfaces = atom(false);
export const SURFACE_EXAGGERATION = 4;

// Lift bars along the wing, scaled to the live load factor (lib/wingLoads).
export const $showWingLoads = atom(true);
