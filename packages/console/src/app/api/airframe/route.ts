import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { airframeCandidates } from "@/lib/airframePath";

// The PX4 airframe config (`1100_jsbsim_rev6`) is the source of truth in the
// sibling AircraftSim repo's committed artifacts — the same file that gets
// installed into PX4's ROMFS. Read it live so the viewer never drifts from what
// actually flies. Override the location with AIRFRAME_CONFIG_PATH.
//
// The old single path was `cwd/../AircraftSim/px4/rev6-artifacts/...`, which was
// correct when this package WAS the repo root. The monorepo move made cwd
// `packages/console`, so it resolved to `packages/AircraftSim/...` — and the
// sibling repo has since renamed `rev6-artifacts` to `artifacts`. Two
// independent breakages, neither noticed, because the only symptom was a 404
// the console swallowed: the "changed from default" markers in the parameter
// editor simply never appeared, and nothing said why.
//
// So: several candidates, and the response says which were tried.
// The file is read per request (no build-time snapshot) so edits show up on refresh.
export const dynamic = "force-dynamic";

export async function GET() {
	const tried = airframeCandidates();
	for (const file of tried) {
		try {
			const content = await readFile(file, "utf8");
			return NextResponse.json({
				available: true, name: path.basename(file), path: file, content,
			});
		} catch {
			// try the next candidate
		}
	}
	// 200, not 404. A missing sibling repo is an ABSENCE, not an error: the hub
	// in the field does not have AircraftSim checked out at all, and a console
	// that logs a failed request on every page load there trains everyone to
	// ignore its error log. The editor says the defaults are unavailable
	// instead, which is the thing the operator actually needs to know.
	return NextResponse.json({ available: false, tried });
}
