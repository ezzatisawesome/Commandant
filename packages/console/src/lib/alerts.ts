// Which autopilot messages interrupt the operator, and for how long.
//
// This exists because moving the status log behind the dock created a safety
// hole: PX4 announces a failsafe, a geofence breach or a refused mode change
// through STATUSTEXT, and if that only lands in a panel nobody has open, the
// operator learns about it from the aircraft's behaviour instead. The log is
// still the record. This decides what also gets pushed in front of them.
//
// Kept pure and separate from the component so the policy is testable: a
// severity threshold and a dismissal rule are exactly the kind of thing that
// drifts silently once it lives inside JSX.

import type { StatusEntry } from "@/stores/statustext.store";

/** MAV_SEVERITY: 0 emergency, 1 alert, 2 critical, 3 error, 4 warning,
 *  5 notice, 6 info, 7 debug. */
export const SEV_ERROR = 3;
export const SEV_WARNING = 4;

/** Warnings and worse interrupt. Notice and below stay in the log only.
 *
 *  Drawing the line at warning is deliberate: PX4 is chatty at notice and info
 *  (every mode change, every mission item), and an alert surface that fires on
 *  routine chatter is one the operator learns to ignore — which is worse than
 *  not having it. */
export function isAlerting(sev: number): boolean {
	return sev <= SEV_WARNING;
}

/** How long a toast stays up, in ms, or `null` to mean "until dismissed".
 *
 *  Errors and worse do not auto-dismiss. A failsafe that scrolled away while
 *  the operator was looking at the globe is a failsafe they never saw. */
export function dwellMs(sev: number): number | null {
	return sev <= SEV_ERROR ? null : 12_000;
}

export interface Alert extends StatusEntry {
	/** True when it must be clicked away rather than timing out. */
	sticky: boolean;
}

export interface AlertSelection {
	/** What is on screen: the newest `limit` alerting, not-yet-dismissed
	 *  entries, newest first. */
	visible: Alert[];
	/** Alerting, not-yet-dismissed entries OLDER than the visible window.
	 *
	 *  These are NOT a queue waiting for a slot. The component retires them on
	 *  sight and shows a count, because promoting them later was the bug: the
	 *  selection returned the newest three, the component armed dwell timers
	 *  only for those three, and each timeout promoted the next three OLDER
	 *  entries as if they had just arrived. Traced against 10 severity-4 entries
	 *  with a 12 s dwell: t=0 w9,w8,w7; t=12 w6,w5,w4; t=24 w3,w2,w1; t=36 w0 —
	 *  48 seconds of toasts ending with the OLDEST warning alone on screen as
	 *  though it were the current situation. During a failsafe cascade that
	 *  replays the flight to the operator in reverse. Errors are sticky, so they
	 *  did not even age out; they queued behind each other indefinitely.
	 *
	 *  A count instead: the newest few are what explain the current state, the
	 *  status log is the record of the rest, and "+7 earlier" says there is a
	 *  record to go and read without pretending to be news. */
	overflow: Alert[];
}

/** What to show, given the log and the set the operator has already dismissed.
 *
 *  Newest first because during a cascade (a failsafe triggers three messages in
 *  a second) the latest is the one that explains the current state. */
export function selectAlerts(
	entries: StatusEntry[], dismissed: ReadonlySet<number>, limit = 3,
): AlertSelection {
	const visible: Alert[] = [];
	const overflow: Alert[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!isAlerting(e.severity) || dismissed.has(e.id)) continue;
		const alert: Alert = { ...e, sticky: dwellMs(e.severity) === null };
		(visible.length < limit ? visible : overflow).push(alert);
	}
	return { visible, overflow };
}
