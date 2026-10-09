import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { uploadBlockedReason } from "@/components/flight/MissionPanel";
import { $globeAuthoring, shouldDismissOnOutsideClick } from "@/stores/authoring.store";
import { $missionEdit, clearMission } from "@/stores/mission.store";
import { $geoEdit, clearFence } from "@/stores/geo.store";

// A mission upload is commander-only in gs. These tests cover the gap that made
// "uploading a mission doesn't work" the symptom: the console claimed authority
// once, silently, on connect — and when gs had already given it to another tab,
// every upload came back "rejected" with nothing on screen saying why and no way
// to ask for it back.

describe("uploadBlockedReason", () => {
	it("permits an upload when there is a plan, a link and authority", () => {
		expect(uploadBlockedReason({ live: true, commander: true, count: 3 })).toBeNull();
	});

	it("names an empty plan first, since it is the only case the operator caused", () => {
		expect(uploadBlockedReason({ live: true, commander: true, count: 0 }))
			.toMatch(/nothing to upload/);
		// Even with no link, "add waypoints" is the more useful next step.
		expect(uploadBlockedReason({ live: false, commander: false, count: 0 }))
			.toMatch(/nothing to upload/);
	});

	it("names a dead link", () => {
		expect(uploadBlockedReason({ live: false, commander: true, count: 2 }))
			.toMatch(/no link/);
	});

	it("names lost command authority — the cause that looked like a broken button", () => {
		expect(uploadBlockedReason({ live: true, commander: false, count: 2 }))
			.toMatch(/another console holds command/);
	});

	it("treats unknown authority optimistically, as the rest of the UI does", () => {
		// commander === null means an older gs never answered the claim. Blocking
		// on that would make the console unusable against a gs that works fine;
		// the ack is the real authority either way.
		expect(uploadBlockedReason({ live: true, commander: null, count: 2 })).toBeNull();
	});

	it("always gives a reason whenever it blocks", () => {
		for (const live of [true, false]) {
			for (const commander of [true, false, null]) {
				for (const count of [0, 2]) {
					const reason = uploadBlockedReason({ live, commander, count });
					// The whole point is that a disabled button is never silent.
					if (reason !== null) expect(reason.length).toBeGreaterThan(0);
				}
			}
		}
	});
});

describe("the dock does not dismiss a panel that is being used on the globe", () => {
	beforeEach(() => {
		$missionEdit.set(false);
		$geoEdit.set(false);
		clearMission();
		clearFence();
	});
	afterEach(() => {
		$missionEdit.set(false);
		$geoEdit.set(false);
	});

	it("dismisses on an outside click when nothing is being authored", () => {
		expect($globeAuthoring.get()).toBe(false);
		expect(shouldDismissOnOutsideClick($globeAuthoring.get())).toBe(true);
	});

	it("holds the panel open while mission edit is on", () => {
		// Placing a waypoint IS a click on the globe, so dismissing on it closed
		// the panel holding Upload on every point the operator placed.
		$missionEdit.set(true);
		expect($globeAuthoring.get()).toBe(true);
		expect(shouldDismissOnOutsideClick($globeAuthoring.get())).toBe(false);
	});

	it("holds the panel open while geo edit is on", () => {
		$geoEdit.set(true);
		expect($globeAuthoring.get()).toBe(true);
		expect(shouldDismissOnOutsideClick($globeAuthoring.get())).toBe(false);
	});

	it("resumes dismissing as soon as edit mode is turned off", () => {
		$missionEdit.set(true);
		$missionEdit.set(false);
		expect(shouldDismissOnOutsideClick($globeAuthoring.get())).toBe(true);
	});
});

