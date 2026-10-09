"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";
import { computed } from "nanostores";

import { $hudFrame } from "@/stores/aircraft.store";
import { $linkState, $commander } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import type { CommandName } from "@/types/app";
import { Button } from "@/components/ui/button";
import { $missionItems } from "@/stores/mission.store";
import { $params } from "@/stores/params.store";
import { TKO_LAND_REQ_PARAM, missionRejectionReason } from "@/lib/missionCheck";

// PX4 custom_mode main/sub pairs for the modes we expose. Mirrors the decode in
// gs/bridge.py (and AircraftSim's mavlink_io). sub is only meaningful for AUTO(4).
const MODES: Array<{ label: string; main: number; sub: number }> = [
	{ label: "HOLD", main: 4, sub: 3 }, // AUTO.LOITER
	{ label: "MISSION", main: 4, sub: 4 }, // AUTO.MISSION
	{ label: "POSCTL", main: 3, sub: 0 },
	{ label: "MANUAL", main: 1, sub: 0 },
];

// Phase-1 command surface over the WS command channel: arm/disarm, the nav verbs
// (takeoff/land/RTL), and mode set. Everything is disabled unless the link is
// alive; each command's ack result (or failure) is surfaced inline. "Fly to here"
// is a globe double-click, handled in Aircraft.tsx.
// The only telemetry this panel needs is the arm state; a derived store means it
// re-renders on arm/disarm, not on every frame.
const $armed = computed($hudFrame, (f) => f?.armed ?? false);

