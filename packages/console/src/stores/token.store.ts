import { persistentAtom } from "@nanostores/persistent";

/** The hub's command token, as the operator typed it.
 *
 *  gs binds 0.0.0.0 and the hub runs its own WiFi on a flight line, so without
 *  a secret anyone within range who loads the page can take command authority
 *  and arm the aircraft. gs gates the CLAIM on this token -- telemetry stays
 *  open to everyone, because watching the aircraft fly is what the hub is for.
 *
 *  Kept per browser rather than served with the page: a token the page handed
 *  out would be a token anyone who loaded the page already has, which is the
 *  attack it is meant to stop. So it is typed once on the device that is going
 *  to fly, and remembered there.
 *
 *  An empty string is the normal state for a bench or SITL setup, where gs runs
 *  without a token and says so at startup. */
export const $commandToken = persistentAtom<string>("commandant:token", "");

/** True once gs has refused a claim for want of the token. Drives the prompt;
 *  not persisted, because it is about this session's last answer and not about
 *  the hub. */
import { atom } from "nanostores";
export const $tokenRequired = atom(false);

export function setCommandToken(t: string) {
	$commandToken.set(t.trim());
}
