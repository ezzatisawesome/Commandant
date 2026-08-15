import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

// The PX4 airframe config (`1100_jsbsim_rev6`) is the source of truth in the
// sibling AircraftSim repo's committed artifacts — the same file that gets
// installed into PX4's ROMFS. Read it live so the viewer never drifts from what
// actually flies. Override the location with AIRFRAME_CONFIG_PATH.
const DEFAULT_PATH = path.resolve(
	process.cwd(),
	"..",
	"AircraftSim",
	"px4",
	"rev6-artifacts",
	"1100_jsbsim_rev6",
);

// The file is read per request (no build-time snapshot) so edits show up on refresh.
export const dynamic = "force-dynamic";

export async function GET() {
	const file = process.env.AIRFRAME_CONFIG_PATH || DEFAULT_PATH;
	try {
		const content = await readFile(file, "utf8");
		return NextResponse.json({ name: path.basename(file), path: file, content });
	} catch (err) {
		return NextResponse.json(
			{ error: `Cannot read airframe config at ${file}: ${(err as Error).message}` },
			{ status: 404 },
		);
	}
}
