import { describe, it, expect, beforeEach } from "vitest";

import {
	$params, upsertParams, clearParams,
} from "@/stores/params.store";

/**
 * A refresh must not throw away the walk that is already running.
 *
 * gs dedupes a param_refresh while one is in flight -- deliberately, so two
 * tabs pressing Refresh cannot double the load on a radio. The console cleared
 * its table at the moment it SENT the request, so when gs ignored that request
 * the table was left holding only whatever arrived after the clear, while gs
 * went on to report "done, 720 of 720". The editor showed a partial parameter
 * table with no error of any kind.
 *
 * MEASURED against real PX4 with 720 parameters: a raw WebSocket client
 * listening from the start received all 721 names; the browser's table held
 * 121 on one run and 361 on another. After the fix: 721 in 706 ms.
 */
describe("a second refresh must not discard the first one's values", () => {
	const batch = (from: number, n: number) =>
		Array.from({ length: n }, (_, i) => ({
			name: `P_${String(from + i).padStart(4, "0")}`,
			value: from + i, ptype: 9, index: from + i,
		}));

	beforeEach(() => clearParams());

	it("overwriting in place keeps everything the walk has delivered", () => {
		upsertParams(batch(0, 300));
		// The operator presses Refresh. The old code cleared here.
		upsertParams(batch(300, 420));
		expect(Object.keys($params.get()).length).toBe(720);
	});

	it("a clear mid-walk is what lost them, which is why it is gone", () => {
		// The failure, reproduced: this is what the console used to do.
		upsertParams(batch(0, 300));
		clearParams();
		upsertParams(batch(300, 420));
		expect(Object.keys($params.get()).length).toBe(420);   // not 720
	});

	it("re-sending a value already held is not a duplicate row", () => {
		upsertParams(batch(0, 100));
		upsertParams(batch(0, 100));
		expect(Object.keys($params.get()).length).toBe(100);
	});

	it("a later value for the same name wins, so a walk refreshes in place", () => {
		upsertParams([{ name: "FW_AIRSPD_TRIM", value: 15, ptype: 9, index: 1 }]);
		upsertParams([{ name: "FW_AIRSPD_TRIM", value: 17.5, ptype: 9, index: 1 }]);
		expect($params.get()["FW_AIRSPD_TRIM"].value).toBe(17.5);
	});
});
