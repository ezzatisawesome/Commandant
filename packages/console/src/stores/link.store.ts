import { atom } from "nanostores";

import type { LinkState } from "@/types/app";

// Current console<->gs link health, driven by the telemetry client from each
// frame's `linkState` (and `link` messages). "lost" until the first connect
// attempt. The connection indicator in FlightHUD subscribes to this.
export const $linkState = atom<LinkState>("lost");

// Whether THIS client currently holds command authority. gs allows commands only
// from the single active commander; on connect we `claim` (with an id) and set
// this from the reply. null = unknown (not yet answered — treated optimistically
// so an older gs that doesn't ack claims still lets us command); true = we have
// control; false = another GCS holds it (commands will be rejected).
export const $commander = atom<boolean | null>(null);
