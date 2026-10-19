import path from "node:path";

// Where the PX4 airframe config lives, as a list of candidates.
//
// The old route used one path, `cwd/../AircraftSim/px4/rev6-artifacts/...`,
// which was correct when this package WAS the repo root. The monorepo move made
// cwd `packages/console`, so it resolved to `packages/AircraftSim/...` — and the
// sibling repo has since renamed `rev6-artifacts` to `artifacts`. Two
// independent breakages, neither noticed, because the only symptom was a 404
// the console swallowed: the "changed from default" markers in the parameter
// editor simply never appeared, and nothing said why.
//
// Hence candidates rather than one path, and a response that says which were
// tried — so the next rename is a visible miss rather than a silent one.
export const AIRFRAME_FILE = "1100_jsbsim_rev6";

export function airframeCandidates(
	cwd: string = process.cwd(),
	override: string | undefined = process.env.AIRFRAME_CONFIG_PATH,
): string[] {
	if (override) return [override];
	const dirs = ["artifacts", "rev6-artifacts"];
	// From packages/console (dev and production) and from the repo root, since
	// the server can be started from either.
	const roots = [
		path.resolve(cwd, "..", "..", ".."),
		path.resolve(cwd, ".."),
		path.resolve(cwd),
	];
	const out: string[] = [];
	for (const root of roots) {
		for (const dir of dirs) {
			out.push(path.join(root, "AircraftSim", "px4", dir, AIRFRAME_FILE));
		}
	}
	return out;
}
