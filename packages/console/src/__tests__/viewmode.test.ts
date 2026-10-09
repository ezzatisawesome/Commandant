import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The hosted build must be read-only by construction. These tests force VIEW
// mode and assert the client transmits NOTHING, no matter what is called on it.
vi.mock("@/lib/envs", () => ({
	IS_VIEW: true,
	MODE: "view",
	default: { MAVLINK_WS_ENDPOINT: "ws://relay.test/watch", CESIUM_KEY: "", PROD: false },
}));

class FakeWS {
	static instances: FakeWS[] = [];
	static OPEN = 1; static CLOSED = 3;
	readyState = 1;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) { FakeWS.instances.push(this); }
	send(s: string) { this.sent.push(s); }
	close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
	open() { this.onopen?.(); }
	recv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;

import { TelemetryClient } from "@/services/telemetry";
import { $aircraftStore } from "@/stores/aircraft.store";
import { $commander } from "@/stores/link.store";

let client: TelemetryClient;
beforeEach(() => {
	vi.useFakeTimers();
	FakeWS.instances = [];
	client = new TelemetryClient("ws://relay.test/watch");
});
afterEach(() => { client.disconnect(); vi.useRealTimers(); });
const ws = () => FakeWS.instances[FakeWS.instances.length - 1];

describe("view mode is read-only by construction", () => {
	it("sends nothing on connect — not even a claim", () => {
		client.connect();
		ws().open();
		expect(ws().sent).toEqual([]);
		expect($commander.get()).toBe(false);
	});

	it("every outbound method is suppressed", async () => {
		client.connect();
		ws().open();
		const attempts = [
			client.sendCommand("arm"),
			client.sendCommand("disarm"),
			client.sendCommand("takeoff", { alt: 50 }),
			client.setParam("NAV_RCL_ACT", 0, 6),
			client.pushMission([]),
			client.pushFence([]),
			client.pushRally([]),
			client.takeCommand(),
		];
		client.refreshParams();
		client.pullMission();
		client.setCurrentMissionItem(2);
		client.setStream(30, 10);
		expect(ws().sent).toEqual([]);
		// The promise-returning ones must settle IMMEDIATELY, not hang until a
		// timeout. send() drops the frame in view mode, so a push that waits for
		// an ack that can never come left the caller on a spinner for the full
		// 20 s mission timeout and then reported "timeout" — which is not what
		// happened, and is the wrong thing to show an operator.
		const settled = await Promise.allSettled(attempts);
		expect(settled.every((s) => s.status === "rejected")).toBe(true);
		for (const s of settled) {
			if (s.status === "rejected") expect(String(s.reason)).toContain("read-only view");
		}
	});

	it("still receives and renders telemetry normally", () => {
		client.connect();
		ws().open();
		ws().recv({ type: "telemetry", t: 1, connected: true, linkState: "alive", lat: 37.4, lon: -122.1, alt: 90 });
		expect($aircraftStore.get()?.lat).toBe(37.4);
		expect(ws().sent).toEqual([]);
	});
});
