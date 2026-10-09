import { describe, it, expect } from "vitest";

import { firstTaggedId, pickedId, tagSeq } from "@/lib/pickTag";

// A Cesium pick entry wrapping a tagged entity.
const ent = (id: string) => ({ id: { id } });
// An untagged entity, which is what a fence wall or a circle's cylinder is.
const volume = { id: {} };

describe("pickedId", () => {
	it("reads the id off a picked entity", () => {
		expect(pickedId(ent("mission-wp-3"))).toBe("mission-wp-3");
	});

	it("reads a bare string id (a primitive picked without an entity)", () => {
		expect(pickedId({ id: "geo-fence-1" })).toBe("geo-fence-1");
	});

	it("returns null for geometry carrying no id", () => {
		expect(pickedId(volume)).toBeNull();
		expect(pickedId({})).toBeNull();
		expect(pickedId(null)).toBeNull();
		expect(pickedId(undefined)).toBeNull();
	});
});

describe("firstTaggedId", () => {
	it("finds a marker buried under translucent fence geometry", () => {
		// This is the bug that made boundaries unadjustable: scene.pick returned
		// only the first entry — the wall — so the vertex was never grabbed.
		const picks = [volume, volume, ent("geo-fence-2")];
		expect(firstTaggedId(picks, ["geo-fence-"])).toBe("geo-fence-2");
	});

	it("reaches a circle centre sitting inside its own cylinder", () => {
		const picks = [volume, ent("geo-circle-c-0"), volume];
		expect(firstTaggedId(picks, ["geo-circle-c-", "geo-fence-"])).toBe("geo-circle-c-0");
	});

	it("honours depth order: the nearest handle wins", () => {
		const picks = [ent("mission-alt-1"), ent("mission-wp-1")];
		expect(firstTaggedId(picks, ["mission-wp-", "mission-alt-"])).toBe("mission-alt-1");
	});

	it("ignores tagged entities of other layers", () => {
		const picks = [ent("geo-rally-0"), ent("mission-wp-4")];
		expect(firstTaggedId(picks, ["mission-wp-"])).toBe("mission-wp-4");
	});

	it("returns null when nothing under the cursor is a handle", () => {
		expect(firstTaggedId([volume, volume], ["mission-wp-"])).toBeNull();
		expect(firstTaggedId([], ["mission-wp-"])).toBeNull();
	});

	it("tolerates a missing pick list (drillPick on an empty scene)", () => {
		expect(firstTaggedId(undefined as never, ["mission-wp-"])).toBeNull();
	});
});

describe("tagSeq", () => {
	it("extracts the trailing sequence number", () => {
		expect(tagSeq("mission-wp-12", "mission-wp-")).toBe(12);
		expect(tagSeq("geo-fence-0", "geo-fence-")).toBe(0);
	});

	it("rejects a mismatched prefix, so one layer cannot drag another's item", () => {
		expect(tagSeq("geo-fence-3", "mission-wp-")).toBeNull();
	});

	it("rejects a malformed tail rather than returning NaN as a seq", () => {
		expect(tagSeq("mission-wp-", "mission-wp-")).toBeNull();
		expect(tagSeq("mission-wp-x", "mission-wp-")).toBeNull();
		expect(tagSeq("mission-wp--1", "mission-wp-")).toBeNull();
		expect(tagSeq(null, "mission-wp-")).toBeNull();
	});
});
