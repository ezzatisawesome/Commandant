import type { TelemetryFrame } from "@/types/app";
import { pushFrame, clearTrail } from "@/stores/aircraft.store";
import envs from "@/lib/envs";

// WebSocket client for the MAVLink->WS bridge. Auto-reconnects; pushes each
// decoded frame into the aircraft store. Mirrors the source->store flow used by
// services/Satellite.ts.
export class TelemetryClient {
	private ws: WebSocket | null = null;
	private closed = false;
	private reconnectTimer: number | null = null;

	constructor(private url: string = envs.MAVLINK_WS_ENDPOINT) {}

	connect() {
		this.closed = false;
		clearTrail(); // start each session with a clean flight path
		this.open();
	}

	private open() {
		if (this.closed) return;
		const ws = new WebSocket(this.url);
		this.ws = ws;

		ws.onmessage = (event) => {
			try {
				const frame = JSON.parse(event.data) as TelemetryFrame;
				pushFrame(frame);
			} catch {
				// ignore malformed frames
			}
		};

		ws.onclose = () => {
			pushFrame({ t: Date.now(), connected: false });
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			ws.close();
		};
	}

	private scheduleReconnect() {
		if (this.closed || this.reconnectTimer !== null) return;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.open();
		}, 1500);
	}

	disconnect() {
		this.closed = true;
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
	}
}
