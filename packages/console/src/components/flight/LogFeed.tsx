"use client";

import { useStore } from "@nanostores/react";

import { $statusTexts } from "@/stores/statustext.store";

// The live autopilot feed, top-left under the wordmark: the last few STATUSTEXT
// lines in green mono, like a console tailing a log.
//
// Why here and not only in the dock: the dock's Status panel is the RECORD —
// scrollable, clearable, 100 lines deep, and behind a click. This is the TAIL,
// and the tail is what tells you the vehicle just did something. It is
// pointer-events-none and shows a handful of lines, so it cannot grow into a
// panel or take a click away from the globe.
//
// Severity still wins over the green. An EKF failure or a failsafe reason
// rendered in the same calm green as "mission accepted" would hide exactly the
// line the operator needs, so warnings stay amber and errors stay red; green is
// the resting colour for notice/info traffic.

const TAIL = 8;

function sevClass(sev: number): string {
	if (sev <= 3) return "text-red-400";
	if (sev === 4) return "text-amber-300";
	return "text-emerald-400";
}

const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

export function LogFeed() {
	const entries = useStore($statusTexts);
	const shown = entries.slice(-TAIL);
	if (shown.length === 0) return null;

	return (
		<div
			aria-live="polite"
			className="pointer-events-none fixed left-4 top-12 z-40 max-w-[min(28rem,45vw)]
				font-mono text-[10px] leading-relaxed"
		>
			{shown.map((e, i) => (
				<div
					key={e.id}
					// Oldest lines fade, so the newest line is the one the eye lands on.
					style={{ opacity: 0.35 + (0.65 * (i + 1)) / shown.length }}
					className="flex gap-1.5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
				>
					<span className="shrink-0 text-emerald-400/40">{hhmmss(e.t)}</span>
					<span className={`${sevClass(e.severity)} break-words`}>{e.text}</span>
				</div>
			))}
		</div>
	);
}

export default LogFeed;
