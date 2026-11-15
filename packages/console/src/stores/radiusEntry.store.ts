import { atom } from "nanostores";

// A ring's size typed in, rather than dragged.
//
// Clicking a radius grabber without moving it (a loiter's orbit, a circle
// fence) opens a small box at the handle asking for the DIAMETER — the number
// people think of a circle by — and the layer that owns the ring applies it as
// a radius. The layer passes its own `apply`, so the box (RadiusEntry) knows
// nothing about missions or fences.

export interface RadiusEntry {
	/** Canvas-relative pixel position of the handle. */
	x: number;
	y: number;
	/** What is being sized: "WP 2 orbit". */
	title: string;
	/** The ring's current radius, m. */
	radiusM: number;
	/** Set the ring's radius, m (already clamped). */
	apply: (radiusM: number) => void;
}

export const $radiusEntry = atom<RadiusEntry | null>(null);

export const openRadiusEntry = (e: RadiusEntry) => $radiusEntry.set(e);
export const closeRadiusEntry = () => $radiusEntry.set(null);
