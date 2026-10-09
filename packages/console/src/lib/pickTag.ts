// Resolving which overlay handle the mouse is on.
//
// Both authoring layers tag their draggable entities with a string id
// ("mission-wp-3", "geo-fence-0", "geo-circle-r-2", …) and map a pick back to an
// item. They used to do that with `scene.pick`, which returns only the TOPMOST
// primitive — and that quietly broke the moment fences became volumes: an
// inclusion wall or a circle's cylinder is drawn over its own vertex markers, so
// the pick returned the wall (an untagged entity) and the drag never armed. A
// circle fence's centre marker sits INSIDE its cylinder and was unreachable at
// any camera angle.
//
// The fix is `scene.drillPick`, which returns everything under the cursor in
// depth order. This module picks the first tagged handle out of that list, so a
// marker behind translucent geometry is still grabbable, while the geometry
// itself stays pickable for anything else that wants it.

/** The shape of a Cesium drillPick entry we care about: `.id` may be an Entity. */
export interface PickLike {
	id?: unknown;
}

/** Read an entity id string off a pick entry, or null if it carries none. */
export function pickedId(pick: PickLike | null | undefined): string | null {
	if (!pick) return null;
	const entity = pick.id as { id?: unknown } | undefined;
	// `pick.id` is the Entity; `pick.id.id` is the string we tagged it with.
	// A primitive picked straight (no entity wrapper) has a string id itself.
	const raw = entity && typeof entity === "object" ? entity.id : pick.id;
	return typeof raw === "string" ? raw : null;
}

/**
 * First id in depth order that starts with one of `prefixes`.
 *
 * Order matters and it is the caller's: pass the small, precise handles before
 * the big ones, so a grabber sitting on top of its own marker wins the pick
 * rather than losing to the marker underneath it.
 */
export function firstTaggedId(picks: readonly (PickLike | null | undefined)[], prefixes: readonly string[]): string | null {
	// Depth order first (nearest to camera), then prefix priority within a hit:
	// a single pick entry can only match one prefix, so one pass suffices.
	for (const p of picks ?? []) {
		const id = pickedId(p);
		if (id === null) continue;
		if (prefixes.some((pre) => id.startsWith(pre))) return id;
	}
	return null;
}

/** Trailing integer of a tagged id ("mission-wp-12" -> 12), or null. */
export function tagSeq(id: string | null, prefix: string): number | null {
	if (!id || !id.startsWith(prefix)) return null;
	const tail = id.slice(prefix.length);
	// Digits only: `Number("")` is 0, so an empty or signed tail would otherwise
	// resolve to item 0 and drag the wrong waypoint.
	if (!/^\d+$/.test(tail)) return null;
	const n = Number(tail);
	return Number.isSafeInteger(n) ? n : null;
}
