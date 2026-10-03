import { atom } from "nanostores";

import type { FenceItem, FenceKind, RallyItem } from "@/types/app";

// Phase-4 extension: geofence + rally authoring, mirroring mission.store. Fences
// and rally points ride the same MISSION_COUNT/REQUEST/ITEM/ACK handshake in gs,
// generalized by mission_type (FENCE / RALLY). $fenceItems / $rallyItems are the
// EDITABLE sets the operator authors; they're pushed via fence_push / rally_push
// and replaced wholesale by a `fence` / `rally` reply after a pull.
export const $fenceItems = atom<FenceItem[]>([]);
export const $rallyItems = atom<RallyItem[]>([]);

// Geo authoring mode (separate from mission edit so the two don't fight over
// clicks) and which kind a globe click places while it's on.
export const $geoEdit = atom<boolean>(false);
export const $geoPlaceKind = atom<FenceKind | "rally">("fence_inclusion");

const POLYGON_KINDS: FenceKind[] = ["fence_inclusion", "fence_exclusion"];
const CIRCLE_KINDS: FenceKind[] = ["fence_circle_inclusion", "fence_circle_exclusion"];

export function isPolygonKind(kind: FenceKind): boolean {
	return POLYGON_KINDS.includes(kind);
}
export function isCircleKind(kind: FenceKind): boolean {
	return CIRCLE_KINDS.includes(kind);
}

function reseq<T extends { seq: number }>(items: T[]): T[] {
	return items.map((it, i) => ({ ...it, seq: i }));
}

// --- fence ------------------------------------------------------------------
export function setFenceItems(items: FenceItem[]) {
	$fenceItems.set(reseq(items));
}
export function addFencePoint(kind: FenceKind, lat: number, lon: number) {
	const items = $fenceItems.get();
	// Circles default to a 100 m radius; polygon vertices carry no param until push.
	const params = isCircleKind(kind) ? { radius: 100 } : undefined;
	$fenceItems.set(reseq([...items, { seq: items.length, kind, lat, lon, params }]));
}
export function updateFenceItem(seq: number, patch: Partial<FenceItem>) {
	$fenceItems.set($fenceItems.get().map((it) => (it.seq === seq ? { ...it, ...patch } : it)));
}
export function moveFencePoint(seq: number, lat: number, lon: number) {
	updateFenceItem(seq, { lat, lon });
}
export function removeFenceItem(seq: number) {
	setFenceItems($fenceItems.get().filter((it) => it.seq !== seq));
}
export function clearFence() {
	$fenceItems.set([]);
}

// Stamp each polygon vertex with the vertexCount of its contiguous same-kind run
// (the MAVLink fence convention: param1 = total vertices in that polygon). Circles
// keep their radius. Called at push time so the wire items match the contract.
export function fenceItemsForPush(): FenceItem[] {
	const items = $fenceItems.get();
	const out: FenceItem[] = items.map((it) => ({ ...it, params: { ...it.params } }));
	let i = 0;
	while (i < out.length) {
		const it = out[i];
		if (isPolygonKind(it.kind)) {
			let j = i;
			while (j < out.length && out[j].kind === it.kind) j++;
			const count = j - i;
			for (let k = i; k < j; k++) out[k].params = { ...out[k].params, vertexCount: count };
			i = j;
		} else {
			i++;
		}
	}
	return out;
}

// --- rally ------------------------------------------------------------------
export function setRallyItems(items: RallyItem[]) {
	$rallyItems.set(reseq(items));
}
export function addRallyPoint(lat: number, lon: number, alt: number) {
	const items = $rallyItems.get();
	$rallyItems.set(reseq([...items, { seq: items.length, kind: "rally", lat, lon, alt }]));
}
export function updateRallyItem(seq: number, patch: Partial<RallyItem>) {
	$rallyItems.set($rallyItems.get().map((it) => (it.seq === seq ? { ...it, ...patch } : it)));
}
export function moveRallyPoint(seq: number, lat: number, lon: number) {
	updateRallyItem(seq, { lat, lon });
}
export function removeRallyItem(seq: number) {
	setRallyItems($rallyItems.get().filter((it) => it.seq !== seq));
}
export function clearRally() {
	$rallyItems.set([]);
}
