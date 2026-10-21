import { describe, it, expect, beforeEach } from "vitest";

import { $params, $paramProgress, $paramError, upsertParam, upsertParams, setParamProgress, clearParams, $paramsStale, markParamsStale } from "@/stores/params.store";
import { parseParamInput, validateParam, isIntegerPtype } from "@/lib/paramMeta";

beforeEach(() => clearParams());

describe("params store", () => {
	it("a batch of N params is ONE store notification", () => {
		let n = 0;
		const unsub = $params.listen(() => n++);
		upsertParams(Array.from({ length: 300 }, (_, i) => ({ name: `P${i}`, value: i, ptype: 9, index: i })));
		unsub();
		expect(n).toBe(1);
		expect(Object.keys($params.get())).toHaveLength(300);
	});
	it("single upsert still works and overwrites by name", () => {
		upsertParam({ name: "A", value: 1, ptype: 9, index: 0 });
		upsertParam({ name: "A", value: 2, ptype: 9, index: 0 });
		expect($params.get().A.value).toBe(2);
	});
	it("progress: done clears the bar; done+error surfaces the error; next refresh clears it", () => {
		setParamProgress(10, 100);
		expect($paramProgress.get()).toEqual({ received: 10, count: 100 });
		setParamProgress(100, 100, true);
		expect($paramProgress.get()).toBeNull();
		expect($paramError.get()).toBeNull();
		setParamProgress(60, 100, true, "timeout");
		expect($paramError.get()).toBe("timeout");
		clearParams();
		expect($paramError.get()).toBeNull();
	});
});

describe("param input validation", () => {
	it("an emptied field is NOT zero", () => {
		expect(parseParamInput("")).toBeNaN();
		expect(parseParamInput("   ")).toBeNaN();
		expect(parseParamInput(" 2.5 ")).toBe(2.5);
		expect(validateParam(undefined, parseParamInput(""))).toBe("not a number");
	});
	it("integer-ness comes from the wire ptype even without metadata", () => {
		expect(isIntegerPtype(6)).toBe(true);   // INT32
		expect(isIntegerPtype(9)).toBe(false);  // REAL32
		expect(validateParam(undefined, 1.5, 6)).toBe("must be an integer");
		expect(validateParam(undefined, 1.5, 9)).toBeNull();
		expect(validateParam({ name: "X", type: "Int32" }, 2.5)).toBe("must be an integer");
	});
	it("range checks use metadata", () => {
		const meta = { name: "X", min: 0, max: 10 };
		expect(validateParam(meta, -1)).toMatch(/below min/);
		expect(validateParam(meta, 11)).toMatch(/above max/);
		expect(validateParam(meta, 5)).toBeNull();
	});
});

describe("a cached param table cannot be vouched for across a dropped link", () => {
	// Params are a READ OF THE VEHICLE, not the operator's own work, and PX4
	// reverts anything it did not save. gs announces a reboot it witnessed
	// (vehicle_reboot) — but it cannot announce an event it missed, and a
	// dropped socket is exactly a window where it was not watching: the daemon
	// may have restarted, the vehicle may have rebooted, the radio may have been
	// moved to another aircraft.
	beforeEach(() => clearParams());

	it("marks the table unverified rather than throwing it away", () => {
		upsertParams([{ name: "FW_AIRSPD_TRIM", value: 15, ptype: 9, index: 1 }]);
		expect($paramsStale.get()).toBe(false);
		markParamsStale();
		expect($paramsStale.get()).toBe(true);
		// The values stay: a thousand of them should not vanish because the WiFi
		// hiccuped. They just stop being presented as current.
		expect($params.get()["FW_AIRSPD_TRIM"].value).toBe(15);
	});

	it("says nothing when there was nothing cached", () => {
		markParamsStale();
		expect($paramsStale.get()).toBe(false);
	});

	it("a refresh re-reading from the vehicle clears the doubt", () => {
		upsertParams([{ name: "FW_AIRSPD_TRIM", value: 15, ptype: 9, index: 1 }]);
		markParamsStale();
		expect($paramsStale.get()).toBe(true);
		setParamProgress(10, 400);
		expect($paramsStale.get()).toBe(false);
	});

	it("clearing the table clears the flag with it", () => {
		upsertParams([{ name: "FW_AIRSPD_TRIM", value: 15, ptype: 9, index: 1 }]);
		markParamsStale();
		clearParams();
		expect($paramsStale.get()).toBe(false);
		expect($params.get()).toEqual({});
	});
});
