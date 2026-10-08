import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Cesium's graphics properties are not interchangeable, and getting one wrong is
// not a quiet visual glitch: it throws inside the render loop, every frame, and
// takes the entire globe down with it. That failure cannot be caught by a store
// test, and mounting Cesium under happy-dom to catch it is heavier than the bug
// deserves. So these are source-level guards on the two mistakes we have
// actually made.

const DIR = join(__dirname, "..", "components", "flight");
const sources = readdirSync(DIR)
	.filter((f) => f.endsWith(".tsx"))
	.map((f) => [f, readFileSync(join(DIR, f), "utf8")] as const);

describe("cesium graphics property types", () => {
	it("never assigns a bare CallbackProperty to a geometry material", () => {
		// A polyline/polygon `material` is a MaterialProperty: Cesium calls
		// `getType()` on it. A CallbackProperty returning a Color has no such
		// method, so the first frame throws
		// "materialProperty.getType is not a function" and the scene stops.
		// The fix is always ColorMaterialProperty(callback).
		const offenders: string[] = [];
		for (const [name, src] of sources) {
			const re = /material:\s*new CallbackProperty/g;
			if (re.test(src)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});

	it("wraps every per-frame material colour in a MaterialProperty", () => {
		// The inverse check: wherever a material is computed per frame, the wrapper
		// must be present in the same expression.
		for (const [name, src] of sources) {
			const matches = src.match(/material:[^,;]*CallbackProperty[^;]*/g) ?? [];
			for (const m of matches) {
				expect(m, `${name}: ${m.slice(0, 90)}`).toContain("MaterialProperty");
			}
		}
	});

	it("casts a callback to Color only for label and point colours", () => {
		// `as unknown as Color` is how we satisfy the types for a per-frame colour.
		// It is legitimate for fillColor/outlineColor/color, which really are
		// Property<Color>, and a lie for `material`, which is not.
		for (const [name, src] of sources) {
			const lines = src.split("\n");
			lines.forEach((line, i) => {
				if (!line.includes("as unknown as Color")) return;
				// Walk back to the property this cast terminates.
				const window = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
				const prop = [...window.matchAll(/(\w+):\s*new (?:ColorMaterialProperty|CallbackProperty)/g)].pop();
				expect(prop?.[1], `${name}:${i + 1}`).toMatch(/^(fillColor|outlineColor|color)$/);
			});
		}
	});
});
