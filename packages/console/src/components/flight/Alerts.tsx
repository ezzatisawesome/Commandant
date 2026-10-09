"use client";

import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { AlertTriangle, X } from "lucide-react";

import { $statusTexts } from "@/stores/statustext.store";
import { selectAlerts, dwellMs, SEV_ERROR } from "@/lib/alerts";

// Transient alerts, top centre, over everything.
//
// Moving the status log behind the dock opened a safety hole: PX4 announces a
// failsafe, a geofence breach or a refused mode change through STATUSTEXT, and a
// message that only lands in a closed panel is one the operator learns about
// from the aircraft's behaviour instead. The log is still the record. This is
// what interrupts.
//
// Warnings and worse only, and errors do not auto-dismiss — see lib/alerts.ts
// for why the line sits there. The policy is tested; this just draws it.

export default function Alerts() {
	const entries = useStore($statusTexts);
	const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
	const alerts = selectAlerts(entries, dismissed);

	// Non-sticky alerts time out. One timer per alert, keyed by id, so a new
	// arrival never resets an older one's clock.
	useEffect(() => {
		const timers = alerts
			.filter((a) => !a.sticky)
			.map((a) => setTimeout(
				() => setDismissed((d) => new Set(d).add(a.id)),
				dwellMs(a.severity) ?? 12_000,
			));
		return () => timers.forEach(clearTimeout);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [alerts.map((a) => a.id).join(",")]);

	if (alerts.length === 0) return null;

	return (
		<div className="pointer-events-none fixed left-1/2 top-4 z-[60] flex
			w-[min(32rem,calc(100vw-6rem))] -translate-x-1/2 flex-col gap-1">
			{alerts.map((a) => {
				const bad = a.severity <= SEV_ERROR;
				return (
					<div
						key={a.id}
						role="alert"
						className={`pointer-events-auto flex items-start gap-2 rounded border px-2.5 py-1.5
							text-[11px] backdrop-blur ${bad
								? "border-red-500/50 bg-red-950/70 text-red-100"
								: "border-amber-400/40 bg-amber-950/60 text-amber-100"}`}
					>
						<AlertTriangle className={`mt-px h-3.5 w-3.5 shrink-0 ${bad ? "text-red-400" : "text-amber-400"}`} />
						<span className="flex-1 leading-snug">{a.text}</span>
						<button
							onClick={() => setDismissed((d) => new Set(d).add(a.id))}
							className="shrink-0 text-white/40 hover:text-white"
							aria-label="Dismiss"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
