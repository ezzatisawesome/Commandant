import { atom } from "nanostores";

import type { MissionItem, MissionKind } from "@/types/app";

// Phase 4 mission planning. $missionItems is the EDITABLE plan the operator is
// authoring (globe clicks / the table); it is pushed to PX4 as `mission_push` and
// replaced wholesale by a `mission` reply after a `mission_pull`. $missionCurrent
// / $missionReached track live execution (MISSION_CURRENT / MISSION_ITEM_REACHED)
// so the globe can highlight where the aircraft is in the plan. $missionProgress
// drives the upload/download progress bar.
export const $missionItems = atom<MissionItem[]>([]);
export const $missionCurrent = atom<number | null>(null);     // seq PX4 is flying toward
export const $missionReached = atom<number | null>(null);     // last seq reached
export const $missionProgress = atom<
	{ phase: "upload" | "download"; seq: number; count: number } | null
>(null);

// Authoring mode: when on, a single left-click on the globe appends a waypoint
// (off by default so clicks don't fight camera pan). The MissionLayer reads this.
export const $missionEdit = atom<boolean>(false);

// Which kinds carry a position (lat/lon). rtl is positionless; the others are
// placed on the globe. Used by the authoring layer and the table alike.
export function kindHasPosition(kind: MissionKind): boolean {
	return kind !== "rtl";
}

// Resequence 0..n-1 after any structural edit so seq always matches list order —
// gs/PX4 expect contiguous ascending seqs.
function resequence(items: MissionItem[]): MissionItem[] {
	return items.map((it, i) => ({ ...it, seq: i }));
}

export function setMissionItems(items: MissionItem[]) {
	$missionItems.set(resequence(items));
}

export function addWaypoint(lat: number, lon: number, alt: number, kind: MissionKind = "waypoint") {
	const items = $missionItems.get();
	$missionItems.set(resequence([...items, { seq: items.length, kind, lat, lon, alt }]));
}

export function updateItem(seq: number, patch: Partial<MissionItem>) {
	$missionItems.set($missionItems.get().map((it) => (it.seq === seq ? { ...it, ...patch } : it)));
}

export function moveItemPosition(seq: number, lat: number, lon: number) {
	updateItem(seq, { lat, lon });
}

export function removeItem(seq: number) {
	setMissionItems($missionItems.get().filter((it) => it.seq !== seq));
}

// Reorder by index (dir -1 up / +1 down); resequences so seqs follow the list.
export function reorderItem(seq: number, dir: -1 | 1) {
	const items = [...$missionItems.get()];
	const i = items.findIndex((it) => it.seq === seq);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= items.length) return;
	[items[i], items[j]] = [items[j], items[i]];
	setMissionItems(items);
}

export function clearMission() {
	$missionItems.set([]);
	$missionCurrent.set(null);
	$missionReached.set(null);
	$missionProgress.set(null);
}
