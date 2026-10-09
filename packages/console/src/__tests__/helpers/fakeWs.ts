// A minimal WebSocket stand-in for the telemetry client's tests: records what
// was sent, and lets a test drive onopen/onmessage/onclose by hand.
export class FakeWS {
	static instances: FakeWS[] = [];
	static OPEN = 1;
	static CLOSED = 3;
	readyState = 1;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(public url: string) {
		FakeWS.instances.push(this);
	}

	send(s: string) { this.sent.push(s); }
	close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
	open() { this.onopen?.(); }
	recv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
