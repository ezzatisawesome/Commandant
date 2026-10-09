import { JulianDate } from "cesium";
import { v4 as uuidv4 } from "uuid";

import type {
	AckMessage,
	CommandName,
	FenceAckMessage,
	FenceItem,
	FenceMessage,
	LinkState,
	MissionAckMessage,
	MissionItem,
	MissionMessage,
	ParamAckMessage,
	ParamValueMessage,
	RallyAckMessage,
	RallyItem,
	RallyMessage,
	ServerMessage,
	TelemetryFrame,
} from "@/types/app";
import { pushFrame } from "@/stores/aircraft.store";
import { $viewerStore } from "@/stores/cesium.store";
import { $linkState, $commander } from "@/stores/link.store";
import { pushStatus } from "@/stores/statustext.store";
import { upsertParam, upsertParams, setParamProgress, clearParams } from "@/stores/params.store";
import {
	$missionCurrent,
	$missionProgress,
	$missionReached,
	setMissionItems,
} from "@/stores/mission.store";
import { setFenceItems, setRallyItems } from "@/stores/geo.store";
import envs, { IS_VIEW } from "@/lib/envs";

// How long a command waits for its ack before we give up (gs retries internally
// a few times at ~1 s, so this is generous enough to cover that). When gs relays
// a MAV_RESULT_IN_PROGRESS (final:false), the wait re-arms to the longer value —
// gs itself allows 15 s for the final result.
const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_IN_PROGRESS_TIMEOUT_MS = 20000;

// Reconnect backoff: fast first retry, then grow (with jitter so a room full of
// tablets doesn't hammer the hub in lockstep), reset once a socket opens.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

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

// A mission upload is the multi-item MISSION_COUNT/REQUEST/ITEM/ACK handshake (gs
// retransmits on timeout), so give it the longest leash.
const MISSION_TIMEOUT_MS = 20000;

// One mission_push awaiting its mission_ack (matched by id).
interface PendingMission {
	resolve: (ack: MissionAckMessage) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// One fence_push / rally_push awaiting its ack (matched by id).
interface PendingGeo {
	resolve: (ack: FenceAckMessage | RallyAckMessage) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// WebSocket client for the gs daemon. Carries two directions over one socket:
//   gs -> console: `telemetry` frames, `ack` responses, `link` state changes
//   console -> gs: `command` requests, and a `claim` to be the commander
// Auto-reconnects; pushes each telemetry frame into the aircraft store and drives
// the Cesium clock. Mirrors the source->store flow used by services/Satellite.ts.
export class TelemetryClient {
	private ws: WebSocket | null = null;
	private closed = false;
	private reconnectTimer: number | null = null;
	private reconnectDelay = RECONNECT_MIN_MS;
	private hadSession = false;
	// Commands sent but not yet acked, keyed by command id.
	private pending = new Map<string, Pending>();
	// param_set requests awaiting their param_ack, keyed by id (separate channel
	// from commands so a slow param write can't collide with a command ack).
	private pendingParams = new Map<string, PendingParam>();
	// mission_push requests awaiting their mission_ack, keyed by id.
	private pendingMissions = new Map<string, PendingMission>();
	// fence_push / rally_push requests awaiting their ack, keyed by id.
	private pendingFence = new Map<string, PendingGeo>();
	private pendingRally = new Map<string, PendingGeo>();

	constructor(private url: string = envs.MAVLINK_WS_ENDPOINT) {}

	connect() {
		if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return; // idempotent (HMR / re-mount)
		this.closed = false;
		$linkState.set("connecting");
		this.open();
	}

	private open() {
		if (this.closed) return;
		$linkState.set("connecting");
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.url);
		} catch (err) {
			// A synchronous throw (bad URL, mixed-content block) must not end the
			// retry loop for good.
			console.warn("telemetry: cannot open socket", err);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			this.reconnectDelay = RECONNECT_MIN_MS;
			if (IS_VIEW) $commander.set(false); // watching, never commanding
			if (this.hadSession) {
				// Live-execution state from the previous socket is unknown now; the
				// plan/params the operator was editing are left alone.
				$missionCurrent.set(null);
				$missionReached.set(null);
				$missionProgress.set(null);
			}
			this.hadSession = true;
			// Bid to be the single active commander as soon as the socket is up, so
			// our commands are accepted (gs rejects non-commanders). Still
			// "connecting" until the first telemetry frame proves data is flowing.
			this.claim();
		};

