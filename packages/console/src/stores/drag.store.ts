import { atom } from "nanostores";

// The handle being dragged on the globe, if any.
//
// The authoring layers (MissionLayer, GeoLayer) own their drags; the cursor
// overlay (CursorGround) draws the plumb line under the pointer. Without this
// the two did not know about each other: dragging an orbit's radius rim, the
// plumb line followed the mouse showing lat/lon and MSL exactly as it does
// before a click that ADDS a waypoint, so a working drag looked like a pending
// add. The layer that armed the drag publishes what it is changing here, and
// the cursor redraws itself as a held handle with that text instead.

export interface HandleDrag {
	/** The held handle's entity tag ("mission-rad-2"), as in lib/pickTag. */
	id: string;
	/** What the drag is changing, live: "WP 2 · radius 120 m". */
	label: string;
}

export const $handleDrag = atom<HandleDrag | null>(null);

export const setHandleDrag = (id: string, label: string) => $handleDrag.set({ id, label });
export const endHandleDrag = () => $handleDrag.set(null);
