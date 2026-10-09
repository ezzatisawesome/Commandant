import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A controllable stand-in for the browser WebSocket (same shape as
// telemetry.test.ts; kept local so the two files cannot perturb each other).
class FakeWS {
	static instances: FakeWS[] = [];
	static OPEN = 1; static CLOSED = 3; static CONNECTING = 0;
	readyState = 0;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) { FakeWS.instances.push(this); }
	send(s: string) { this.sent.push(s); }
	close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
	open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
	recv(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
	lastSent() { return JSON.parse(this.sent[this.sent.length - 1]); }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;

import { TelemetryClient } from "@/services/telemetry";

// Stream control was fire-and-forget: the request went out as `{type:"stream"}`,
// PX4's COMMAND_ACK matched nothing in gs, and the console learned nothing. A
// rate the autopilot refused looked exactly like one it took. These tests hold
// the acked shape in place on the client side.

let client: TelemetryClient;
beforeEach(() => {
	vi.useFakeTimers();
	FakeWS.instances = [];
	client = new TelemetryClient("ws://test:8790");
});
afterEach(() => { client.disconnect(); vi.useRealTimers(); });

const ws = () => FakeWS.instances[FakeWS.instances.length - 1];

describe("stream control goes out as a tracked command", () => {
	it("sends set_message_interval with an id, not a bare stream message", () => {
		client.connect(); ws().open();
		// Teardown closes the socket, which fails every in-flight command; this
		// test only cares about what went out, so swallow the rejection.
		client.setStream(30, 10).catch(() => {});
		const sent = ws().lastSent();
		expect(sent.type).toBe("command");
		expect(sent.name).toBe("set_message_interval");
		expect(sent.args).toMatchObject({ msgId: 30, hz: 10 });
		// An id is what lets gs route the ack back to this console.
		expect(typeof sent.id).toBe("string");
		expect(sent.id.length).toBeGreaterThan(0);
	});

	it("resolves with the autopilot's result", async () => {
		client.connect(); ws().open();
		const p = client.setStream(30, 10);
		const { id } = ws().lastSent();
		ws().recv({ type: "ack", id, ok: true, result: 0, text: "accepted" });
		await expect(p).resolves.toMatchObject({ ok: true, text: "accepted" });
	});

	it("reports a refusal as ok:false WITH the reason, rather than resolving silently", async () => {
		// The case the whole change exists for.
		client.connect(); ws().open();
		const p = client.setStream(375, 50);
		const { id } = ws().lastSent();
		ws().recv({ type: "ack", id, ok: false, result: 3, text: "unsupported" });
		await expect(p).resolves.toMatchObject({ ok: false, text: "unsupported" });
	});

	it("rejects on timeout and when there is no link", async () => {
		await expect(client.setStream(30, 10)).rejects.toThrow("not connected");
		client.connect(); ws().open();
		const p = client.setStream(30, 10);
		vi.advanceTimersByTime(5001);
		await expect(p).rejects.toThrow("timeout");
	});

	it("passes 0 through as the rate, leaving 'off' for gs to encode", () => {
		// The Hz -> microseconds mapping (0 -> -1) lives in gs's build_command,
		// in one place. The console must not grow a second opinion about it.
		client.connect(); ws().open();
		client.setStream(147, 0).catch(() => {});
		expect(ws().lastSent().args).toMatchObject({ msgId: 147, hz: 0 });
	});
});

describe("the panel says what happened", () => {
	const PANEL = readFileSync(
		join(__dirname, "..", "components", "flight", "CommandsPanel.tsx"), "utf8",
	);

	it("writes the outcome to the status log", () => {
		// Asked for and answered: a rate change is worth finding later, when the
		// strip looks wrong and you want to know what you did to it.
		expect(PANEL).toContain("pushStatus(");
		// Severity carries the verdict: 6 is info, 4 is a warning.
		expect(PANEL).toMatch(/pushStatus\(ack\.ok \? 6 : 4/);
	});

	it("shows the result inline and awaits it before clearing busy", () => {
		expect(PANEL).toContain("await telemetryClient.setStream(");
		expect(PANEL).toContain("setStreamStatus({ ok: ack.ok, text });");
		expect(PANEL).toContain("finally");
	});

	it("reports the ack's own text rather than assuming success", () => {
		expect(PANEL).toContain('ack.text || (ack.ok ? "accepted" : "rejected")');
	});

	it("gates Apply on authority, now that the rate change is a command", () => {
		// gs rejects a command from a non-commander, so an enabled button would
		// be a control that cannot work.
		expect(PANEL).toContain('const live = linkState === "alive" && commander !== false;');
		expect(PANEL).toContain("disabled={!live || streamBusy}");
	});
});
