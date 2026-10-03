import { JulianDate } from "cesium";

import type { TelemetryFrame } from "@/types/app";
import { pushFrame, clearTrail } from "@/stores/aircraft.store";
import { $viewerStore } from "@/stores/cesium.store";
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
				// Drive the Cesium clock from the sim's simulated instant, so the
				// globe's day/night terminator tracks the simulated time-of-day
				// (globe lighting is enabled in Globe.tsx).
				if (frame.sunEpochMs !== undefined) {
					const viewer = $viewerStore.get();
					if (viewer && !viewer.isDestroyed()) {
						viewer.clock.currentTime = JulianDate.fromDate(new Date(frame.sunEpochMs));
						// Fade the ground atmosphere with the sun so the blue haze
						// stays in daylight but night is dark even when zoomed in:
						// full brightness by ~200 W/m^2, -> -1 (dark) at 0.
						if (frame.irradiance !== undefined) {
							viewer.scene.globe.atmosphereBrightnessShift =
								Math.min(0, frame.irradiance / 200 - 1);
						}
					}
				}
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
