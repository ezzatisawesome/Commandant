"use client";

import { useState } from "react";
import { useStore } from "@nanostores/react";

import { Button } from "@/components/ui/button";
import { telemetryClient } from "@/services/telemetry";
import { $commandToken, $tokenRequired, setCommandToken } from "@/stores/token.store";

// Shown only when gs has refused this console's claim for want of the hub's
// token. Everything else about the page keeps working: telemetry is not gated,
// because someone watching the aircraft fly is what the hub is for. What needs
// a secret is arming one.
//
// The token is typed here rather than served with the page. A token the page
// handed out would be a token that anyone who loaded the page already has,
// which is the attack it exists to stop.
export default function TokenPrompt() {
	const needed = useStore($tokenRequired);
	const current = useStore($commandToken);
	const [draft, setDraft] = useState("");
	const [status, setStatus] = useState<string | null>(null);

	if (!needed) return null;

	async function submit() {
		setCommandToken(draft);
		setStatus("trying…");
		try {
			const ok = await telemetryClient.takeCommand();
			setStatus(ok ? null : "the hub refused that token");
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "failed");
		}
	}

	return (
		<div className="fixed left-1/2 top-16 z-[60] w-[22rem] -translate-x-1/2 rounded-md
			border border-amber-400/40 bg-black/85 p-3 text-[11px] backdrop-blur">
			<div className="font-semibold text-amber-300">This hub requires a command token</div>
			<div className="pt-1 text-white/60">
				Telemetry is live and will keep updating. Commands, parameter writes
				and plan uploads need the token set on the hub.
			</div>
			<div className="flex items-center gap-2 pt-2">
				<input
					type="password"
					autoComplete="off"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
					placeholder={current ? "the saved token was refused" : "command token"}
					className="h-7 flex-1 rounded border border-white/15 bg-transparent px-2 text-white"
				/>
				<Button size="sm" variant="outline" onClick={() => void submit()}
					className="h-7 px-2 text-[10px]">
					Take command
				</Button>
			</div>
			{status ? <div className="pt-1 text-red-400">{status}</div> : null}
			<div className="pt-2 text-[9px] text-white/35">
				Run <span className="font-mono">commandant status</span> on the hub to
				confirm a token is required. It is remembered on this device only.
			</div>
		</div>
	);
}