		ws.onmessage = (event) => {
			if (typeof event.data !== "string") return; // binary: not ours
			let msg: ServerMessage;
			try {
				msg = JSON.parse(event.data) as ServerMessage;
			} catch {
				return; // ignore malformed frames
			}
			if (!msg || typeof msg !== "object") return;
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
			} else if (type === "params") {
				// gs coalesces streamed PARAM_VALUEs into batches (one store write each).
				const items = (msg as { items?: unknown }).items;
				if (Array.isArray(items)) {
					upsertParams((items as ParamValueMessage[]).map((p) => ({ name: p.name, value: p.value, ptype: p.ptype, index: p.index })));
				}
			} else if (type === "param") {
				const p = msg as ParamValueMessage;
				upsertParam({ name: p.name, value: p.value, ptype: p.ptype, index: p.index });
			} else if (type === "param_progress") {
				const p = msg as { received: number; count: number; done?: boolean; error?: string };
				setParamProgress(p.received, p.count, p.done, p.error);
			} else if (type === "param_ack") {
				this.resolveParamAck(msg as ParamAckMessage);
			} else if (type === "mission") {
				// Readback after a pull: replace the editable plan wholesale.
				setMissionItems((msg as MissionMessage).items);
				$missionProgress.set(null);
			} else if (type === "mission_progress") {
				const p = msg as { phase: "upload" | "download"; seq: number; count: number };
				$missionProgress.set({ phase: p.phase, seq: p.seq, count: p.count });
				if (p.count > 0 && p.seq + 1 >= p.count) $missionProgress.set(null);
			} else if (type === "mission_ack") {
				this.resolveMissionAck(msg as MissionAckMessage);
			} else if (type === "mission_current") {
				$missionCurrent.set((msg as { seq: number }).seq);
			} else if (type === "mission_reached") {
				$missionReached.set((msg as { seq: number }).seq);
			} else if (type === "fence") {
				setFenceItems((msg as FenceMessage).items);
			} else if (type === "rally") {
				setRallyItems((msg as RallyMessage).items);
			} else if (type === "fence_ack") {
				this.resolveGeoAck(this.pendingFence, msg as FenceAckMessage);
			} else if (type === "rally_ack") {
				this.resolveGeoAck(this.pendingRally, msg as RallyAckMessage);
			} else if (type === "telemetry" || type === undefined) {
				this.onTelemetry(msg as TelemetryFrame & { type?: string });
			} else {
				// A message type this build doesn't know (newer gs). Dropping it is the
				// only safe move: treating it as telemetry would blank the HUD and
				// wipe the trail.
				this.warnUnknown(type);
			}
		};

