import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { nextOpen } from "@/components/flight/Dock";

// The viewport is the instrument: the 3D world is what the operator is actually
// reading, and every panel is a hole in it. Chrome creeps back one panel at a
// time and nothing else notices, so these tests hold the screen budget in place.

const PAGE = readFileSync(
	join(__dirname, "..", "app", "flight", "page.tsx"), "utf8",
);
const DOCK = readFileSync(
	join(__dirname, "..", "components", "flight", "Dock.tsx"), "utf8",
);

const PANELS = [
	"MissionPanel", "GeoPanel", "ParamEditor", "AirframeConfig",
	"StatusLog", "ViewControls", "InstrumentPanel",
];

describe("flight page screen budget", () => {
	it("pins nothing to the left edge but the wordmark", () => {
		// A `fixed` element with `left-` is how a left-hand panel gets built. The
		// wordmark is the one allowance, and it is pointer-events-none, so it cannot
		// grow into a panel without this test noticing.
		const leftAnchored = [...PAGE.matchAll(/className="([^"]*\bfixed\b[^"]*\bleft-[^"]*)"/g)]
			.map((m) => m[1]);
		expect(leftAnchored).toHaveLength(1);
		expect(leftAnchored[0]).toContain("pointer-events-none");
	});

	it("pins nothing on the page but the wordmark", () => {
		// The HUD, the alerts and the strip own their own fixed containers inside
		// their components. The page itself places only the wordmark; everything
		// else reaches the screen through the dock or one of those overlays.
		const fixedBlocks = [...PAGE.matchAll(/className="[^"]*\bfixed\b[^"]*"/g)];
		expect(fixedBlocks).toHaveLength(1);
		expect(PAGE).toContain("<Dock items={items} />");
		expect(PAGE).toContain("<Hud />");
	});

	it("draws attitude and heading as a HUD, not as boxed widgets", () => {
		// The boxed attitude indicator and compass were a picture OF the aircraft
		// in a corner. The HUD is the view FROM it, drawn over the globe at no cost
		// in area. Reintroducing a boxed instrument should fail here.
		expect(PAGE).not.toContain("HeadsUpInstruments");
		expect(PAGE).not.toContain("AttitudeIndicator");
		expect(PAGE).not.toContain("Compass");
	});

	it("routes every heavyweight panel through the dock", () => {
		const itemsAt = PAGE.indexOf("const items: DockItem[]");
		const returnAt = PAGE.indexOf("\treturn (");
		expect(itemsAt).toBeGreaterThan(-1);
		for (const name of PANELS) {
			const uses = [...PAGE.matchAll(new RegExp(`<${name}\\s*/>`, "g"))];
			expect(uses, name).toHaveLength(1);
			const at = PAGE.indexOf(`<${name} />`);
			expect(at, `${name} must live in the dock item list`).toBeGreaterThan(itemsAt);
			expect(at, `${name} must not be rendered in the page body`).toBeLessThan(returnAt);
		}
	});

	it("keeps the dock a gutter rather than a sidebar", () => {
		// 36 px. Wide enough for a 28 px icon button, narrow enough that it reads as
		// an edge. A rail is what this replaced.
		expect(DOCK).toContain("w-9");
	});

	it("holds the icon rail still when a panel opens", () => {
		// The rail is centred with -translate-y-1/2. If the panel shares the rail's
		// flex flow, opening one changes the group's height and the centring moves
		// every icon — so you cannot click the same icon again to close it. The
		// panel must therefore be positioned out of flow, off the rail's edge.
		expect(DOCK).toContain("absolute right-full");
		const wrapper = DOCK.match(/ref=\{wrap\} className="([^"]*)"/)?.[1] ?? "";
		expect(wrapper).toContain("-translate-y-1/2");
		expect(wrapper, "the rail wrapper must not lay the panel out in flow")
			.not.toContain("flex");
	});

	it("dismisses an open panel on Escape and on a click outside it", () => {
		expect(DOCK).toContain('e.key === "Escape"');
		// Capture phase matters: Cesium stops propagation on the canvas, so a
		// bubbling listener never sees a click on the globe and the panel would
		// stay open exactly where it is most in the way.
		expect(DOCK).toContain('"pointerdown", onDown, true');
	});
});

describe("dock panel selection", () => {
	it("opens the clicked panel when nothing is open", () => {
		expect(nextOpen(null, "mission")).toBe("mission");
	});

	it("replaces rather than adds, because two open panels is a rail again", () => {
		expect(nextOpen("mission", "params")).toBe("params");
	});

	it("closes when the open panel's own icon is clicked", () => {
		expect(nextOpen("mission", "mission")).toBeNull();
	});

	it("never returns a pair", () => {
		// The signature is the guarantee: one key or none, so there is no
		// representation of "two panels open" to drift into.
		const out: unknown = nextOpen("a", "b");
		expect(Array.isArray(out)).toBe(false);
		expect(typeof out).toBe("string");
	});
});
