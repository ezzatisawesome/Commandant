import { describe, it, expect } from "vitest";

import { AIRFRAME_FILE, airframeCandidates } from "@/lib/airframePath";

describe("finding the airframe config", () => {
	// The route used one path, `cwd/../AircraftSim/px4/rev6-artifacts/<file>`,
	// correct when this package WAS the repo root. The monorepo move made cwd
	// `packages/console`, so it resolved to `packages/AircraftSim/...` — and the
	// sibling repo then renamed `rev6-artifacts` to `artifacts`. Two independent
	// breakages, neither noticed, because the only symptom was a 404 the console
	// swallowed: the ● changed-from-default markers stopped appearing and nothing
	// said why.
	const CONSOLE_DIR = "/repo/Commandant/packages/console";

	it("looks beside the monorepo, not inside packages/", () => {
		const c = airframeCandidates(CONSOLE_DIR, undefined);
		expect(c).toContain(`/repo/AircraftSim/px4/artifacts/${AIRFRAME_FILE}`);
		// The old, broken resolution — kept as a candidate but no longer first.
		expect(c[0]).not.toContain("/packages/AircraftSim/");
	});

	it("tries the current directory name first and the old one as a fallback", () => {
		const c = airframeCandidates(CONSOLE_DIR, undefined);
		const artifacts = c.findIndex((p) => p.includes("/px4/artifacts/"));
		const rev6 = c.findIndex((p) => p.includes("/px4/rev6-artifacts/"));
		expect(artifacts).toBeGreaterThanOrEqual(0);
		expect(rev6).toBeGreaterThan(artifacts);
	});

	it("works when the server is started from the repo root instead", () => {
		const c = airframeCandidates("/repo/Commandant", undefined);
		expect(c.some((p) => p === `/repo/AircraftSim/px4/artifacts/${AIRFRAME_FILE}`)).toBe(true);
	});

	it("an explicit override wins outright, and is the only candidate", () => {
		// If someone has said where the file is, trying other places can only
		// find the wrong one.
		const c = airframeCandidates(CONSOLE_DIR, "/elsewhere/airframe");
		expect(c).toEqual(["/elsewhere/airframe"]);
	});
});
