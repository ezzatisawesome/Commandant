import { atom } from "nanostores";

/** Whether the globe's imagery and terrain actually loaded.
 *
 *  Both come over the internet: terrain from Cesium Ion, imagery from ArcGIS.
 *  The hub's entire premise is an isolated WiFi network on a flight line with
 *  no WAN, so in the field BOTH requests fail -- and they failed silently, with
 *  no .catch on either promise. The operator got a blank sphere and no reason
 *  for it, which reads as the software being broken rather than as the map
 *  being unreachable.
 *
 *  Everything Commandant actually draws -- the aircraft, its track, the
 *  mission, the geofence, the rally points -- is drawn from telemetry in
 *  geographic coordinates and is unaffected. Saying so is the difference
 *  between a degraded map and an apparently dead console. */
export type MapLayerState = "loading" | "ok" | "unavailable";

export const $mapImagery = atom<MapLayerState>("loading");
export const $mapTerrain = atom<MapLayerState>("loading");