export function CommandBar() {
	const armed = useStore($armed);
	const linkState = useStore($linkState);
	const commander = useStore($commander);
	const missionItems = useStore($missionItems);
	const params = useStore($params);
	const [busy, setBusy] = useState(false);
	const [claiming, setClaiming] = useState(false);
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [takeoffAlt, setTakeoffAlt] = useState(30);

	// Another GCS explicitly holds command authority: block sends (gs would reject
	// them anyway). null/true = we have (or optimistically assume) control.
	const notCommander = commander === false;
	// MISSION is the button that RUNS a plan, and PX4 refuses it for a plan that
	// does not meet its requirements — accepting the command and staying in the
	// mode it was in. Warn on the button rather than let that look like a dead
	// control.
	const missionWontRun = missionRejectionReason(missionItems, params[TKO_LAND_REQ_PARAM]?.value);
	const live = linkState === "alive" && !notCommander;

	// Re-bid for authority. gs grants it to the first claimer and holds it until
	// that socket drops, and the console only claimed in ws.onopen — so without
	// this the cure for a latched badge was to find and close the other tab, or
	// reload and hope the race went the other way.
	async function takeCommand() {
		setClaiming(true);
		setStatus(null);
		try {
			const ok = await telemetryClient.takeCommand();
			setStatus({ ok, text: ok ? "command taken" : "another GCS still holds command" });
		} catch (err) {
			setStatus({ ok: false, text: err instanceof Error ? err.message : "failed" });
		} finally {
			setClaiming(false);
		}
	}

	async function run(name: CommandName, args: Record<string, unknown> = {}) {
		setBusy(true);
		setStatus(null);
		try {
			const ack = await telemetryClient.sendCommand(name, args);
			setStatus({ ok: ack.ok, text: ack.text || (ack.ok ? "accepted" : "rejected") });
		} catch (err) {
			setStatus({ ok: false, text: err instanceof Error ? err.message : "failed" });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-2 border-t border-white/10 pt-2">
			<div className="mb-1 flex items-center justify-between">
				<span className="text-[10px] uppercase tracking-wide text-white/40">Command</span>
				{/* Authority badge: only shown once gs confirms the claim outcome. */}
				{commander === true ? (
					<span className="text-[9px] font-semibold text-emerald-400" title="This console holds command authority">
						● IN CONTROL
					</span>
				) : commander === false ? (
					// This badge latches: gs answers a claim once, at connect, and
					// releases authority silently when the holder's socket drops. So a
					// console refused at startup goes on saying this long after the
					// other tab has closed — with every command disabled and no way
					// back. The button re-asks.
					<span className="flex items-center gap-1.5">
						<span className="text-[9px] font-semibold text-amber-400" title="Another GCS holds command authority; commands are disabled. It may also have since disconnected — ask again.">
							● ANOTHER GCS IN CONTROL
						</span>
						<button
							onClick={takeCommand}
							disabled={claiming}
							className="rounded border border-amber-400/40 px-1 text-[9px] font-semibold text-amber-300 hover:bg-amber-400/10 disabled:opacity-40"
							title="Ask gs to hand command authority to this console"
						>
							{claiming ? "…" : "Take"}
						</button>
					</span>
				) : null}
			</div>

			<Button
				variant={armed ? "destructive" : "default"}
				size="sm"
				disabled={!live || busy}
				onClick={() => run(armed ? "disarm" : "arm", { force: false })}
				className="w-full"
			>
				{armed ? "Disarm" : "Arm"}
			</Button>

			{/* Nav verbs. Takeoff carries the altitude from the inline field. */}
			<div className="mt-1 flex items-center gap-1">
				<Button
					variant="outline"
					size="sm"
					disabled={!live || busy}
					onClick={() => run("takeoff", { alt: takeoffAlt })}
					className="flex-1 px-0 text-[10px]"
					title={`Auto takeoff to ${takeoffAlt} m`}
				>
					Takeoff
				</Button>
				<input
					type="number"
					value={takeoffAlt}
					min={5}
					max={500}
					onChange={(e) => setTakeoffAlt(Number(e.target.value) || 0)}
					className="h-8 w-12 rounded-md border border-white/15 bg-transparent px-1 text-right font-mono text-[10px] text-white"
					title="Takeoff altitude (m)"
				/>
				<span className="text-[10px] text-white/40">m</span>
			</div>
			<div className="mt-1 grid grid-cols-2 gap-1">
				<Button variant="outline" size="sm" disabled={!live || busy}
					onClick={() => run("land")} className="px-0 text-[10px]" title="Auto land">
					Land
				</Button>
				<Button variant="outline" size="sm" disabled={!live || busy}
					onClick={() => run("rtl")} className="px-0 text-[10px]" title="Return to launch">
					RTL
				</Button>
			</div>

			{/* Mode set. */}
			<div className="mt-1 grid grid-cols-4 gap-1">
				{MODES.map((m) => {
					// Only MISSION depends on the plan being flyable; the others are
					// unconditional mode changes.
					const warn = m.label === "MISSION" ? missionWontRun : null;
					return (
						<Button
							key={m.label}
							variant="outline"
							size="sm"
							disabled={!live || busy}
							onClick={() => run("set_mode", { main: m.main, sub: m.sub })}
							className={`px-0 text-[10px] ${warn ? "border-amber-400/50 text-amber-300" : ""}`}
							title={warn ?? `Set mode ${m.label}`}
						>
							{m.label}
						</Button>
					);
				})}
			</div>

			{/* Why MISSION will not take, in words, next to the button that does
			    not take. PX4 announces this only via STATUSTEXT, at the moment of
			    refusal, which is the easiest thing on screen to miss. */}
			{missionWontRun ? (
				<div className="mt-1 text-[9px] leading-relaxed text-amber-300/80">
					⚠ {missionWontRun}
				</div>
			) : null}

			<div className="mt-1 text-[9px] text-white/30">Double-click the globe to fly there</div>

			{status ? (
				<div
					className={`mt-1 truncate text-[10px] ${status.ok ? "text-emerald-400" : "text-red-400"}`}
					title={status.text}
				>
					{status.ok ? "✓" : "✗"} {status.text}
				</div>
			) : null}
		</div>
	);
}
