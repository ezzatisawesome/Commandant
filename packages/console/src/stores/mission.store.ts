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

/** Which plan planes have been READ BACK from the vehicle this session.
 *
 *  An empty plan panel meant two different things and said neither: "the
 *  aircraft has no mission" and "nobody has asked the aircraft". On a fresh
 *  page load — or after a reconnect, when the daemon may have restarted — it is
 *  always the second, and the panel read as the first.
 *
 *  Auto-pulling on connect is the wrong fix twice over: these stores hold the
 *  operator's EDITABLE draft, so a pull would discard unsaved authoring work,
 *  and it would spend radio bandwidth on every page load and every viewer that
 *  joins. The right fix is to stop implying. A readback sets the flag; a
 *  reconnect clears it, because what the vehicle holds may have changed while
 *  nobody was listening. */
/** What the VEHICLE holds, as distinct from the draft in `$missionItems`.
 *
 *  `null` means unknown — nothing has been read back or uploaded this session.
 *
 *  These were the same thing, and conflating them is worse than it sounds.
 *  `$missionItems` is the operator's editable draft, and every add, remove or
 *  reorder runs it through `resequence`, which renumbers items 0..n-1. Mission
 *  execution state — `$missionCurrent`, `$missionReached` — arrives from PX4 as
 *  a seq into the mission the VEHICLE is flying. Apply one to the other and the
 *  globe highlights whichever draft item now happens to carry that number: the
 *  operator watches the aircraft fly toward a point it is not flying toward.
 *
 *  Keeping what the vehicle holds makes the divergence computable instead of
 *  invisible, so the UI can stop asserting rather than assert something wrong. */
export const $vehicleMission = atom<MissionItem[] | null>(null);

/** Record what the vehicle holds: a readback, or an upload that was accepted. */
export function setVehicleMission(items: MissionItem[] | null) {
	$vehicleMission.set(items === null ? null : items.map((it) => ({ ...it })));
}

/** Does the draft still describe what the vehicle is flying?
 *
 *  `false` whenever that cannot be established, including when nothing has been
 *  read back — an unverified match is not a match, and this gates whether
 *  execution state may be drawn on the draft at all. Compared on the fields
 *  that decide where the aircraft goes; a differing accept-radius is not worth
 *  disclaiming the whole plan over. */
export function missionMatchesVehicle(
	draft: MissionItem[] = $missionItems.get(),
	vehicle: MissionItem[] | null = $vehicleMission.get(),
): boolean {
	if (vehicle === null) return false;
	if (draft.length !== vehicle.length) return false;
	const near = (a: number | undefined, b: number | undefined, eps: number) =>
		(a ?? 0) === (b ?? 0) || Math.abs((a ?? 0) - (b ?? 0)) < eps;
	return draft.every((d, i) => {
		const v = vehicle[i];
		return d.kind === v.kind
			&& near(d.lat, v.lat, 1e-7) && near(d.lon, v.lon, 1e-7)
			&& near(d.alt, v.alt, 0.5);
	});
}

export const $planRead = atom<{ mission: boolean; fence: boolean; rally: boolean }>({
	mission: false, fence: false, rally: false,
});

export function markPlanRead(plane: "mission" | "fence" | "rally") {
	const cur = $planRead.get();
	if (!cur[plane]) $planRead.set({ ...cur, [plane]: true });
}

/** The link dropped: whatever was read predates the gap. */
export function clearPlanRead() {
	$planRead.set({ mission: false, fence: false, rally: false });
}

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
