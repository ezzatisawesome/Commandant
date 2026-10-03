"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import { $aircraftStore } from "@/stores/aircraft.store";
import { $linkState } from "@/stores/link.store";
import { telemetryClient } from "@/services/telemetry";
import type { CommandName } from "@/types/app";
import { Button } from "@/components/ui/button";

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
export function CommandBar() {
	const f = useStore($aircraftStore);
	const linkState = useStore($linkState);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
	const [takeoffAlt, setTakeoffAlt] = useState(30);

	const live = linkState === "alive";
	const armed = f?.armed ?? false;

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
			<div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Command</div>

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
				{MODES.map((m) => (
					<Button
						key={m.label}
						variant="outline"
						size="sm"
						disabled={!live || busy}
						onClick={() => run("set_mode", { main: m.main, sub: m.sub })}
						className="px-0 text-[10px]"
						title={`Set mode ${m.label}`}
					>
						{m.label}
					</Button>
				))}
			</div>

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
