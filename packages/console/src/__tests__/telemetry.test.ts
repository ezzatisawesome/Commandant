import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A controllable stand-in for the browser WebSocket.
class FakeWS {
	static instances: FakeWS[] = [];
	static throwOnConstruct = false;
	static OPEN = 1; static CLOSED = 3; static CONNECTING = 0;
	readyState = 0;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		if (FakeWS.throwOnConstruct) throw new Error("SecurityError");
		FakeWS.instances.push(this);
	}
	send(s: string) { this.sent.push(s); }
	close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
	// test helpers
	open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
	recv(obj: unknown) { this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
	lastSent() { return JSON.parse(this.sent[this.sent.length - 1]); }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;

import { TelemetryClient } from "@/services/telemetry";
import { $aircraftStore, $trailStore, pushFrame } from "@/stores/aircraft.store";
import { $linkState, $commander } from "@/stores/link.store";
import { $params } from "@/stores/params.store";
import { $missionCurrent, $missionProgress, $missionReached } from "@/stores/mission.store";
import { $statusTexts, clearStatus } from "@/stores/statustext.store";

let client: TelemetryClient;
beforeEach(() => {
	vi.useFakeTimers();
	FakeWS.instances = [];
	FakeWS.throwOnConstruct = false;
	$aircraftStore.set(null); $trailStore.set([]); $params.set({});
	$missionCurrent.set(null); $missionReached.set(null); $missionProgress.set(null);
	clearStatus();
	client = new TelemetryClient("ws://test:8790");
});
afterEach(() => { client.disconnect(); vi.useRealTimers(); });

const ws = () => FakeWS.instances[FakeWS.instances.length - 1];

describe("message routing", () => {
	it("routes telemetry (typed and legacy untyped) to the store, and claims on open", () => {
		client.connect();
		expect($linkState.get()).toBe("connecting");
		ws().open();
		expect(ws().lastSent().type).toBe("claim");
		ws().recv({ type: "telemetry", t: 1, connected: true, linkState: "alive", lat: 1, lon: 2, alt: 3 });
		expect($aircraftStore.get()?.lat).toBe(1);
		expect($linkState.get()).toBe("alive");
		ws().recv({ t: 2, connected: true, lat: 5, lon: 2, alt: 3 });
		expect($aircraftStore.get()?.lat).toBe(5);
	});
	it("drops unknown message types instead of treating them as telemetry", () => {
		client.connect(); ws().open();
		ws().recv({ type: "telemetry", t: 1, connected: true, linkState: "alive", lat: 1, lon: 2, alt: 3 });
		ws().recv({ type: "pong" });
		expect($aircraftStore.get()?.lat).toBe(1);
		expect($linkState.get()).toBe("alive");
	});
	it("survives junk: non-string data, null JSON, arrays", () => {
		client.connect(); ws().open();
		expect(() => {
			ws().onmessage?.({ data: new Blob() });
			ws().recv("null");
			ws().recv("42");
			ws().recv("[1,2]");
			ws().recv("{not json");
		}).not.toThrow();
	});
	it("writes a `params` batch into the store in one go and ignores a malformed one", () => {
		client.connect(); ws().open();
		let n = 0; const unsub = $params.listen(() => n++);
		ws().recv({ type: "params", items: [{ name: "A", value: 1, ptype: 9, index: 0, count: 2 }, { name: "B", value: 2, ptype: 6, index: 1, count: 2 }] });
		ws().recv({ type: "params" });
		unsub();
		expect(n).toBe(1);
		expect($params.get().B.value).toBe(2);
	});
});

describe("command acks", () => {
	it("resolves on the matching id and ignores strangers", async () => {
		client.connect(); ws().open();
		const p = client.sendCommand("arm");
		const { id } = ws().lastSent();
		ws().recv({ type: "ack", id: "someone-else", ok: true, result: 0, text: "accepted" });
		ws().recv({ type: "ack", id, ok: true, result: 0, text: "accepted" });
		await expect(p).resolves.toMatchObject({ ok: true });
	});
	it("rejects with timeout after 5 s, but an interim in-progress ack re-arms to 20 s", async () => {
		client.connect(); ws().open();
		const p1 = client.sendCommand("takeoff");
		vi.advanceTimersByTime(5001);
		await expect(p1).rejects.toThrow("timeout");

		const p2 = client.sendCommand("takeoff");
		const { id } = ws().lastSent();
		vi.advanceTimersByTime(4000);
		ws().recv({ type: "ack", id, ok: true, result: 5, text: "in progress", final: false });
		vi.advanceTimersByTime(10_000); // well past the original 5 s
		ws().recv({ type: "ack", id, ok: true, result: 0, text: "accepted" });
		await expect(p2).resolves.toMatchObject({ result: 0 });
	});
	it("rejects when not connected and fails all pending on close", async () => {
		await expect(client.sendCommand("arm")).rejects.toThrow("not connected");
		client.connect(); ws().open();
		const p = client.sendCommand("arm");
		ws().close();
		await expect(p).rejects.toThrow("link closed");
	});
	it("mirrors the claim verdict into $commander", () => {
		client.connect(); ws().open();
		const { id } = ws().lastSent();
		ws().recv({ type: "ack", id, ok: false, result: -1, text: "not commander" });
		expect($commander.get()).toBe(false);
	});
});

describe("reconnect", () => {
	it("backs off with growth and keeps the trail on a socket drop", () => {
		client.connect(); ws().open();
		ws().recv({ type: "telemetry", t: 1, connected: true, linkState: "alive", lat: 1, lon: 2, alt: 3 });
		ws().recv({ type: "telemetry", t: 2, connected: true, linkState: "alive", lat: 1.001, lon: 2, alt: 3 });
		const trailLen = $trailStore.get().length;
		expect(trailLen).toBeGreaterThan(0);
		$missionCurrent.set(4);

		ws().close();
		expect($linkState.get()).toBe("lost");
		expect($trailStore.get().length).toBe(trailLen); // not wiped
		expect($aircraftStore.get()?.lat).toBe(1.001);    // last frame kept
		expect(FakeWS.instances).toHaveLength(1);
		vi.advanceTimersByTime(1300);                     // ≤ 1.2 s jittered first retry
		expect(FakeWS.instances).toHaveLength(2);
		ws().close();                                     // fails again: longer wait
		vi.advanceTimersByTime(1300);
		expect(FakeWS.instances).toHaveLength(2);
		vi.advanceTimersByTime(1500);
		expect(FakeWS.instances).toHaveLength(3);
		ws().open();                                      // live-execution state is reset on a new session
		expect($missionCurrent.get()).toBeNull();
	});
	it("keeps retrying when the WebSocket constructor throws", () => {
		FakeWS.throwOnConstruct = true;
		client.connect();
		expect(FakeWS.instances).toHaveLength(0);
		FakeWS.throwOnConstruct = false;
		vi.advanceTimersByTime(1300);
		expect(FakeWS.instances).toHaveLength(1);
	});
	it("connect() is idempotent while a socket is live", () => {
		client.connect(); client.connect();
		expect(FakeWS.instances).toHaveLength(1);
	});
	it("disconnect() stops the retry loop", () => {
		client.connect(); ws().close();
		client.disconnect();
		vi.advanceTimersByTime(60_000);
		expect(FakeWS.instances).toHaveLength(1);
	});
});

describe("pushFrame integration", () => {
	it("a frame missing a fix leaves the previous position for Cesium", () => {
		pushFrame({ t: 1, connected: true, lat: 1, lon: 2, alt: 3 });
		pushFrame({ t: 2, connected: true });
		expect($aircraftStore.get()?.lat).toBeUndefined(); // latest is latest; overlays hide
	});
});


describe("a vehicle reboot clears what it invalidates (gs fault H16)", () => {
	// On a bench or in HITL the autopilot restarts constantly — every restart,
	// every flash. Telemetry keeps flowing, so this is not a lost link, but PX4
	// reverts anything that was not saved: a cached param value can no longer be
	// vouched for, and showing it tells the operator an edit was applied when the
	// vehicle has dropped it.
	const reboot = (over = {}) =>
		({ type: "vehicle_reboot", bootMs: 120, t: 1_700_000_000_000, aborted: [], ...over });

	it("drops the param cache", () => {
		client.connect(); ws().open();
		ws().recv({ type: "params", items: [{ name: "FW_AIRSPD_TRIM", value: 15, ptype: 9, index: 3 }] });
		expect(Object.keys($params.get())).toHaveLength(1);
		ws().recv(reboot());
		expect($params.get()).toEqual({});
	});

	it("says so in the log the operator is already reading", () => {
		client.connect(); ws().open();
		ws().recv(reboot());
		const texts = $statusTexts.get().map((e) => e.text);
		expect(texts.some((t) => /rebooted/i.test(t))).toBe(true);
		expect(texts.some((t) => /re-read/i.test(t))).toBe(true);
	});

	it("clears mission execution state, which belongs to the run that ended", () => {
		client.connect(); ws().open();
		ws().recv({ type: "mission_current", seq: 4 });
		ws().recv({ type: "mission_reached", seq: 3 });
		expect($missionCurrent.get()).toBe(4);
		ws().recv(reboot());
		expect($missionCurrent.get()).toBeNull();
		expect($missionReached.get()).toBeNull();
		expect($missionProgress.get()).toBeNull();
	});

	it("is not treated as telemetry, and does not blank the HUD", () => {
		client.connect(); ws().open();
		ws().recv({ type: "telemetry", t: 1, connected: true, lat: 37.4, lon: -122.1, alt: 100 });
		expect($aircraftStore.get()?.lat).toBe(37.4);
		ws().recv(reboot());
		expect($aircraftStore.get()?.lat).toBe(37.4);
		expect($linkState.get()).not.toBe("lost");
	});
});

describe("command authority can actually be taken (gs fault H20)", () => {
	// The hub's premise is "join the WiFi, open the page", so several people do,
	// and the first to load held command until its socket dropped. A phone in a
	// pocket with the page open keeps answering gs's 5 s pings, so its socket
	// never drops and the pilot at the laptop could not get authority.
	it("bids without forcing on connect, so a page load cannot steal command", () => {
		client.connect();
		ws().open();
		const claim = ws().lastSent();
		expect(claim.type).toBe("claim");
		expect(claim.force).toBeUndefined();
	});

	it("forces only when the operator pressed Take command", () => {
		client.connect();
		ws().open();
		void client.takeCommand();
		const claim = ws().lastSent();
		expect(claim.type).toBe("claim");
		expect(claim.force).toBe(true);
	});

	it("greys out when told another console took over", () => {
		client.connect();
		ws().open();
		ws().recv({ type: "ack", id: JSON.parse(ws().sent[0]).id, ok: true, result: 0, text: "commander" });
		expect($commander.get()).toBe(true);
		ws().recv({ type: "commander", held: false, text: "another console took command" });
		expect($commander.get()).toBe(false);
		expect($statusTexts.get().some((e) => /took command/.test(e.text))).toBe(true);
	});

	it("a commander notice is not treated as telemetry", () => {
		client.connect();
		ws().open();
		ws().recv({ type: "telemetry", t: 1, connected: true, lat: 37.4, lon: -122.1, alt: 100 });
		ws().recv({ type: "commander", held: false });
		expect($aircraftStore.get()?.lat).toBe(37.4);
	});
});


describe("stream control is a write to the vehicle, not a display preference (gs fault H22)", () => {
	// It sends SET_MESSAGE_INTERVAL, which changes what the vehicle transmits,
	// for every client, out of a finite link budget — so gs gates it on command
	// authority and may clamp the rate. Sent fire-and-forget, a refusal or a
	// clamp was invisible and the operator just saw nothing happen.
	it("carries an id so the outcome comes back", () => {
		client.connect(); ws().open();
		void client.setStream(375, 25);
		const sent = ws().lastSent();
		expect(sent.type).toBe("stream");
		expect(typeof sent.id).toBe("string");
		expect(sent.msgId).toBe(375);
		expect(sent.hz).toBe(25);
	});

	it("surfaces a refusal from a console that does not hold command", async () => {
		client.connect(); ws().open();
		const p = client.setStream(375, 25);
		const id = ws().lastSent().id;
		ws().recv({ type: "ack", id, ok: false, result: -1, text: "not commander" });
		await expect(p).resolves.toMatchObject({ ok: false, text: "not commander" });
	});

	it("surfaces a rate clamped to the link budget", async () => {
		client.connect(); ws().open();
		const p = client.setStream(375, 50);
		const id = ws().lastSent().id;
		ws().recv({ type: "ack", id, ok: true, result: 0, text: "capped at 1.9 Hz" });
		await expect(p).resolves.toMatchObject({ ok: true, text: "capped at 1.9 Hz" });
	});
});
