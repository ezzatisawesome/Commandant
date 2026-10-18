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
/** Two points bound no area. Mirrors FENCE_POLYGON_MIN_VERTICES in gs. */
export const FENCE_POLYGON_MIN_VERTICES = 3;
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

/**
 * Insert a new vertex immediately after `seq`, inheriting its kind.
 *
 * This is how a boundary is RESHAPED rather than merely nudged. A polygon fence
 * is a contiguous run of same-kind items, and appending (the only way to add a
 * point before this) always landed the new vertex at the END of the run — which
 * on a closed ring means the edge you wanted to bend is still straight and the
 * ring now has a spur across it. Inserting after the edge's first vertex keeps
 * the winding order intact, so dragging the new point bends exactly the edge the
 * operator grabbed. Resequencing keeps the run contiguous for fenceItemsForPush.
 */
export function insertFencePointAfter(seq: number, lat: number, lon: number) {
	const items = $fenceItems.get();
	const i = items.findIndex((it) => it.seq === seq);
	if (i < 0) return;
	const kind = items[i].kind;
	// Only polygon runs have edges to subdivide; a circle has no vertex order.
	if (!isPolygonKind(kind)) return;
	const next = [...items];
	next.splice(i + 1, 0, { seq: seq + 1, kind, lat, lon });
	setFenceItems(next);
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

/** Why this fence cannot be uploaded, or null if it can.
 *
 *  gs refuses the same geometry and says why, which is the part that matters:
 *  a fence exists to be there when something else has already gone wrong, so
 *  "accepted" has to mean it. This is the same rule applied at authoring time,
 *  so the operator finds out while placing vertices instead of after a round
 *  trip to the aircraft. Deliberately a mirror, not the only check — the
 *  authority is gs, which serves clients other than this one. */
export function fenceGeometryProblem(items: FenceItem[] = $fenceItems.get()): string | null {
	let i = 0;
	while (i < items.length) {
		const kind = items[i].kind;
		if (isPolygonKind(kind)) {
			let j = i;
			while (j < items.length && items[j].kind === kind) j++;
			const count = j - i;
			if (count < FENCE_POLYGON_MIN_VERTICES) {
				const what = kind === "fence_exclusion" ? "exclusion" : "inclusion";
				return `the ${what} polygon at #${items[i].seq} has ${count} `
					+ `vertex${count === 1 ? "" : "es"} — a polygon needs ${FENCE_POLYGON_MIN_VERTICES}`;
			}
			i = j;
			continue;
		}
		if (isCircleKind(kind)) {
			const r = items[i].params?.radius ?? 0;
			if (!(r > 0)) return `the circle at #${items[i].seq} has no radius`;
		}
		i++;
	}
	return null;
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
