import { atom } from "nanostores";

// PX4 STATUSTEXT messages (warnings, failsafe reasons, mode-change rejections)
// surfaced to the operator, plus local notes the UI pushes (e.g. a fly-to-here
// command). Bounded ring so a long session can't grow without limit.
export interface StatusEntry {
	id: number;        // monotonic, for stable React keys
	severity: number;  // MAV_SEVERITY: 0 emergency … 7 debug
	text: string;
	t: number;         // ms epoch
}

const MAX = 200;
let seq = 0;

export const $statusTexts = atom<StatusEntry[]>([]);

export function pushStatus(severity: number, text: string, t: number = Date.now()) {
	const entry: StatusEntry = { id: seq++, severity, text, t };
	const cur = $statusTexts.get();
	const next = cur.length >= MAX ? cur.slice(cur.length - MAX + 1) : cur.slice();
	next.push(entry);
	$statusTexts.set(next);
}

export function clearStatus() {
	$statusTexts.set([]);
}
