import { JulianDate } from "cesium";
import { v4 as uuidv4 } from "uuid";

import type {
	AckMessage,
	CommandName,
	LinkState,
	ParamAckMessage,
	ParamValueMessage,
	ServerMessage,
	TelemetryFrame,
} from "@/types/app";
import { pushFrame, clearTrail } from "@/stores/aircraft.store";
import { $viewerStore } from "@/stores/cesium.store";
import { $linkState } from "@/stores/link.store";
import { pushStatus } from "@/stores/statustext.store";
import { upsertParam, setParamProgress, clearParams } from "@/stores/params.store";
import envs from "@/lib/envs";

// How long a command waits for its ack before we give up (gs retries internally
// a few times at ~1 s, so this is generous enough to cover that).
const COMMAND_TIMEOUT_MS = 5000;

// One in-flight command awaiting its ack (matched by id).
interface Pending {
	resolve: (ack: AckMessage) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// One in-flight param_set awaiting its param_ack (matched by id).
interface PendingParam {
	resolve: (ack: ParamAckMessage) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// A full param download can be slow (hundreds of params, re-requested gaps), so
// give param_set a longer leash than a command.
const PARAM_TIMEOUT_MS = 8000;

// WebSocket client for the gs daemon. Carries two directions over one socket:
//   gs -> console: `telemetry` frames, `ack` responses, `link` state changes
//   console -> gs: `command` requests, and a `claim` to be the commander
// Auto-reconnects; pushes each telemetry frame into the aircraft store and drives
// the Cesium clock. Mirrors the source->store flow used by services/Satellite.ts.
export class TelemetryClient {
	private ws: WebSocket | null = null;
	private closed = false;
	private reconnectTimer: number | null = null;
	// Commands sent but not yet acked, keyed by command id.
	private pending = new Map<string, Pending>();
	// param_set requests awaiting their param_ack, keyed by id (separate channel
	// from commands so a slow param write can't collide with a command ack).
	private pendingParams = new Map<string, PendingParam>();

	constructor(private url: string = envs.MAVLINK_WS_ENDPOINT) {}

	connect() {
		this.closed = false;
		clearTrail(); // start each session with a clean flight path
		$linkState.set("connecting");
		this.open();
	}

	private open() {
		if (this.closed) return;
		const ws = new WebSocket(this.url);
		this.ws = ws;

		ws.onopen = () => {
			// Bid to be the single active commander as soon as the socket is up, so
			// our commands are accepted (gs rejects non-commanders). Still
			// "connecting" until the first telemetry frame proves data is flowing.
			this.send({ type: "claim" });
		};

		ws.onmessage = (event) => {
			let msg: ServerMessage;
			try {
				msg = JSON.parse(event.data) as ServerMessage;
			} catch {
				return; // ignore malformed frames
			}
			// Discriminate on `type`. A message with no `type` is treated as a
			// telemetry frame for back-compat with the pre-envelope bridge.
			const type = (msg as { type?: string }).type;
			if (type === "ack") {
				this.resolveAck(msg as AckMessage);
			} else if (type === "link") {
				$linkState.set((msg as { state: LinkState }).state);
			} else if (type === "statustext") {
				const s = msg as { severity: number; text: string; t: number };
				pushStatus(s.severity, s.text, s.t);
			} else if (type === "param") {
				const p = msg as ParamValueMessage;
				upsertParam({ name: p.name, value: p.value, ptype: p.ptype, index: p.index });
				setParamProgress(p.index + 1, p.count);
			} else if (type === "param_progress") {
				const p = msg as { received: number; count: number };
				setParamProgress(p.received, p.count);
			} else if (type === "param_ack") {
				this.resolveParamAck(msg as ParamAckMessage);
			} else {
				this.onTelemetry(msg as TelemetryFrame & { type?: string });
			}
		};

		ws.onclose = () => {
			$linkState.set("lost");
			pushFrame({ t: Date.now(), connected: false });
			this.failAllPending("link closed");
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			ws.close();
		};
	}

