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

/** The at most `limit` alerts to show, newest first, given the log and the set
 *  the operator has already dismissed.
 *
 *  Newest first because during a cascade (a failsafe triggers three messages in
 *  a second) the latest is the one that explains the current state. */
export function selectAlerts(
	entries: StatusEntry[], dismissed: ReadonlySet<number>, limit = 3,
): Alert[] {
	const out: Alert[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
		const e = entries[i];
		if (!isAlerting(e.severity) || dismissed.has(e.id)) continue;
		out.push({ ...e, sticky: dwellMs(e.severity) === null });
	}
	return out;
}
