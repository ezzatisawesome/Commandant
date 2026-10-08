import { atom } from "nanostores";

// Live PX4 parameter table (name -> value/type/index), populated from the gs
// daemon's `param` stream in response to a `param_refresh`. Phase 2: the editor
// reads this store; edits go back out as `param_set` and are confirmed by a
// `param_ack` (see services/telemetry.ts).
export interface ParamEntry {
	name: string;
	value: number;
	ptype: number;  // MAV_PARAM_TYPE
	index: number;  // position in the full list
}

export const $params = atom<Record<string, ParamEntry>>({});

// Refresh progress: { received, count } while a full download is in flight, else
// null. Drives the progress bar in the param editor.
export const $paramProgress = atom<{ received: number; count: number } | null>(null);

export function upsertParam(p: ParamEntry) {
	upsertParams([p]);
}

// One store write per batch: a full PX4 list is ~1000 values, and one clone +
// re-render per value was O(n²) and visibly froze the editor during a refresh.
export function upsertParams(list: ParamEntry[]) {
	if (list.length === 0) return;
	const next = { ...$params.get() };
	for (const p of list) next[p.name] = p;
	$params.set(next);
}

// Refresh progress. `done` (from gs) ends the download: the bar clears, and an
// `error` (e.g. "timeout" when the vehicle stopped answering) is surfaced via
// $paramError so the editor can say why the list is incomplete.
export const $paramError = atom<string | null>(null);

export function setParamProgress(received: number, count: number, done = false, error?: string) {
	if (done) {
		$paramProgress.set(null);
		$paramError.set(error ?? null);
		return;
	}
	$paramError.set(null);
	$paramProgress.set({ received, count });
}

export function clearParams() {
	$params.set({});
	$paramProgress.set(null);
	$paramError.set(null);
}