		ws.onclose = () => {
			if (this.ws !== ws) return; // a stale socket from before a reconnect
			// Only the console<->gs leg is down; the vehicle may be flying along fine.
			// Mark the link lost (HUD dot goes red) but keep the last frame, trail and
			// history on screen — wiping them on every WiFi blip was disorienting.
			$linkState.set("lost");
			$commander.set(null); // authority is unknown again until we re-claim
			this.failAllPending("link closed");
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			ws.close();
		};
	}

	private warned = new Set<string>();
	private warnUnknown(type: string) {
		if (this.warned.has(type)) return;
		this.warned.add(type);
		console.warn(`telemetry: ignoring unknown message type "${type}"`);
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
			if (IS_VIEW) {
				// send() drops outbound frames in the read-only build, so without
				// this the promise would never settle: the caller would sit on a
				// spinner for the full timeout and then report "timeout", which is
				// not what happened.
				reject(new Error("read-only view"));
				return;
			}
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
		if (ack.final === false) {
			// PX4 said IN_PROGRESS: the real verdict is still coming. Re-arm the
			// timeout for the long haul instead of resolving with a non-answer.
			p.timer = setTimeout(() => {
				this.pending.delete(ack.id);
				p.reject(new Error("timeout"));
			}, COMMAND_IN_PROGRESS_TIMEOUT_MS);
			return;
		}
		this.pending.delete(ack.id);
		p.resolve(ack);
	}

	/**
	 * Bid to be the single commander and confirm the outcome. gs replies with an
	 * AckMessage (text "commander" | "not commander") whose `ok` we mirror into
	 * $commander. If no reply arrives (older gs), $commander stays null and the UI
	 * treats authority optimistically. Fire-and-forget from the caller's view.
	 */
	private claim() {
		void this.takeCommand().catch(() => { /* no confirm — authority stays unknown */ });
	}

	/**
	 * Re-bid for command authority on demand, resolving true if this client now
	 * holds it.
	 *
	 * The automatic claim on connect is not enough on its own. gs grants authority
	 * to the FIRST claimer and holds it until that socket drops, so a second
	 * console tab, or a reload that raced the old socket's close, leaves this
	 * client permanently without it — and gs rejects every mission/fence upload
	 * and param write from a non-commander. Without a way to ask again, the only
	 * cure was to find and close the other tab, with nothing on screen saying so.
	 */
	takeCommand(): Promise<boolean> {
		return new Promise((resolve, reject) => {
			if (IS_VIEW) {
				// The hosted view has no route back to the hub by design.
				$commander.set(false);
				reject(new Error("read-only view"));
				return;
			}
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("not connected"));
				return;
			}
			const id = uuidv4();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("timeout"));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (ack) => {
					$commander.set(ack.ok);
					resolve(ack.ok);
				},
				reject,
				timer,
			});
			this.send({ type: "claim", id });
		});
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
			if (IS_VIEW) {
				// send() drops outbound frames in the read-only build, so without
				// this the promise would never settle: the caller would sit on a
				// spinner for the full timeout and then report "timeout", which is
				// not what happened.
				reject(new Error("read-only view"));
				return;
			}
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

	// --- missions (Phase 4) --------------------------------------------------

	/**
	 * Upload a mission and resolve with its mission_ack (matched by id). Like
	 * sendCommand, a gs/PX4-rejected mission resolves with ok:false; only transport
	 * failures / timeout reject. Re-uploading mid-flight is just another push.
	 */
	pushMission(items: MissionItem[]): Promise<MissionAckMessage> {
		return new Promise((resolve, reject) => {
			if (IS_VIEW) {
				// send() drops outbound frames in the read-only build, so without
				// this the promise would never settle: the caller would sit on a
				// spinner for the full mission timeout and then report "timeout",
				// which is not what happened.
				reject(new Error("read-only view"));
				return;
			}
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("not connected"));
				return;
			}
			const id = uuidv4();
			const timer = setTimeout(() => {
				this.pendingMissions.delete(id);
				reject(new Error("timeout"));
			}, MISSION_TIMEOUT_MS);
			this.pendingMissions.set(id, { resolve, reject, timer });
			this.send({ type: "mission_push", id, items });
		});
	}

	/** Download the vehicle's current mission; it arrives as a `mission` message. */
	pullMission() {
		this.send({ type: "mission_pull" });
	}

	/** Jump the active mission item (MISSION_SET_CURRENT). Fire-and-forget. */
	setCurrentMissionItem(seq: number) {
		this.send({ type: "mission_set_current", seq });
	}

	// gs rejects a write from a non-commander by NAME, and that reply is the only
	// place the loss of authority shows up — a claim granted at connect can be
	// stale by now. Mirroring it into $commander means the panels can say why an
	// upload failed and offer to take command, instead of reporting a bare
	// "rejected".
	private noteAuthority(ack: { ok: boolean; text?: string }) {
		if (!ack.ok && ack.text === "not commander") $commander.set(false);
		else if (ack.ok) $commander.set(true);
	}

	private resolveMissionAck(ack: MissionAckMessage) {
		this.noteAuthority(ack);
		const p = this.pendingMissions.get(ack.id);
		if (!p) return; // pull-side acks carry no id / unknown — ignore
		clearTimeout(p.timer);
		this.pendingMissions.delete(ack.id);
		p.resolve(ack);
	}

	// --- geofence + rally (Phase 4 extension) --------------------------------

	/** Upload a geofence and resolve with its fence_ack (matched by id). */
	pushFence(items: FenceItem[]): Promise<FenceAckMessage> {
		return this.pushGeo("fence_push", this.pendingFence, items) as Promise<FenceAckMessage>;
	}
	/** Download the vehicle's geofence; arrives as a `fence` message. */
	pullFence() {
		this.send({ type: "fence_pull" });
	}
	/** Upload rally points and resolve with its rally_ack (matched by id). */
	pushRally(items: RallyItem[]): Promise<RallyAckMessage> {
		return this.pushGeo("rally_push", this.pendingRally, items) as Promise<RallyAckMessage>;
	}
	/** Download the vehicle's rally points; arrives as a `rally` message. */
	pullRally() {
		this.send({ type: "rally_pull" });
	}

	// Shared fence/rally upload: same id-matched-ack handshake as pushMission.
	private pushGeo(
		type: "fence_push" | "rally_push",
		pending: Map<string, PendingGeo>,
		items: FenceItem[] | RallyItem[],
	): Promise<FenceAckMessage | RallyAckMessage> {
		return new Promise((resolve, reject) => {
			if (IS_VIEW) {
				// send() drops outbound frames in the read-only build, so without
				// this the promise would never settle: the caller would sit on a
				// spinner for the full mission timeout and then report "timeout",
				// which is not what happened.
				reject(new Error("read-only view"));
				return;
			}
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("not connected"));
				return;
			}
			const id = uuidv4();
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("timeout"));
			}, MISSION_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer });
			this.send({ type, id, items });
		});
	}

	private resolveGeoAck(pending: Map<string, PendingGeo>, ack: FenceAckMessage | RallyAckMessage) {
		this.noteAuthority(ack);
		const p = pending.get(ack.id);
		if (!p) return; // pull-side / unknown
		clearTimeout(p.timer);
		pending.delete(ack.id);
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
		for (const [, p] of this.pendingMissions) {
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		this.pendingMissions.clear();
		for (const m of [this.pendingFence, this.pendingRally]) {
			for (const [, p] of m) {
				clearTimeout(p.timer);
				p.reject(new Error(reason));
			}
			m.clear();
		}
	}

	// The single transmit chokepoint. In VIEW mode nothing leaves the browser,
	// so a hosted build cannot command even if a UI guard were missed or a
	// console user called a client method by hand. The relay also has no route
	// back to the hub, so this is belt and braces on top of the topology.
	private send(obj: unknown) {
		if (IS_VIEW) {
			if (process.env.NODE_ENV !== "production") {
				console.warn("telemetry: suppressed outbound message in view mode", obj);
			}
			return;
		}
		this.ws?.send(JSON.stringify(obj));
	}

	// --- lifecycle -----------------------------------------------------------

	private scheduleReconnect() {
		if (this.closed || this.reconnectTimer !== null) return;
		const delay = this.reconnectDelay * (0.8 + Math.random() * 0.4);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.open();
		}, delay);
	}

	disconnect() {
		this.closed = true;
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.failAllPending("disconnected");
		$linkState.set("lost");
		$commander.set(null);
		this.ws?.close();
		this.ws = null;
	}
}

// Shared singleton: Aircraft.tsx owns its connect/disconnect lifecycle, and the
// command controls (CommandBar) send over the same socket. Pinned on globalThis
// so a dev hot-reload of this module reuses the live socket instead of leaving
// the panels holding a fresh, unconnected client.
const g = globalThis as { __telemetryClient?: TelemetryClient };
export const telemetryClient: TelemetryClient = g.__telemetryClient ?? (g.__telemetryClient = new TelemetryClient());
