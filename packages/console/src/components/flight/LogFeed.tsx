"use client";

import { useStore } from "@nanostores/react";

import { $statusTexts } from "@/stores/statustext.store";

// The live autopilot feed, top-left under the wordmark: the last few STATUSTEXT
// lines in green mono, like a console tailing a log.
//
// Why here and not in the dock: the dock's Status panel was a click away from
// something the screen can simply show, and a scroll icon in the gutter is a
// worse answer than legible text in the corner. So this is the whole log
// surface now — deeper and larger than the old eight-line hint, but still
// pointer-events-none and still bounded, so it cannot grow into a panel or take
// a click away from the globe.
//
// Severity still wins over the green. An EKF failure or a failsafe reason
// rendered in the same calm green as "mission accepted" would hide exactly the
// line the operator needs, so warnings stay amber and errors stay red; green is
// the resting colour for notice/info traffic.

// The tail is now the only log surface on screen — the dock's Status panel is
// gone, and with it the one place that showed more than a handful of lines. So
// it runs deeper and reads larger: 12px mono instead of 10, semibold, and
// sixteen lines rather than eight. Still bounded, still pointer-events-none,
// so it cannot grow into a panel.
const TAIL = 16;

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
			className="pointer-events-none fixed left-4 top-12 z-40 max-w-[min(34rem,48vw)]
				font-mono text-[12px] font-semibold leading-relaxed tracking-tight"
		>
			{shown.map((e, i) => (
				<div
					key={e.id}
					// Oldest lines fade, so the newest line is the one the eye lands on.
					// A deeper tail needs a shallower fade, or the oldest of sixteen
					// lines is unreadable rather than merely quieter.
					style={{ opacity: 0.55 + (0.45 * (i + 1)) / shown.length }}
					className="flex gap-1.5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
				>
					<span className="shrink-0 text-emerald-400/60">{hhmmss(e.t)}</span>
					<span className={`${sevClass(e.severity)} break-words`}>{e.text}</span>
				</div>
			))}
		</div>
	);
}

export default LogFeed;
