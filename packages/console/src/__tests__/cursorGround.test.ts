import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The cursor's plumb line and the double-click waypoint are both mouse gestures
// on a Cesium canvas, which is the one part of this app a unit test cannot
// mount cheaply. These are source-level guards on the properties that make the
// two behave: the cursor layer must not rebuild entities per mouse-move, and
// the double-click must not fight Cesium's own default or the single-click add.

const read = (f: string) =>
	readFileSync(join(__dirname, "..", "components", "flight", f), "utf8");

const CURSOR = read("CursorGround.tsx");
const MISSION = read("MissionLayer.tsx");

describe("the cursor's vector to ground", () => {
	it("draws a vertical line from the picked point down to the ground", () => {
		expect(CURSOR).toContain("polyline");
		expect(CURSOR).toContain("ArcType.NONE");
		// Both ends share lat/lon and differ only in height — that is what makes
		// it a plumb line rather than a line to somewhere else.
		expect(CURSOR).toMatch(/const atHeight = \(extra: number\)/);
		expect(CURSOR).toContain("ground.height + extra");
	});

	it("picks terrain first and falls back to the ellipsoid", () => {
		// globe.pick follows the loaded tiles; pickEllipsoid is the honest answer
		// while they stream in. Using only the latter puts the stem underground
		// anywhere with relief.
		const at = CURSOR.indexOf("scene.globe.pick(ray, scene)");
		const fallback = CURSOR.indexOf("pickEllipsoid");
		expect(at).toBeGreaterThan(-1);
		expect(fallback).toBeGreaterThan(at);
	});

	it("creates its entities once, not per mouse-move", () => {
		// A mouse-move is an assignment plus a requestRender. If entities.add
		// appears inside the move handler, every pixel of travel churns the scene.
		const moveAt = CURSOR.indexOf("ScreenSpaceEventType.MOUSE_MOVE");
		const lastAdd = CURSOR.lastIndexOf("entities.add");
		expect(lastAdd).toBeGreaterThan(-1);
		expect(lastAdd).toBeLessThan(moveAt);
		expect(CURSOR).toContain("CallbackPositionProperty");
		expect(CURSOR).toContain("scene.requestRender()");
	});

	it("hides itself when the cursor is not on the globe", () => {
		// Sky, or off the canvas entirely. A stale stem left behind at the last
		// hit reads as a live measurement.
		expect(CURSOR).toContain("setShown(false)");
		expect(CURSOR).toContain('addEventListener("pointerleave"');
	});

	it("takes no clicks and adds no chrome", () => {
		expect(CURSOR).toContain("return null;");
		expect(CURSOR).not.toContain("LEFT_CLICK");
		expect(CURSOR).not.toContain("className");
	});
});

describe("double-click to place a waypoint", () => {
	it("binds the gesture and removes Cesium's own default", () => {
		// Cesium's default LEFT_DOUBLE_CLICK tracks the picked entity, which would
		// snap the camera onto the aircraft at the moment of placing a waypoint.
		expect(MISSION).toContain("ScreenSpaceEventType.LEFT_DOUBLE_CLICK");
		expect(MISSION).toContain(
			"$viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)",
		);
	});

	it("shows what it just made", () => {
		// The point of the gesture: one move puts a waypoint on the globe AND
		// leaves it visible and grabbable, without arming edit mode first.
		const at = MISSION.indexOf("ScreenSpaceEventType.LEFT_DOUBLE_CLICK", 0);
		expect(at).toBeGreaterThan(-1);
		expect(MISSION).toContain("$missionEdit.set(true)");
	});

	it("yields one waypoint per gesture, not two", () => {
		// Cesium delivers LEFT_CLICK and then LEFT_DOUBLE_CLICK for the same
		// gesture, so in edit mode the pair would otherwise stack two waypoints on
		// the same spot.
		expect(MISSION).toContain("let justAdded = false;");
		expect(MISSION).toContain("if (!justAdded) addAt(m.position);");
	});

	it("leaves an existing marker's own double-click alone", () => {
		// A double-click on a waypoint or a grabber is aimed at that item, not at
		// the ground behind it.
		expect(MISSION).toContain("const onHandle = firstTaggedId(");
		expect(MISSION).toContain("if (onHandle) return;");
	});

	it("never authors in the read-only build", () => {
		const dbl = MISSION.slice(MISSION.indexOf("LEFT_DOUBLE_CLICK", MISSION.indexOf("removeInputAction")));
		expect(dbl).toContain("if (IS_VIEW");
	});
});
