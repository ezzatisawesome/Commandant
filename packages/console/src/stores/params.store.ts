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
	const cur = $params.get();
	// Shallow-clone so nanostores sees a new reference and subscribers re-render.
	$params.set({ ...cur, [p.name]: p });
}

export function setParamProgress(received: number, count: number) {
	$paramProgress.set({ received, count });
	if (received >= count && count > 0) {
		// Download complete — clear the progress indicator shortly after.
		$paramProgress.set(null);
	}
}

export function clearParams() {
	$params.set({});
	$paramProgress.set(null);
}