	// A telemetry frame: strip the envelope `type`, update link state, push to the
	// store, and drive the Cesium clock from the sim's simulated instant.
	private onTelemetry(msg: TelemetryFrame & { type?: string }) {
		const { type: _type, ...frame } = msg;
		void _type;
		// Prefer the daemon's explicit linkState; fall back to `connected` for the
		// pre-link-manager bridge.
		$linkState.set(frame.linkState ?? (frame.connected ? "alive" : "stale"));
		pushFrame(frame as TelemetryFrame);

		if (frame.sunEpochMs !== undefined) {
			const viewer = $viewerStore.get();
			if (viewer && !viewer.isDestroyed()) {
				viewer.clock.currentTime = JulianDate.fromDate(new Date(frame.sunEpochMs));
				// Fade the ground atmosphere with the sun so the blue haze stays in
				// daylight but night is dark even when zoomed in: full brightness by
				// ~200 W/m^2, -> -1 (dark) at 0.
				if (frame.irradiance !== undefined) {
					viewer.scene.globe.atmosphereBrightnessShift =
						Math.min(0, frame.irradiance / 200 - 1);
				}
			}
		}
	}

	// --- commanding ----------------------------------------------------------

	/**
	 * Send a command and resolve with its ack (matched by id). Rejects on timeout
	 * or if the socket isn't open. The returned ack carries `ok`/`text`, so a
	 * rejected command (e.g. "not commander") resolves with ok:false rather than
	 * throwing — only transport failures reject.
	 */
	sendCommand(name: CommandName, args: Record<string, unknown> = {}): Promise<AckMessage> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("not connected"));
				return;
			}
			const id = uuidv4();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("timeout"));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ type: "command", id, name, args });
		});
	}

	private resolveAck(ack: AckMessage) {
		const p = this.pending.get(ack.id);
		if (!p) return; // unknown/duplicate ack
		clearTimeout(p.timer);
		this.pending.delete(ack.id);
		p.resolve(ack);
	}

	// --- parameters (Phase 2) ------------------------------------------------

	/** Request the full PX4 parameter list; results stream into the params store. */
	refreshParams() {
		clearParams();
		this.send({ type: "param_refresh" });
	}

	/**
	 * Write one parameter and resolve with its param_ack (matched by id). Like
	 * sendCommand, a gs-rejected write resolves with ok:false; only transport
	 * failures / timeout reject.
	 */
	setParam(name: string, value: number, ptype?: number): Promise<ParamAckMessage> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("not connected"));
				return;
			}
			const id = uuidv4();
			const timer = setTimeout(() => {
				this.pendingParams.delete(id);
				reject(new Error("timeout"));
			}, PARAM_TIMEOUT_MS);
			this.pendingParams.set(id, { resolve, reject, timer });
			this.send({ type: "param_set", id, name, value, ptype });
		});
	}

	/** Enable/disable a MAVLink stream at a rate (hz=0 disables). Fire-and-forget. */
	setStream(msgId: number, hz: number) {
		this.send({ type: "stream", msgId, hz });
	}

	private resolveParamAck(ack: ParamAckMessage) {
		const p = this.pendingParams.get(ack.id);
		if (!p) return;
		clearTimeout(p.timer);
		this.pendingParams.delete(ack.id);
		p.resolve(ack);
	}

	private failAllPending(reason: string) {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		this.pending.clear();
		for (const [, p] of this.pendingParams) {
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		this.pendingParams.clear();
	}

	private send(obj: unknown) {
		this.ws?.send(JSON.stringify(obj));
	}

	// --- lifecycle -----------------------------------------------------------

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
		this.failAllPending("disconnected");
		$linkState.set("lost");
		this.ws?.close();
		this.ws = null;
	}
}

// Shared singleton: Aircraft.tsx owns its connect/disconnect lifecycle, and the
// command controls (CommandBar) send over the same socket.
export const telemetryClient = new TelemetryClient();
