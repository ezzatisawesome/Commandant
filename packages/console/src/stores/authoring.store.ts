import { computed } from "nanostores";

import { $missionEdit } from "@/stores/mission.store";
import { $geoEdit } from "@/stores/geo.store";

// Is the operator currently authoring something ON the globe?
//
// The dock dismisses its open panel on a click outside it, which is right for
// every panel that is merely being read — and wrong for the two that are being
// used to edit the globe. Placing a waypoint means clicking the globe, so the
// panel holding the Upload button closed on every single point placed: author a
// route, and the control you need next has vanished four times over.
//
// Mission edit and geo edit are separate flags so the two layers never fight
// over a click; for the dock's purposes either one means "that click was work,
// not a dismissal".
export const $globeAuthoring = computed(
	[$missionEdit, $geoEdit],
	(mission, geo) => mission || geo,
);

/**
 * Should a pointer-down outside the dock close the open panel?
 *
 * Escape always closes, and the dock icon always toggles, so keeping the panel
 * open here never traps the operator — there are two other ways out that do not
 * involve clicking the globe.
 */
export function shouldDismissOnOutsideClick(authoring: boolean): boolean {
	return !authoring;
}