// The client-side half: authority has to be re-askable, and a rejected upload
// has to tell the store it lost authority so the panel can offer to take it.
describe("command authority is visible and recoverable", () => {
	// Rebuilt per test with a fresh module registry so the non-view envs mock in
	// this file does not collide with viewmode.test.ts.
	let FakeWS: typeof import("./helpers/fakeWs").FakeWS;
	let client: import("@/services/telemetry").TelemetryClient;
	let $commander: typeof import("@/stores/link.store").$commander;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		const mod = await import("./helpers/fakeWs");
		FakeWS = mod.FakeWS;
		FakeWS.instances = [];
		(globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
		({ $commander } = await import("@/stores/link.store"));
		const { TelemetryClient } = await import("@/services/telemetry");
		client = new TelemetryClient("ws://hub.test/mav");
		$commander.set(null);
	});
	afterEach(() => { client.disconnect(); vi.useRealTimers(); });

	const ws = () => FakeWS.instances[FakeWS.instances.length - 1];
	const sentTypes = () => ws().sent.map((s) => JSON.parse(s).type as string);
	const lastOfType = (t: string) =>
		ws().sent.map((s) => JSON.parse(s)).reverse().find((m) => m.type === t);

	it("claims authority on connect", () => {
		client.connect();
		ws().open();
		expect(sentTypes()).toContain("claim");
	});

	it("records the grant, so the panel can enable Upload", async () => {
		client.connect();
		ws().open();
		const claim = lastOfType("claim");
		ws().recv({ type: "ack", id: claim.id, ok: true, result: 0, text: "commander" });
		expect($commander.get()).toBe(true);
	});

	it("records a refusal, so the panel can say who has command", () => {
		client.connect();
		ws().open();
		const claim = lastOfType("claim");
		ws().recv({ type: "ack", id: claim.id, ok: false, result: -1, text: "not commander" });
		expect($commander.get()).toBe(false);
	});

	it("can ask again and report the outcome", async () => {
		client.connect();
		ws().open();
		const first = lastOfType("claim");
		ws().recv({ type: "ack", id: first.id, ok: false, result: -1, text: "not commander" });
		expect($commander.get()).toBe(false);

		// The other tab has since closed; asking again now succeeds. Without this
		// the only cure was to hunt down the other window.
		const again = client.takeCommand();
		const second = lastOfType("claim");
		expect(second.id).not.toBe(first.id);
		ws().recv({ type: "ack", id: second.id, ok: true, result: 0, text: "commander" });
		await expect(again).resolves.toBe(true);
		expect($commander.get()).toBe(true);
	});

	it("resolves false — not throws — when authority is still held elsewhere", async () => {
		client.connect();
		ws().open();
		const p = client.takeCommand();
		const claim = lastOfType("claim");
		ws().recv({ type: "ack", id: claim.id, ok: false, result: -1, text: "not commander" });
		await expect(p).resolves.toBe(false);
	});

	it("learns from a rejected mission upload that it is not the commander", async () => {
		client.connect();
		ws().open();
		$commander.set(true);  // stale: granted at connect, lost since
		const p = client.pushMission([{ seq: 0, kind: "waypoint", lat: 1, lon: 2, alt: 50 }]);
		const push = lastOfType("mission_push");
		ws().recv({ type: "mission_ack", id: push.id, ok: false, result: -1, text: "not commander" });
		const ack = await p;
		expect(ack.ok).toBe(false);
		// The ack is the only place the loss shows up; mirroring it is what lets
		// the panel offer "Take command" instead of a bare "rejected".
		expect($commander.get()).toBe(false);
	});

	it("learns the same from a rejected fence upload", async () => {
		client.connect();
		ws().open();
		$commander.set(true);
		const p = client.pushFence([{ seq: 0, kind: "fence_inclusion", lat: 1, lon: 2 }]);
		const push = lastOfType("fence_push");
		ws().recv({ type: "fence_ack", id: push.id, ok: false, result: -1, text: "not commander" });
		await p;
		expect($commander.get()).toBe(false);
	});

	it("confirms authority from an accepted upload", async () => {
		client.connect();
		ws().open();
		$commander.set(null);
		const p = client.pushMission([{ seq: 0, kind: "waypoint", lat: 1, lon: 2, alt: 50 }]);
		const push = lastOfType("mission_push");
		ws().recv({ type: "mission_ack", id: push.id, ok: true, result: 0, text: "accepted" });
		await p;
		expect($commander.get()).toBe(true);
	});

	it("does not mistake an unrelated rejection for lost authority", async () => {
		client.connect();
		ws().open();
		$commander.set(true);
		const p = client.pushMission([{ seq: 0, kind: "waypoint", lat: 1, lon: 2, alt: 50 }]);
		const push = lastOfType("mission_push");
		// PX4 NAKed the plan itself. The console still holds command.
		ws().recv({ type: "mission_ack", id: push.id, ok: false, result: 3, text: "unsupported" });
		await p;
		expect($commander.get()).toBe(true);
	});
});
