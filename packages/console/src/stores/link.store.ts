import { atom } from "nanostores";

import type { LinkState } from "@/types/app";

// Current console<->gs link health, driven by the telemetry client from each
// frame's `linkState` (and `link` messages). "lost" until the first connect
// attempt. The connection indicator in FlightHUD subscribes to this.
export const $linkState = atom<LinkState>("lost");
