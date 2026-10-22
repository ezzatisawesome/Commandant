"use client";

import { useEffect, useRef, useState } from "react";
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
	// How many older alerting entries were retired without ever being shown.
	// Reported as a count, never replayed as toasts — see lib/alerts.ts.
	const [suppressed, setSuppressed] = useState(0);
	const { visible: alerts, overflow } = selectAlerts(entries, dismissed);

	// An entry that is already behind the visible window is never promoted to a
	// toast later. It is retired here, on sight, and counted.
	//
	// Without this, a burst was shown three at a time and every dwell timeout
	// pushed the next three OLDER entries on screen as fresh alerts, walking the
	// operator backwards through the flight; errors are sticky, so a cascade of
	// them queued behind one another with no end at all.
	const overflowKey = overflow.map((a) => a.id).join(",");
	useEffect(() => {
		if (overflow.length === 0) return;
		const ids = overflow.map((a) => a.id);
		setDismissed((d) => {
			const next = new Set(d);
			for (const id of ids) next.add(id);
			return next;
		});
		setSuppressed((n) => n + ids.length);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [overflowKey]);

	// Non-sticky alerts time out. ONE timer per alert, armed the first time that
	// alert becomes visible and never re-armed — which is what the old comment
	// here claimed and the old code did the opposite of: its cleanup cleared
	// every timer on each change of the visible set, so any new arrival handed
	// every alert already on screen a fresh full dwell. Under a steady trickle of
	// warnings a toast from the start of the flight stayed up for the whole
	// flight. The clock belongs to the alert, so it lives in a ref keyed by id
	// rather than in the effect's cleanup.
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
	const visibleKey = alerts.map((a) => a.id).join(",");
	useEffect(() => {
		for (const a of alerts) {
			if (a.sticky || timers.current.has(a.id)) continue;
			timers.current.set(a.id, setTimeout(() => {
				timers.current.delete(a.id);
				setDismissed((d) => new Set(d).add(a.id));
			}, dwellMs(a.severity) ?? 12_000));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visibleKey]);

	// Only on unmount: anything earlier would restart the clocks above.
	useEffect(() => () => {
		for (const t of timers.current.values()) clearTimeout(t);
		timers.current.clear();
	}, []);

	// The count is a pointer at the status log, not a running total for the
	// session: once nothing is being interrupted with, there is nothing for it to
	// qualify.
	useEffect(() => {
		if (alerts.length === 0 && suppressed !== 0) setSuppressed(0);
	}, [alerts.length, suppressed]);

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
			{suppressed > 0 ? (
				<div className="pointer-events-none self-center rounded bg-black/60 px-2 py-0.5
					text-[10px] text-white/60 backdrop-blur">
					+{suppressed} earlier {suppressed === 1 ? "alert" : "alerts"} — see the status log
				</div>
			) : null}
		</div>
	);
}
