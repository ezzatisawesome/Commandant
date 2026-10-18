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

/** True when the cached table can no longer be vouched for.
 *
 *  Params are a READ OF THE VEHICLE, not the operator's own work, and PX4
 *  reverts anything it did not save. gs announces a reboot it witnessed
 *  (`vehicle_reboot`) and the cache is dropped — but gs cannot announce an
 *  event it missed, and a dropped socket is exactly a window where it was not
 *  watching: the daemon may have restarted, the vehicle may have rebooted, the
 *  radio may have been moved to a different aircraft.
 *
 *  Clearing the table on every blip would throw away a thousand values the
 *  operator is reading because the WiFi hiccuped. Marking it instead keeps them
 *  on screen and says they are unverified — the same treatment a cold wind
 *  estimate gets, and the same principle: stale data may be shown, but never as
 *  though it were current. */
export const $paramsStale = atom(false);

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
	// A refresh in flight is re-reading from the vehicle, so whatever it has
	// returned so far is current again.
	$paramsStale.set(false);
}

export function clearParams() {
	$params.set({});
	$paramProgress.set(null);
	$paramError.set(null);
	$paramsStale.set(false);     // nothing cached, so nothing unverified
}

/** The link went away and came back: whatever is cached predates the gap. */
export function markParamsStale() {
	if (Object.keys($params.get()).length > 0) $paramsStale.set(true);
}
